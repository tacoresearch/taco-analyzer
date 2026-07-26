/**
 * Photo upload validation and metadata stripping.
 *
 * Every accepted image is parsed by hand here. There is no image library in this
 * project on purpose (see docs/security-decisions.md, "Photo uploads"), because
 * the deployment target must install with zero native dependencies. That makes
 * this file the whole of our upload defence, so it is written defensively
 * throughout: every offset read is bounds-checked, every declared length is
 * validated against the bytes actually present, and every loop has a hard
 * iteration ceiling. A malformed file must produce a PhotoError, never a crash,
 * an infinite loop, or an out-of-bounds read.
 *
 * What this file does:
 *
 *  1. Identifies the format from magic bytes only. `Content-Type` and the
 *     filename extension are attacker-controlled and are never consulted.
 *  2. Rejects HEIC/HEIF and AVIF specifically, with a message that tells the user
 *     how to make their phone send JPEG instead.
 *  3. Removes every metadata container: Exif (GPS precise to the building, camera
 *     serial numbers, and an embedded thumbnail that survives cropping), XMP,
 *     ICC, IPTC, comments, and text chunks. The Exif Orientation tag is read out
 *     first and returned, so the UI can rotate the photo with CSS rather than
 *     showing it sideways.
 *  4. Rejects decompression bombs from the header alone, without decoding.
 *  5. Stores under a random UUID: written 0600 to a temp file, fsynced, then
 *     renamed into place, so a partial file is never visible to the serving route.
 *
 * Known and accepted limit: metadata is stripped, not re-encoded, so a crafted
 * image that exploits a browser decoder would pass through. That deviation from
 * OWASP's advice is recorded in docs/security-decisions.md along with what
 * compensates for it (strict magic-byte identification, `default-src 'none'`,
 * `nosniff`, a non-executable serving path, and a server-set content type).
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ *
 * Public constants
 * ------------------------------------------------------------------ */

/** For the `accept` attribute on the file input, and nothing else. */
export const ACCEPTED_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

/** Display/advisory only. Extensions are never used to decide what a file is. */
export const ACCEPTED_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * Decompression-bomb ceilings, checked from the header without decoding.
 * 50 MP is comfortably above any phone camera (a 2026 flagship is around 12 to
 * 50 MP) while a bomb is typically hundreds of megapixels in a few kilobytes.
 */
export const MAX_PIXELS = 50_000_000;
export const MAX_DIMENSION = 20_000;

/** Matches config.maxUploadBytes; passed in explicitly by callers. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Longest display label we keep for a client-supplied filename. */
const MAX_DISPLAY_NAME_LENGTH = 120;

/**
 * Hard iteration ceilings. A structurally valid image is nowhere near these; a
 * hostile file that tries to make us loop forever hits them and is rejected.
 */
const MAX_JPEG_SEGMENTS = 4096;
const MAX_PNG_CHUNKS = 8192;
const MAX_RIFF_CHUNKS = 4096;

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * An upload rejection. `.message` is safe to render to the user as-is; `.detail`
 * is the internal reason and belongs in a log, not a response.
 */
export class PhotoError extends Error {
  /**
   * @param {string} code
   * @param {string} message user-safe text
   * @param {{detail?: string, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'PhotoError';
    this.code = code;
    this.detail = options.detail ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * User-facing text, kept together so the wording can be reviewed in one place.
 * Every message says what happened and what to do next; "invalid file" tells a
 * collector standing in a taco shop nothing useful.
 */
const MESSAGES = Object.freeze({
  EMPTY: 'No photo was received, or the file was empty. Choose a photo and try again.',
  UNSUPPORTED_FORMAT:
    'That file does not look like a JPEG, PNG, or WebP image, which are the ' +
    'three formats this app accepts. If a document or a video was picked by ' +
    'mistake, choose the photo again.',
  HEIC_UNSUPPORTED:
    'That photo is in the HEIC/HEIF format, which this app cannot accept. Your ' +
    'camera app can save JPEG instead: on Android look for a "HEIF" or "High ' +
    'efficiency" toggle in the camera app\'s settings and turn it off, and on an ' +
    'iPhone open Settings, then Camera, then Formats, and choose "Most ' +
    'Compatible". Then retake the photo and upload it again.',
  MALFORMED:
    'That image file appears to be damaged or incomplete, so it could not be ' +
    'processed. Try uploading it again, or retake the photo.',
  INTERNAL: 'The photo could not be saved. Try again, and tell an admin if it keeps failing.',
});

/**
 * @param {string} detail internal reason, for logs
 * @returns {PhotoError}
 */
function malformed(detail) {
  return new PhotoError('MALFORMED', MESSAGES.MALFORMED, { detail });
}

/* ------------------------------------------------------------------ *
 * Small byte helpers
 * ------------------------------------------------------------------ */

/**
 * Coerce an input to a Buffer without copying where possible.
 * Returns null for anything that is not byte-like, so callers turn that into a
 * clean rejection rather than a TypeError deep inside a parser.
 * @param {unknown} input
 * @returns {Buffer|null}
 */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return null;
}

/**
 * Whether `buffer` contains exactly `bytes` at `offset`, bounds-checked.
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {number[]} bytes
 */
function bytesAt(buffer, offset, bytes) {
  if (offset < 0 || offset + bytes.length > buffer.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Whether `buffer` starts with an ASCII/latin1 string, bounds-checked.
 * @param {Buffer} buffer
 * @param {string} text
 */
function startsWithAscii(buffer, text) {
  if (buffer.length < text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (buffer[i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Read a fixed-width ASCII tag, or null if it is not printable ASCII.
 * Used for PNG chunk types and RIFF FourCCs, where a non-ASCII tag means the
 * file is not what it claims and we should stop rather than guess.
 * @param {Buffer} buffer
 * @param {number} offset
 * @param {number} length
 * @returns {string|null}
 */
function asciiTag(buffer, offset, length) {
  if (offset < 0 || offset + length > buffer.length) return null;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = buffer[offset + i];
    if (byte < 0x20 || byte > 0x7e) return null;
    out += String.fromCharCode(byte);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * CRC32 (PNG flavour: reflected, polynomial 0xEDB88320)
 * ------------------------------------------------------------------ */

/**
 * Table built once at module load. Hand-rolled because adding a dependency for
 * 20 lines of arithmetic would defeat the zero-dependency constraint.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC32 of `buffer[start, end)`.
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {number} unsigned 32-bit
 */
function crc32(buffer, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ *
 * Format identification
 * ------------------------------------------------------------------ */

const FORMATS = Object.freeze({
  jpeg: { format: 'jpeg', mimeType: 'image/jpeg', extension: '.jpg' },
  png: { format: 'png', mimeType: 'image/png', extension: '.png' },
  webp: { format: 'webp', mimeType: 'image/webp', extension: '.webp' },
});

/** PNG's 8-byte signature. All eight bytes are checked, not just "PNG". */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * ISOBMFF brands we reject with a specific message rather than a generic one.
 * The task list plus a few near neighbours that would otherwise fall through to
 * "unsupported file" and confuse the user in exactly the same way.
 */
const HEIF_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis',
]);

/**
 * Sniff a format from the leading bytes of a file.
 *
 * Magic bytes only. This is the single place that decides what a file is, and it
 * never looks at a filename or a declared content type, both of which the client
 * chooses freely.
 *
 * @param {unknown} input
 * @returns {{format: 'jpeg'|'png'|'webp', mimeType: string, extension: string}|null}
 */
export function identifyImage(input) {
  const buffer = toBuffer(input);
  if (!buffer || buffer.length < 2) return null;

  // JPEG: only FF D8 is guaranteed. FF D8 FF E0 (JFIF) and FF D8 FF E1 (Exif)
  // are the common cases but a valid JPEG may start with any marker after SOI,
  // so matching four bytes here would reject real photos. The segment structure
  // is validated later, which is what actually confirms the format.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return FORMATS.jpeg;

  if (bytesAt(buffer, 0, PNG_SIGNATURE)) return FORMATS.png;

  // WebP: "RIFF" alone also matches AVI and WAV, so the "WEBP" FourCC at offset
  // 8 is mandatory. Bytes 4 to 7 in between are a little-endian uint32 size.
  if (buffer.length >= 12 && startsWithAscii(buffer, 'RIFF') && asciiTag(buffer, 8, 4) === 'WEBP') {
    return FORMATS.webp;
  }

  return null;
}

/**
 * Whether this looks like a HEIC/HEIF/AVIF file. ISOBMFF puts a 4-byte box size
 * first, then "ftyp" at offset 4, then the major brand at offset 8.
 * @param {Buffer} buffer
 */
function isHeifLike(buffer) {
  if (buffer.length < 12) return false;
  if (asciiTag(buffer, 4, 4) !== 'ftyp') return false;
  const brand = asciiTag(buffer, 8, 4);
  return brand !== null && HEIF_BRANDS.has(brand.toLowerCase());
}

/**
 * Identify, or throw the right user-facing PhotoError.
 * @param {Buffer} buffer
 * @returns {{format: 'jpeg'|'png'|'webp', mimeType: string, extension: string}}
 */
function identifyOrThrow(buffer) {
  const identified = identifyImage(buffer);
  if (identified) return identified;
  if (isHeifLike(buffer)) {
    throw new PhotoError('HEIC_UNSUPPORTED', MESSAGES.HEIC_UNSUPPORTED, {
      detail: `ISOBMFF brand ${asciiTag(buffer, 8, 4)}`,
    });
  }
  throw new PhotoError('UNSUPPORTED_FORMAT', MESSAGES.UNSUPPORTED_FORMAT, {
    detail: `magic bytes ${buffer.subarray(0, 8).toString('hex')}`,
  });
}

/**
 * Reject decompression bombs from the intrinsic dimensions.
 * @param {number} width
 * @param {number} height
 */
function checkPixelBudget(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw malformed(`nonsensical dimensions ${width}x${height}`);
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    const megapixels = Math.round((width * height) / 100_000) / 10;
    throw new PhotoError(
      'TOO_MANY_PIXELS',
      `That image is ${width} by ${height} pixels (about ${megapixels} megapixels), ` +
        `which is larger than this app can handle. The limits are ` +
        `${MAX_PIXELS / 1_000_000} megapixels and ${MAX_DIMENSION} pixels on a side. ` +
        'A normal phone photo is well inside them.',
      { detail: `dimensions ${width}x${height}` },
    );
  }
}

/**
 * The upload was larger than the configured ceiling.
 * @param {number} byteSize actual bytes received
 * @param {number} maxBytes
 */
function tooLarge(byteSize, maxBytes) {
  const asMb = (n) => Math.round((n / (1024 * 1024)) * 10) / 10;
  return new PhotoError(
    'TOO_LARGE',
    `That photo is ${asMb(byteSize)} MB, and the limit is ${asMb(maxBytes)} MB. ` +
      'Most phone cameras have a setting to take smaller photos, or you can crop ' +
      'or resize this one and upload it again.',
    { detail: `${byteSize} bytes exceeds ${maxBytes}` },
  );
}

/* ------------------------------------------------------------------ *
 * Exif (TIFF) parsing
 *
 * Coordinates are read out here and kept in our own database, then stripped from
 * the bytes we store (docs/security-decisions.md, "Photo uploads"). Extraction
 * has to happen in the same pass as stripping, because stripping is
 * irreversible: a photo saved before the extractor existed could never have its
 * location recovered without physically revisiting the taco.
 *
 * Nothing in this section throws. Metadata is a nice-to-have, so a malformed or
 * truncated Exif block yields nulls and the upload proceeds; the image is
 * stripped either way.
 * ------------------------------------------------------------------ */

/** Entries in one IFD. A real photo has a few dozen. */
const MAX_IFD_ENTRIES = 512;

/** Longest Exif string we keep, matching the database columns. */
const MAX_EXIF_STRING = 100;

/** Plausible altitude range, in metres. Below the Dead Sea or above Everest is a parse error, not a photo. */
const MIN_ALTITUDE_METRES = -500;
const MAX_ALTITUDE_METRES = 10_000;

/** Byte width of each TIFF field type, indexed by the type code. */
const TIFF_TYPE_SIZES = Object.freeze({
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL (two LONGs)
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
});

/** IFD0 and Exif sub-IFD tags we care about. */
const TAG = Object.freeze({
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
  dateTimeOriginal: 0x9003,
});

/** GPS sub-IFD tags. */
const GPS_TAG = Object.freeze({
  latitudeRef: 0x0001,
  latitude: 0x0002,
  longitudeRef: 0x0003,
  longitude: 0x0004,
  altitudeRef: 0x0005,
  altitude: 0x0006,
});

/**
 * A fresh "we found nothing" metadata record. Returned by value so a caller can
 * never mutate a shared object, and so the shape is defined in exactly one place.
 */
function emptyMetadata() {
  return {
    gpsLatitude: null,
    gpsLongitude: null,
    gpsAltitudeMetres: null,
    capturedAt: null,
    capturedAtRaw: null,
    cameraMake: null,
    cameraModel: null,
    hadGps: false,
  };
}

/**
 * Bind a byte-order-aware reader to the TIFF block at `[start, end)`.
 *
 * A TIFF header is 8 bytes: the byte order ("II" little-endian or "MM"
 * big-endian), the magic number 42 in that order, then the offset of IFD0.
 * Both orders occur in the wild: most cameras write "II", but Canon CR-derived
 * JPEGs and plenty of Android encoders write "MM".
 *
 * @param {Buffer} buffer
 * @param {number} start first byte of the TIFF header
 * @param {number} end one past the last byte available to this block
 * @returns {{start: number, end: number, little: boolean, buffer: Buffer, ifd0: number,
 *            u8: (offset: number) => number|null,
 *            u16: (offset: number) => number|null,
 *            u32: (offset: number) => number|null}|null}
 */
function createTiffReader(buffer, start, end) {
  const limit = Math.min(end, buffer.length);
  if (start < 0 || start + 8 > limit) return null;

  const order = asciiTag(buffer, start, 2);
  let little;
  if (order === 'II') little = true;
  else if (order === 'MM') little = false;
  else return null;

  const reader = {
    buffer,
    start,
    end: limit,
    little,
    ifd0: 0,
    u8(offset) {
      return offset < start || offset + 1 > limit ? null : buffer[offset];
    },
    u16(offset) {
      if (offset < start || offset + 2 > limit) return null;
      return little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    },
    u32(offset) {
      if (offset < start || offset + 4 > limit) return null;
      return little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    },
  };

  if (reader.u16(start + 2) !== 42) return null;
  const ifd0 = reader.u32(start + 4);
  if (ifd0 === null) return null;
  reader.ifd0 = ifd0;
  return reader;
}

/**
 * Read one IFD into a tag-keyed map of entry descriptors.
 *
 * The offset arithmetic is the part worth stating explicitly, because getting it
 * wrong is the classic Exif bug: every offset stored inside a TIFF block is
 * measured from the start of the TIFF header, NOT from the start of the file and
 * not from the start of the JPEG APP1 segment. So `reader.start` is added here,
 * in one place, and nowhere else.
 *
 * An entry is 12 bytes: tag (2), type (2), value count (4), then either the
 * value itself if it fits in 4 bytes or an offset to it if it does not.
 *
 * @param {ReturnType<typeof createTiffReader>} reader
 * @param {number} relativeOffset offset of the IFD, relative to the TIFF header
 * @returns {Map<number, {type: number, count: number, offset: number, byteLength: number}>|null}
 */
function readIfd(reader, relativeOffset) {
  if (!reader) return null;
  // 8 is the size of the TIFF header, so nothing legitimate can start earlier.
  if (!Number.isInteger(relativeOffset) || relativeOffset < 8) return null;

  const base = reader.start + relativeOffset;
  const count = reader.u16(base);
  if (count === null || count === 0 || count > MAX_IFD_ENTRIES) return null;
  if (base + 2 + count * 12 > reader.end) return null;

  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    const at = base + 2 + i * 12;
    const tag = reader.u16(at);
    const type = reader.u16(at + 2);
    const valueCount = reader.u32(at + 4);
    if (tag === null || type === null || valueCount === null) break;

    const unit = TIFF_TYPE_SIZES[type];
    // An unknown type or an absurd count is skipped rather than fatal: the rest
    // of the IFD is usually still readable, and this is best-effort data.
    if (!unit || valueCount === 0 || valueCount > 0x00ff_ffff) continue;

    const byteLength = unit * valueCount;
    let dataOffset;
    if (byteLength <= 4) {
      dataOffset = at + 8; // inline in the entry itself
    } else {
      const pointer = reader.u32(at + 8);
      if (pointer === null) continue;
      dataOffset = reader.start + pointer;
    }
    // Truncated or out-of-block values are dropped, never read.
    if (dataOffset < reader.start || dataOffset + byteLength > reader.end) continue;

    entries.set(tag, { type, count: valueCount, offset: dataOffset, byteLength });
  }
  return entries;
}

/**
 * First value of an integer-typed entry.
 * @param {ReturnType<typeof createTiffReader>} reader
 * @param {{type: number, offset: number}|undefined} entry
 * @returns {number|null}
 */
function entryInt(reader, entry) {
  if (!entry) return null;
  switch (entry.type) {
    case 1:
    case 7:
      return reader.u8(entry.offset);
    case 3:
      return reader.u16(entry.offset);
    case 4:
      return reader.u32(entry.offset);
    default:
      return null;
  }
}

/**
 * NUL-terminated ASCII value, trimmed and capped.
 * Non-printable bytes become spaces rather than being passed through, because
 * this string ends up in HTML and in logs.
 * @param {ReturnType<typeof createTiffReader>} reader
 * @param {{type: number, count: number, offset: number}|undefined} entry
 * @param {number} maxLength
 * @returns {string|null}
 */
function entryAscii(reader, entry, maxLength) {
  if (!entry || (entry.type !== 2 && entry.type !== 7)) return null;
  let out = '';
  for (let i = 0; i < entry.count && out.length < maxLength; i += 1) {
    const byte = reader.u8(entry.offset + i);
    if (byte === null || byte === 0) break;
    out += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ' ';
  }
  const trimmed = out.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Exactly `expected` RATIONALs as numbers, or null.
 *
 * A zero denominator turns up both in real files written by buggy encoders and
 * in deliberately hostile ones. It must become null rather than Infinity or NaN,
 * because these values are written to REAL columns and Infinity is not something
 * SQLite or a reviewer can do anything sensible with.
 *
 * @param {ReturnType<typeof createTiffReader>} reader
 * @param {{type: number, count: number, offset: number}|undefined} entry
 * @param {number} expected
 * @returns {number[]|null}
 */
function entryRationals(reader, entry, expected) {
  if (!entry || entry.type !== 5 || entry.count !== expected) return null;
  const values = [];
  for (let i = 0; i < expected; i += 1) {
    const numerator = reader.u32(entry.offset + i * 8);
    const denominator = reader.u32(entry.offset + i * 8 + 4);
    if (numerator === null || denominator === null || denominator === 0) return null;
    const value = numerator / denominator;
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }
  return values;
}

/**
 * Degrees/minutes/seconds plus a hemisphere reference to signed decimal degrees.
 *
 * The reference is required, not optional: without it the sign is unknown, and a
 * coordinate in the wrong hemisphere is worse than no coordinate at all because
 * it looks plausible to a reviewer.
 *
 * @param {number[]|null} parts [degrees, minutes, seconds]
 * @param {string|null} ref hemisphere letter
 * @param {string} negative the letter that means a negative value
 * @param {string} positive the letter that means a positive value
 * @param {number} limit largest legal absolute value
 * @returns {number|null}
 */
function dmsToDegrees(parts, ref, negative, positive, limit) {
  if (!parts || parts.length !== 3) return null;
  const [degrees, minutes, seconds] = parts;
  for (const part of parts) {
    if (!Number.isFinite(part) || part < 0) return null;
  }
  const letter = typeof ref === 'string' ? ref.trim().toUpperCase().charAt(0) : '';
  if (letter !== negative && letter !== positive) return null;

  const magnitude = degrees + minutes / 60 + seconds / 3600;
  // Out of range means the block was misparsed or is hostile. Refuse the value
  // rather than storing a nonsense coordinate.
  if (!Number.isFinite(magnitude) || magnitude > limit) return null;

  const signed = letter === negative ? -magnitude : magnitude;
  // 7 decimal places is about 1 cm at the equator, far finer than any phone GPS.
  return Math.round(signed * 1e7) / 1e7;
}

/**
 * Read the GPS sub-IFD.
 * @param {ReturnType<typeof createTiffReader>} reader
 * @param {Map<number, object>} ifd0
 * @returns {{gpsLatitude: number|null, gpsLongitude: number|null,
 *            gpsAltitudeMetres: number|null, hadGps: boolean}}
 */
function readGpsIfd(reader, ifd0) {
  const none = { gpsLatitude: null, gpsLongitude: null, gpsAltitudeMetres: null, hadGps: false };

  const pointer = entryInt(reader, ifd0.get(TAG.gpsIfd));
  if (pointer === null) return none;

  // A pointer past the end of the block returns null here rather than reading
  // out of bounds, which is the case a truncated upload actually produces.
  const gps = readIfd(reader, pointer);
  if (!gps || gps.size === 0) return none;

  let latitude = dmsToDegrees(
    entryRationals(reader, gps.get(GPS_TAG.latitude), 3),
    entryAscii(reader, gps.get(GPS_TAG.latitudeRef), 2),
    'S',
    'N',
    90,
  );
  let longitude = dmsToDegrees(
    entryRationals(reader, gps.get(GPS_TAG.longitude), 3),
    entryAscii(reader, gps.get(GPS_TAG.longitudeRef), 2),
    'W',
    'E',
    180,
  );
  // Half a pair is not a location. A latitude stored with a null longitude would
  // read as a real point out in the Gulf of Guinea, so both go or neither does.
  if (latitude === null || longitude === null) {
    latitude = null;
    longitude = null;
  }

  let altitude = null;
  const altitudeParts = entryRationals(reader, gps.get(GPS_TAG.altitude), 1);
  if (altitudeParts) {
    // GPSAltitudeRef is a BYTE, where 1 means the altitude is below sea level.
    const belowSeaLevel = entryInt(reader, gps.get(GPS_TAG.altitudeRef)) === 1;
    const metres = Math.round((belowSeaLevel ? -altitudeParts[0] : altitudeParts[0]) * 1000) / 1000;
    if (Number.isFinite(metres) && metres >= MIN_ALTITUDE_METRES && metres <= MAX_ALTITUDE_METRES) {
      altitude = metres;
    }
  }

  return { gpsLatitude: latitude, gpsLongitude: longitude, gpsAltitudeMetres: altitude, hadGps: true };
}

/**
 * Parse Exif's 'YYYY:MM:DD HH:MM:SS'.
 *
 * The raw string is returned alongside the parsed one and no timezone is
 * appended. Exif genuinely does not record an offset, so writing "Z" would claim
 * UTC and silently move every timestamp by up to a day.
 *
 * @param {string|null} raw
 * @returns {{capturedAt: string|null, capturedAtRaw: string|null}}
 */
function parseExifDateTime(raw) {
  if (!raw) return { capturedAt: null, capturedAtRaw: null };
  const kept = raw.slice(0, MAX_EXIF_STRING);
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(kept.trim());
  if (!match) return { capturedAt: null, capturedAtRaw: kept };

  const [, year, month, day, hour, minute, second] = match;
  const inRange =
    Number(year) >= 1900 &&
    Number(month) >= 1 && Number(month) <= 12 &&
    Number(day) >= 1 && Number(day) <= 31 &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59;
  // '0000:00:00 00:00:00' is a common placeholder and lands here. The raw string
  // is still kept, so a reviewer can see what the file actually claimed.
  if (!inRange) return { capturedAt: null, capturedAtRaw: kept };

  return { capturedAt: `${year}-${month}-${day}T${hour}:${minute}:${second}`, capturedAtRaw: kept };
}

/**
 * Extract everything we keep from a TIFF block, plus the Orientation tag.
 * @param {Buffer} buffer
 * @param {number} start first byte of the TIFF header
 * @param {number} end one past the last byte of the block
 * @returns {{metadata: ReturnType<typeof emptyMetadata>, orientation: number|null}}
 */
function extractExifMetadata(buffer, start, end) {
  const metadata = emptyMetadata();
  let orientation = null;

  try {
    const reader = createTiffReader(buffer, start, end);
    if (!reader) return { metadata, orientation };
    const ifd0 = readIfd(reader, reader.ifd0);
    if (!ifd0) return { metadata, orientation };

    const rawOrientation = entryInt(reader, ifd0.get(TAG.orientation));
    if (rawOrientation !== null && rawOrientation >= 1 && rawOrientation <= 8) {
      orientation = rawOrientation;
    }

    metadata.cameraMake = entryAscii(reader, ifd0.get(TAG.make), MAX_EXIF_STRING);
    metadata.cameraModel = entryAscii(reader, ifd0.get(TAG.model), MAX_EXIF_STRING);
    Object.assign(metadata, readGpsIfd(reader, ifd0));

    const exifPointer = entryInt(reader, ifd0.get(TAG.exifIfd));
    if (exifPointer !== null) {
      const exifIfd = readIfd(reader, exifPointer);
      if (exifIfd) {
        const times = parseExifDateTime(
          entryAscii(reader, exifIfd.get(TAG.dateTimeOriginal), MAX_EXIF_STRING),
        );
        metadata.capturedAt = times.capturedAt;
        metadata.capturedAtRaw = times.capturedAtRaw;
      }
    }
  } catch {
    // Belt and braces. Every read above is bounds-checked and returns null out
    // of range, so this should be unreachable; if it is ever reached, losing the
    // metadata is the right outcome and failing the upload is not.
  }

  return { metadata, orientation };
}

/**
 * Whether a byte range begins with the 'Exif\0\0' identifier that a JPEG APP1
 * segment carries. PNG eXIf and WebP EXIF chunks normally hold bare TIFF, but
 * some writers include the prefix anyway, so both are accepted.
 * @param {Buffer} buffer
 * @param {number} offset
 */
function hasExifPrefix(buffer, offset) {
  return bytesAt(buffer, offset, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
}

/**
 * Locate the TIFF header inside a block that may or may not be prefixed.
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {{start: number, end: number}}
 */
function tiffRange(buffer, start, end) {
  return hasExifPrefix(buffer, start) ? { start: start + 6, end } : { start, end };
}

/* ------------------------------------------------------------------ *
 * JPEG
 * ------------------------------------------------------------------ */

/**
 * Big-endian uint16, or null if it would read past the end.
 * @param {Buffer} buffer
 * @param {number} offset
 */
function u16be(buffer, offset) {
  return offset < 0 || offset + 2 > buffer.length ? null : buffer.readUInt16BE(offset);
}

/**
 * Whether a marker is a Start Of Frame, which is where the dimensions live.
 * C0 to CF is the SOF range with three holes in it: C4 is DHT, C8 is the
 * reserved JPG marker, and CC is DAC.
 * @param {number} marker
 */
function isSofMarker(marker) {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Markers kept verbatim, beyond the SOFn range handled above.
 * DHT and DAC are the entropy-coding tables, DQT the quantisation tables, DRI
 * the restart interval, DNL the number of lines, DA the scan, D9 the end.
 * DAC and DNL are not metadata and removing them would break the few files that
 * use them, so they are kept even though they are rare.
 */
const JPEG_KEPT_MARKERS = new Set([0xc4, 0xcc, 0xdb, 0xdc, 0xdd, 0xda, 0xd9]);

/**
 * Find where entropy-coded scan data ends, starting just after an SOS header.
 *
 * This is the part most naive strippers get wrong. Scan data is not
 * length-prefixed, so its end has to be found by scanning, but the compressed
 * data is full of FF bytes that are not markers:
 *
 *   FF 00           a literal FF in the data, byte-stuffed so it cannot be read
 *                   as a marker
 *   FF D0 to FF D7  restart markers, which live INSIDE the scan and must not end it
 *   FF FF           legal fill bytes, which may precede a real marker
 *
 * So "the next FF xx" is very often not a marker at all. Only an FF followed by
 * something outside that set ends the scan. Getting this wrong on a progressive
 * JPEG (several scans) silently truncates the image or corrupts it.
 *
 * @param {Buffer} buffer
 * @param {number} from first byte of scan data
 * @returns {number} offset of the FF that introduces the next real marker, or
 *   the buffer length if the file ends inside the scan
 */
function findScanEnd(buffer, from) {
  let at = from;
  while (at < buffer.length) {
    if (buffer[at] !== 0xff) {
      at += 1;
      continue;
    }
    let next = at + 1;
    while (next < buffer.length && buffer[next] === 0xff) next += 1;
    if (next >= buffer.length) return buffer.length;
    const marker = buffer[next];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      at = next + 1;
      continue;
    }
    // `next - 1` rather than `at` so that any fill bytes stay with the scan and
    // the byte we stop on is always the FF immediately before the marker.
    return next - 1;
  }
  return buffer.length;
}

/**
 * Walk a JPEG's segment structure once, collecting every segment and the
 * dimensions from the first SOF.
 *
 * @param {Buffer} buffer
 * @returns {{segments: Array<{marker: number, kind: string, start: number, end: number,
 *            payloadStart: number, payloadEnd: number}>,
 *            width: number, height: number, sawEoi: boolean}}
 */
function walkJpeg(buffer) {
  if (!bytesAt(buffer, 0, [0xff, 0xd8])) throw malformed('JPEG does not start with SOI');

  const segments = [];
  let width = null;
  let height = null;
  let sawEoi = false;
  let sawSos = false;
  let offset = 2;
  let guard = 0;

  while (offset < buffer.length) {
    guard += 1;
    if (guard > MAX_JPEG_SEGMENTS) throw malformed('more JPEG segments than any real image has');

    // Any number of FF fill bytes may precede a marker, so skip them rather than
    // assuming the marker byte sits at a fixed distance.
    let markerAt = offset;
    while (markerAt < buffer.length && buffer[markerAt] === 0xff) markerAt += 1;
    if (markerAt === offset) throw malformed(`expected a JPEG marker at offset ${offset}`);
    if (markerAt >= buffer.length) throw malformed('file ends in the middle of a JPEG marker');

    const marker = buffer[markerAt];
    if (marker === 0x00) throw malformed('stuffed byte where a JPEG marker was expected');

    const start = markerAt - 1; // the FF that introduces this marker

    if (marker === 0xd9) {
      segments.push({ marker, kind: 'eoi', start, end: markerAt + 1, payloadStart: 0, payloadEnd: 0 });
      sawEoi = true;
      // Anything after EOI is trailing junk (some editors append a whole second
      // image or a thumbnail there). It is dropped by stopping here.
      break;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, kind: 'standalone', start, end: markerAt + 1, payloadStart: 0, payloadEnd: 0 });
      offset = markerAt + 1;
      continue;
    }

    const length = u16be(buffer, markerAt + 1);
    if (length === null) throw malformed('file ends where a JPEG segment length should be');
    // The length field counts itself, so anything under 2 is nonsense and would
    // let the walk stand still or go backwards.
    if (length < 2) throw malformed(`JPEG segment length ${length} is too small`);

    const payloadStart = markerAt + 3;
    const payloadEnd = markerAt + 1 + length;
    if (payloadEnd > buffer.length) throw malformed('JPEG segment length runs past the end of the file');

    if (isSofMarker(marker) && width === null) {
      // Payload: precision (1), height (2), width (2), component count (1).
      if (payloadEnd - payloadStart < 6) throw malformed('SOF segment is too short to hold dimensions');
      height = buffer.readUInt16BE(payloadStart + 1);
      width = buffer.readUInt16BE(payloadStart + 3);
    }

    if (marker === 0xda) {
      sawSos = true;
      const scanEnd = findScanEnd(buffer, payloadEnd);
      segments.push({ marker, kind: 'sos', start, end: scanEnd, payloadStart, payloadEnd });
      offset = scanEnd;
      continue;
    }

    segments.push({ marker, kind: 'segment', start, end: payloadEnd, payloadStart, payloadEnd });
    offset = payloadEnd;
  }

  if (width === null || height === null) throw malformed('no SOF segment, so the JPEG has no dimensions');
  if (!sawSos) throw malformed('no SOS segment, so the JPEG has no image data');

  return { segments, width, height, sawEoi };
}

/**
 * Bytes of an ASCII identifier followed by `nulCount` NUL terminators.
 * Built numerically rather than written as a string literal, so no source file
 * in this project has to contain a raw NUL byte.
 * @param {string} text
 * @param {number} nulCount
 * @returns {number[]}
 */
function signatureBytes(text, nulCount) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) bytes.push(text.charCodeAt(i));
  for (let i = 0; i < nulCount; i += 1) bytes.push(0);
  return bytes;
}

/**
 * A human-readable label for a segment being removed, for the audit log and the
 * `removedSegments` array. APPn segments are named by what they actually carry
 * where that is recognisable, because "APP1" alone does not tell a reviewer
 * whether a photo had Exif in it.
 * @param {Buffer} buffer
 * @param {{marker: number, payloadStart: number, payloadEnd: number}} segment
 * @returns {string}
 */
function jpegSegmentLabel(buffer, segment) {
  const { marker, payloadStart } = segment;
  if (marker === 0xfe) return 'COM';
  if (marker < 0xe0 || marker > 0xef) return `marker FF${marker.toString(16).toUpperCase()}`;

  const appNumber = marker - 0xe0;
  const known = [
    [0xe1, signatureBytes('Exif', 2), 'Exif'],
    [0xe1, signatureBytes('http://ns.adobe.com/xap/1.0/', 1), 'XMP'],
    [0xe2, signatureBytes('ICC_PROFILE', 1), 'ICC'],
    [0xe2, signatureBytes('FPXR', 1), 'FlashPix'],
    [0xed, signatureBytes('Photoshop 3.0', 1), 'Photoshop'],
    [0xe0, signatureBytes('JFIF', 1), 'JFIF'],
    [0xe0, signatureBytes('JFXX', 1), 'JFXX'],
  ];
  for (const [appMarker, signature, name] of known) {
    if (marker !== appMarker) continue;
    if (bytesAt(buffer, payloadStart, signature)) return `APP${appNumber}/${name}`;
  }
  return `APP${appNumber}`;
}

/**
 * Whether an APP0 segment is a genuine JFIF or JFXX header. APP0 is kept only in
 * that case: a segment that merely claims marker FFE0 while carrying something
 * else has no business in the file we store.
 * @param {Buffer} buffer
 * @param {number} payloadStart
 */
function isJfifApp0(buffer, payloadStart) {
  const jfif = [0x4a, 0x46, 0x49, 0x46, 0x00];
  const jfxx = [0x4a, 0x46, 0x58, 0x58, 0x00];
  return bytesAt(buffer, payloadStart, jfif) || bytesAt(buffer, payloadStart, jfxx);
}

/**
 * Rebuild a JPEG with every metadata segment removed.
 * @param {Buffer} buffer
 * @returns {{buffer: Buffer, width: number, height: number,
 *            removedSegments: string[], exif: {start: number, end: number}|null}}
 */
function stripJpeg(buffer) {
  const { segments, width, height, sawEoi } = walkJpeg(buffer);

  const parts = [Buffer.from([0xff, 0xd8])];
  const removedSegments = [];
  const seenLabels = new Set();
  let exif = null;

  const noteRemoval = (label) => {
    if (seenLabels.has(label)) return;
    seenLabels.add(label);
    removedSegments.push(label);
  };

  for (const segment of segments) {
    const { marker, kind } = segment;

    // SOI and EOI are written explicitly, and stray standalone markers between
    // segments carry nothing worth preserving.
    if (kind === 'eoi' || kind === 'standalone') continue;

    if (kind === 'sos') {
      // start to end covers the SOS header plus the entropy-coded data verbatim,
      // so the scan region of the output is byte-identical to the input.
      parts.push(buffer.subarray(segment.start, segment.end));
      continue;
    }

    if (marker === 0xe1 && hasExifPrefix(buffer, segment.payloadStart)) {
      // Remember where the Exif block was so the caller can read coordinates out
      // of the ORIGINAL buffer, which is never mutated.
      if (exif === null) exif = { start: segment.payloadStart, end: segment.payloadEnd };
      noteRemoval('APP1/Exif');
      continue;
    }

    if (marker === 0xe0 && isJfifApp0(buffer, segment.payloadStart)) {
      parts.push(buffer.subarray(segment.start, segment.payloadEnd));
      continue;
    }

    if (isSofMarker(marker) || JPEG_KEPT_MARKERS.has(marker)) {
      parts.push(buffer.subarray(segment.start, segment.payloadEnd));
      continue;
    }

    noteRemoval(jpegSegmentLabel(buffer, segment));
  }

  // EOI is always written. If the source was missing it (a truncated download,
  // which browsers tolerate) the stored file is at least well formed, and the
  // scan data itself is unchanged either way.
  parts.push(Buffer.from([0xff, 0xd9]));
  if (!sawEoi) noteRemoval('trailing data with no EOI');

  return { buffer: Buffer.concat(parts), width, height, removedSegments, exif };
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

/**
 * Chunks kept, by type. Everything not named here is dropped, so a chunk type
 * nobody has heard of does not travel with the file by default.
 *
 * IHDR, PLTE, IDAT and IEND are the image. tRNS, gAMA, cHRM, sRGB, bKGD and
 * pHYs affect how it renders. acTL, fcTL and fdAT are APNG animation, without
 * which an animated PNG would silently become a still.
 */
const PNG_KEPT_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'bKGD', 'pHYs',
  'acTL', 'fcTL', 'fdAT',
]);

/**
 * Dimensions from IHDR, which the spec requires to be the first chunk.
 * @param {Buffer} buffer
 * @returns {{width: number, height: number}}
 */
function readPngDimensions(buffer) {
  if (!bytesAt(buffer, 0, PNG_SIGNATURE)) throw malformed('PNG signature is wrong');
  // 8 signature + 4 length + 4 type + 13 data + 4 CRC.
  if (buffer.length < 33) throw malformed('file ends before the end of IHDR');
  if (buffer.readUInt32BE(8) !== 13 || asciiTag(buffer, 12, 4) !== 'IHDR') {
    throw malformed('first PNG chunk is not a 13-byte IHDR');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Rebuild a PNG with every metadata chunk removed.
 * @param {Buffer} buffer
 * @returns {{buffer: Buffer, width: number, height: number,
 *            removedSegments: string[], exif: {start: number, end: number}|null}}
 */
function stripPng(buffer) {
  const { width, height } = readPngDimensions(buffer);

  const parts = [buffer.subarray(0, 8)];
  const removedSegments = [];
  const seenLabels = new Set();
  let exif = null;
  let sawIend = false;
  let offset = 8;
  let guard = 0;

  while (offset < buffer.length) {
    guard += 1;
    if (guard > MAX_PNG_CHUNKS) throw malformed('more PNG chunks than any real image has');

    if (offset + 8 > buffer.length) throw malformed('file ends inside a PNG chunk header');
    const length = buffer.readUInt32BE(offset);
    // The PNG spec caps a chunk at 2^31-1 bytes. A larger value is a lie, and
    // treating it as real would produce an out-of-range subarray.
    if (length > 0x7fff_ffff) throw malformed('PNG chunk length exceeds the spec maximum');

    const type = asciiTag(buffer, offset + 4, 4);
    if (type === null) throw malformed('PNG chunk type is not printable ASCII');

    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    // The 4 CRC bytes must be present too, not just the data.
    if (dataEnd + 4 > buffer.length) {
      throw malformed(`PNG chunk ${type} declares ${length} bytes that are not in the file`);
    }

    if (PNG_KEPT_CHUNKS.has(type)) {
      // The CRC covers the type and the data, but not the length field.
      const expected = buffer.readUInt32BE(dataEnd);
      const actual = crc32(buffer, offset + 4, dataEnd);
      // Only chunks we keep are verified. A bad CRC on a chunk we are deleting
      // anyway is not worth failing an upload over, but a bad CRC on IHDR or
      // IDAT means the image data itself arrived damaged.
      if (actual !== expected) throw malformed(`PNG chunk ${type} fails its CRC32 check`);
      parts.push(buffer.subarray(offset, dataEnd + 4));
      if (type === 'IEND') {
        sawIend = true;
        // Anything after IEND is not part of the image and is dropped.
        break;
      }
    } else {
      if (type === 'eXIf' && exif === null) exif = { start: dataStart, end: dataEnd };
      if (!seenLabels.has(type)) {
        seenLabels.add(type);
        removedSegments.push(type);
      }
    }

    offset = dataEnd + 4;
  }

  if (!sawIend) throw malformed('PNG has no IEND chunk, so it is incomplete');

  return { buffer: Buffer.concat(parts), width, height, removedSegments, exif };
}

/* ------------------------------------------------------------------ *
 * WebP (RIFF)
 * ------------------------------------------------------------------ */

/**
 * Chunks kept, by FourCC. VP8 is lossy image data, VP8L lossless, VP8X the
 * extended-format header, ALPH an alpha channel, ANIM/ANMF animation. EXIF,
 * XMP and ICCP are dropped, along with anything unrecognised.
 */
const WEBP_KEPT_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ANIM', 'ANMF', 'ALPH']);

/**
 * VP8X feature flag bits, in the single flags byte at the start of the chunk.
 * Order in the spec's bit diagram is Rsv Rsv, ICC, Alpha, Exif, XMP, Anim, Rsv,
 * which puts ICC at 0x20 and Exif at 0x08.
 */
const VP8X_FLAG_ICC = 0x20;
const VP8X_FLAG_EXIF = 0x08;
const VP8X_FLAG_XMP = 0x04;

/**
 * Parse the RIFF container into chunk descriptors.
 * @param {Buffer} buffer
 * @returns {Array<{fourcc: string, start: number, dataStart: number, dataEnd: number, size: number}>}
 */
function readRiffChunks(buffer) {
  if (!startsWithAscii(buffer, 'RIFF') || asciiTag(buffer, 8, 4) !== 'WEBP') {
    throw malformed('not a RIFF container holding WEBP');
  }
  const declared = buffer.readUInt32LE(4);
  // The size field counts everything after itself, so the file is 8 + declared
  // bytes long. The 4 bytes of "WEBP" are inside that count.
  if (declared < 4) throw malformed('RIFF size field is too small to hold the WEBP tag');
  const end = 8 + declared;
  if (end > buffer.length) throw malformed('RIFF size field runs past the end of the file');

  const chunks = [];
  let offset = 12;
  let guard = 0;

  while (offset + 8 <= end) {
    guard += 1;
    if (guard > MAX_RIFF_CHUNKS) throw malformed('more RIFF chunks than any real image has');

    const fourcc = asciiTag(buffer, offset, 4);
    if (fourcc === null) throw malformed('RIFF chunk id is not printable ASCII');
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (size > 0x7fff_ffff || dataEnd > end) {
      throw malformed(`RIFF chunk ${fourcc} declares ${size} bytes that are not in the container`);
    }

    chunks.push({ fourcc, start: offset, dataStart, dataEnd, size });

    // RIFF pads every chunk to an even length. The pad byte is NOT counted in
    // the chunk's own size field but IS present in the stream, so it has to be
    // stepped over here; forgetting it reads every later chunk one byte off and
    // turns a valid file into a parse error.
    offset = dataEnd + (size % 2);
  }

  if (chunks.length === 0) throw malformed('WebP container has no chunks');
  return chunks;
}

/**
 * Canvas dimensions, from VP8X if present and from the bitstream otherwise.
 * @param {Buffer} buffer
 * @param {ReturnType<typeof readRiffChunks>} chunks
 * @returns {{width: number, height: number}}
 */
function readWebpDimensions(buffer, chunks) {
  const find = (fourcc) => chunks.find((chunk) => chunk.fourcc === fourcc);

  const extended = find('VP8X');
  if (extended && extended.size >= 10) {
    // Flags (1), reserved (3), then canvas width minus one and height minus one
    // as 24-bit little-endian values.
    return {
      width: buffer.readUIntLE(extended.dataStart + 4, 3) + 1,
      height: buffer.readUIntLE(extended.dataStart + 7, 3) + 1,
    };
  }

  const lossy = find('VP8 ');
  if (lossy && lossy.size >= 10) {
    // 3-byte frame tag, then the 3-byte start code, then 14-bit width and height.
    if (!bytesAt(buffer, lossy.dataStart + 3, [0x9d, 0x01, 0x2a])) {
      throw malformed('VP8 keyframe start code is missing');
    }
    return {
      width: buffer.readUInt16LE(lossy.dataStart + 6) & 0x3fff,
      height: buffer.readUInt16LE(lossy.dataStart + 8) & 0x3fff,
    };
  }

  const lossless = find('VP8L');
  if (lossless && lossless.size >= 5 && buffer[lossless.dataStart] === 0x2f) {
    // 32 bits little-endian: width minus one in bits 0 to 13, height minus one
    // in bits 14 to 27.
    const packed = buffer.readUInt32LE(lossless.dataStart + 1);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }

  throw malformed('WebP has no chunk that carries dimensions');
}

/**
 * Rebuild a WebP with every metadata chunk removed.
 * @param {Buffer} buffer
 * @returns {{buffer: Buffer, width: number, height: number,
 *            removedSegments: string[], exif: {start: number, end: number}|null}}
 */
function stripWebp(buffer) {
  const chunks = readRiffChunks(buffer);
  const { width, height } = readWebpDimensions(buffer, chunks);

  const parts = [];
  const removedSegments = [];
  const seenLabels = new Set();
  let exif = null;

  for (const chunk of chunks) {
    if (!WEBP_KEPT_CHUNKS.has(chunk.fourcc)) {
      if (chunk.fourcc === 'EXIF' && exif === null) {
        exif = { start: chunk.dataStart, end: chunk.dataEnd };
      }
      if (!seenLabels.has(chunk.fourcc)) {
        seenLabels.add(chunk.fourcc);
        removedSegments.push(chunk.fourcc);
      }
      continue;
    }

    if (chunk.fourcc === 'VP8X' && chunk.size >= 1) {
      // VP8X advertises which optional chunks the file contains. Removing EXIF,
      // XMP or ICCP without clearing the matching bit leaves the file internally
      // inconsistent, and a strict decoder is entitled to reject it. The data is
      // copied first because the input buffer is never mutated.
      const data = Buffer.from(buffer.subarray(chunk.dataStart, chunk.dataEnd));
      data[0] &= ~(VP8X_FLAG_EXIF | VP8X_FLAG_XMP | VP8X_FLAG_ICC) & 0xff;
      parts.push(buffer.subarray(chunk.start, chunk.dataStart), data);
    } else {
      parts.push(buffer.subarray(chunk.start, chunk.dataEnd));
    }

    // The pad byte is regenerated rather than copied, so a file that was missing
    // its final pad byte comes out correct.
    if (chunk.size % 2 === 1) parts.push(Buffer.from([0x00]));
  }

  const payload = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  // The size field must match the new payload, plus the 4 bytes of "WEBP" that
  // follow it. Leaving the original value behind is the classic WebP stripping
  // bug: the file looks fine to some decoders and truncated to others.
  header.writeUInt32LE(4 + payload.length, 4);
  header.write('WEBP', 8, 'latin1');

  return { buffer: Buffer.concat([header, payload]), width, height, removedSegments, exif };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Dimensions from the header only, with nothing decoded.
 * @param {Buffer} buffer
 * @param {'jpeg'|'png'|'webp'} format
 * @returns {{width: number, height: number}}
 */
function readDimensions(buffer, format) {
  if (format === 'jpeg') {
    const { width, height } = walkJpeg(buffer);
    return { width, height };
  }
  if (format === 'png') return readPngDimensions(buffer);
  return readWebpDimensions(buffer, readRiffChunks(buffer));
}

/**
 * Validate an image and report what it is, without modifying or storing it.
 *
 * Returns a result object rather than throwing, so a route can turn a rejection
 * into a re-rendered form with a message beside the field.
 *
 * @param {unknown} buffer
 * @returns {{ok: true, format: 'jpeg'|'png'|'webp', mimeType: string, extension: string,
 *            byteSize: number, width: number, height: number}
 *          | {ok: false, code: string, message: string, detail: string|null}}
 */
export function inspectImage(buffer) {
  try {
    const bytes = toBuffer(buffer);
    if (!bytes || bytes.length === 0) {
      throw new PhotoError('EMPTY', MESSAGES.EMPTY, { detail: 'zero bytes' });
    }
    const identified = identifyOrThrow(bytes);
    const { width, height } = readDimensions(bytes, identified.format);
    checkPixelBudget(width, height);
    return {
      ok: true,
      format: identified.format,
      mimeType: identified.mimeType,
      extension: identified.extension,
      byteSize: bytes.length,
      width,
      height,
    };
  } catch (error) {
    if (error instanceof PhotoError) {
      return { ok: false, code: error.code, message: error.message, detail: error.detail };
    }
    // A non-PhotoError here is a bug in a parser above, not something the user
    // did. It is still reported as a malformed file, because the alternative is
    // an unhandled rejection in a request handler.
    return {
      ok: false,
      code: 'MALFORMED',
      message: MESSAGES.MALFORMED,
      detail: `unexpected parser error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Remove every metadata container from an image, returning the cleaned bytes and
 * the metadata that was read out first.
 *
 * The input buffer is never modified. Metadata is read from the original bytes,
 * which is what makes "extract, then strip" a single pass over one immutable
 * input rather than two passes that could disagree.
 *
 * @param {unknown} buffer
 * @returns {{buffer: Buffer, format: 'jpeg'|'png'|'webp', width: number, height: number,
 *            orientation: number|null, removedBytes: number, removedSegments: string[],
 *            metadata: ReturnType<typeof emptyMetadata>}}
 * @throws {PhotoError}
 */
export function stripImageMetadata(buffer) {
  const bytes = toBuffer(buffer);
  if (!bytes || bytes.length === 0) {
    throw new PhotoError('EMPTY', MESSAGES.EMPTY, { detail: 'zero bytes' });
  }

  const identified = identifyOrThrow(bytes);

  // Cheapest first: refuse a decompression bomb from the header before doing the
  // work of copying the file.
  const dimensions = readDimensions(bytes, identified.format);
  checkPixelBudget(dimensions.width, dimensions.height);

  let stripped;
  if (identified.format === 'jpeg') stripped = stripJpeg(bytes);
  else if (identified.format === 'png') stripped = stripPng(bytes);
  else stripped = stripWebp(bytes);

  let metadata = emptyMetadata();
  let orientation = null;
  if (stripped.exif) {
    const range = tiffRange(bytes, stripped.exif.start, stripped.exif.end);
    const extracted = extractExifMetadata(bytes, range.start, range.end);
    metadata = extracted.metadata;
    orientation = extracted.orientation;
  }

  return {
    buffer: stripped.buffer,
    format: identified.format,
    width: stripped.width,
    height: stripped.height,
    orientation,
    // Clamped because a JPEG that was missing its EOI gains two bytes back, and
    // a negative "removed" count would only ever confuse a reader.
    removedBytes: Math.max(0, bytes.length - stripped.buffer.length),
    removedSegments: stripped.removedSegments,
    metadata,
  };
}

/**
 * Remove characters that have no business in a label rendered to a person:
 * NUL and the rest of the C0 range, DEL and the C1 range, the bidirectional
 * override and isolate characters, and the colon.
 *
 * Done by code point rather than with a regular expression so that the pattern
 * does not have to embed the very characters it is filtering out.
 *
 * @param {string} text
 * @returns {string}
 */
function stripUnsafeCharacters(text) {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f) continue; // NUL through US, including tab and newline
    if (code >= 0x7f && code <= 0x9f) continue; // DEL and the C1 controls
    if (code === 0x200e || code === 0x200f) continue; // LRM, RLM
    if (code >= 0x202a && code <= 0x202e) continue; // embedding and override
    if (code >= 0x2066 && code <= 0x2069) continue; // isolates
    if (code === 0x003a) continue; // colon
    out += character;
  }
  return out;
}

/**
 * A client-supplied filename reduced to a safe display label.
 *
 * This value is shown in the UI and stored in `photos.original_name`. It is
 * never a path component: the on-disk name is a UUID chosen by us. The path
 * separators are stripped anyway, because a label that still looks like a path
 * invites the next person to treat it as one.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function sanitizeDisplayFilename(name) {
  const fallback = 'photo';
  if (typeof name !== 'string' || name === '') return fallback;

  // Keep only the last path component, under either separator, so '../../etc/
  // passwd' and 'C:\Users\bob\p.jpg' both collapse to a bare label.
  let out = name.split(/[/\\]/).pop() ?? '';

  // Control characters, bidi overrides, and a colon, removed by code point so
  // that this source file contains none of them itself. NUL matters most: it can
  // truncate the string in anything downstream that hands it to a C library.
  // Bidi overrides matter because they can make a name render with its extension
  // reversed and mislead whoever is reading the list. A colon would still
  // separate a Windows drive letter or an NTFS alternate data stream.
  out = stripUnsafeCharacters(out);

  out = out.replace(/\s+/g, ' ').trim();
  // Leading dots produce '.', '..', and hidden-file names, none of which are a
  // useful label.
  out = out.replace(/^\.+/, '').trim();

  if (out.length > MAX_DISPLAY_NAME_LENGTH) out = out.slice(0, MAX_DISPLAY_NAME_LENGTH).trim();

  return out === '' ? fallback : out;
}

/**
 * Validate, strip, and store an upload.
 *
 * The order is deliberate and each step is cheaper than the next:
 *
 *  1. Reject an empty body.
 *  2. Enforce the byte ceiling against the bytes actually received. A
 *     `Content-Length` header is a claim, not a measurement.
 *  3. Identify from magic bytes.
 *  4. Reject a decompression bomb from the header, without decoding.
 *  5. Read the metadata we keep, then strip all of it from the bytes.
 *  6. Hash, then write.
 *
 * Every rejection happens before anything touches the disk, so a failed upload
 * leaves nothing behind at all.
 *
 * @param {{bytes: unknown, originalName?: unknown, uploadDir: string, tempDir: string,
 *          maxBytes?: number}} options
 * @returns {Promise<{storageName: string, mimeType: string, byteSize: number, sha256: string,
 *                    width: number, height: number, orientation: number|null,
 *                    originalName: string, metadata: ReturnType<typeof emptyMetadata>}>}
 * @throws {PhotoError}
 */
export async function storePhoto({
  bytes,
  originalName = null,
  uploadDir,
  tempDir,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (typeof uploadDir !== 'string' || typeof tempDir !== 'string') {
    // A caller mistake, not a user mistake, so it is not a PhotoError.
    throw new TypeError('storePhoto requires uploadDir and tempDir paths.');
  }

  const buffer = toBuffer(bytes);
  if (!buffer || buffer.length === 0) {
    throw new PhotoError('EMPTY', MESSAGES.EMPTY, { detail: 'zero bytes received' });
  }

  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  if (buffer.length > limit) throw tooLarge(buffer.length, limit);

  const cleaned = stripImageMetadata(buffer);
  const descriptor = FORMATS[cleaned.format];

  // The hash covers what we actually store, so it can be used to detect a
  // duplicate upload or to verify a file on disk later.
  const sha256 = crypto.createHash('sha256').update(cleaned.buffer).digest('hex');

  const storageName = `${crypto.randomUUID()}${descriptor.extension}`;
  const tempPath = path.join(tempDir, `incoming-${crypto.randomUUID()}.tmp`);
  const finalPath = path.join(uploadDir, storageName);

  let handle = null;
  try {
    // 'wx' fails rather than truncating if the name somehow exists, and 0600
    // means the file is not group- or world-readable even for the moment it
    // spends in the temp directory. (Modes are largely inert on Windows, where
    // the directory ACL is what protects the file.)
    handle = await fsp.open(tempPath, 'wx', 0o600);
    await handle.writeFile(cleaned.buffer);
    // fsync before the rename. The rename itself is atomic with respect to the
    // directory entry, but without the flush a crash can leave a correctly named
    // file with no contents in it, which the serving route would happily find.
    await handle.sync();
    await handle.close();
    handle = null;
    // Same filesystem by construction (both directories live under dataDir), so
    // this is a rename and not a copy.
    await fsp.rename(tempPath, finalPath);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Already closed or never opened; nothing useful to do.
      }
    }
    // Clean up on every failure path. A partial file in the temp directory is
    // disk we never reclaim, and one that reached the upload directory could be
    // served as a truncated image.
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    await fsp.rm(finalPath, { force: true }).catch(() => {});
    throw new PhotoError('INTERNAL', MESSAGES.INTERNAL, {
      detail: `could not write ${storageName}`,
      cause: error,
    });
  }

  return {
    storageName,
    mimeType: descriptor.mimeType,
    byteSize: cleaned.buffer.length,
    sha256,
    width: cleaned.width,
    height: cleaned.height,
    orientation: cleaned.orientation,
    originalName: sanitizeDisplayFilename(originalName),
    metadata: cleaned.metadata,
  };
}

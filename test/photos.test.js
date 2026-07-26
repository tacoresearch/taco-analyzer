/**
 * Tests for server/lib/photos.js.
 *
 * Every image here is built byte by byte in this file. There are deliberately no
 * binary fixtures: a fixture is opaque in review, and the interesting cases (a
 * zero denominator, a GPS pointer past the end of the buffer, scan data that
 * looks like a marker) are exactly the ones a real camera will never hand us.
 *
 * The images are structurally valid containers but are not decodable pictures.
 * That is sufficient, because nothing in photos.js decodes pixels.
 *
 * No NUL or non-ASCII character appears literally in this file. Where one is
 * needed it is built numerically, so the source stays greppable and diffable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PhotoError,
  identifyImage,
  inspectImage,
  sanitizeDisplayFilename,
  storePhoto,
  stripImageMetadata,
} from '../server/lib/photos.js';

/* ------------------------------------------------------------------ *
 * Byte helpers
 * ------------------------------------------------------------------ */

const NUL_BYTE = 0;
const NUL_CHARACTER = String.fromCharCode(NUL_BYTE);

/** @param {number} value */
function u16be(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

/** @param {number} value */
function u32be(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

/** @param {number} value */
function u32le(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

/** 24-bit little-endian, as WebP uses for canvas dimensions. @param {number} value */
function u24le(value) {
  const buffer = Buffer.alloc(3);
  buffer.writeUIntLE(value, 0, 3);
  return buffer;
}

/** @param {string} text */
function ascii(text) {
  return Buffer.from(text, 'latin1');
}

/** NUL-terminated ASCII, as a TIFF ASCII value. @param {string} text */
function asciiZ(text) {
  return Buffer.concat([ascii(text), Buffer.from([NUL_BYTE])]);
}

/** Byte-order-aware writers for building a TIFF block. @param {boolean} little */
function tiffWriters(little) {
  return {
    w16(value) {
      const buffer = Buffer.alloc(2);
      if (little) buffer.writeUInt16LE(value);
      else buffer.writeUInt16BE(value);
      return buffer;
    },
    w32(value) {
      const buffer = Buffer.alloc(4);
      if (little) buffer.writeUInt32LE(value);
      else buffer.writeUInt32BE(value);
      return buffer;
    },
  };
}

/**
 * CRC32 as PNG defines it. A second implementation, independent of the one under
 * test, so a chunk built here and accepted there agrees on the arithmetic.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** @param {Buffer} buffer */
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ *
 * JPEG construction
 * ------------------------------------------------------------------ */

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/** @param {number} marker @param {Buffer} payload */
function jpegSegment(marker, payload) {
  // The length field counts itself, hence + 2.
  return Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);
}

/** Baseline SOF0: precision, height, width, one component. */
function sofSegment(width, height) {
  return jpegSegment(
    0xc0,
    Buffer.concat([
      Buffer.from([0x08]),
      u16be(height),
      u16be(width),
      Buffer.from([0x01, 0x01, 0x11, 0x00]),
    ]),
  );
}

/** Single-component SOS header. */
const SOS_HEADER = jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));

const PLAIN_SCAN = Buffer.from([0x10, 0x20, 0x30, 0x40]);

/**
 * Scan data that a naive walk would misread: a stuffed FF 00, a restart marker
 * FF D0, and a final FF 00 right before the real EOI.
 */
const TRICKY_SCAN = Buffer.from([
  0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33, 0xff, 0x00, 0xff, 0xd7, 0x44, 0xff, 0x00,
]);

/**
 * @param {{width?: number, height?: number, before?: Buffer[], scans?: Buffer[],
 *          eoi?: boolean, trailing?: Buffer|null}} [options]
 */
function buildJpeg(options = {}) {
  const {
    width = 16,
    height = 12,
    before = [],
    scans = [PLAIN_SCAN],
    eoi = true,
    trailing = null,
  } = options;

  const parts = [SOI, ...before, sofSegment(width, height)];
  for (const scan of scans) parts.push(SOS_HEADER, scan);
  if (eoi) parts.push(EOI);
  if (trailing) parts.push(trailing);
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ *
 * Exif construction
 * ------------------------------------------------------------------ */

const EXIF_SIGNATURE = Buffer.from([0x45, 0x78, 0x69, 0x66, NUL_BYTE, NUL_BYTE]);

/** Bytes of one IFD, including its count and its trailing next-IFD pointer. */
const ifdSize = (entryCount) => 2 + entryCount * 12 + 4;

/**
 * @param {Array<[number, number]>} pairs numerator/denominator pairs
 * @param {boolean} little
 */
function rationalBytes(pairs, little) {
  const { w32 } = tiffWriters(little);
  const parts = [];
  for (const [numerator, denominator] of pairs) parts.push(w32(numerator), w32(denominator));
  return Buffer.concat(parts);
}

/**
 * Serialise one IFD. A value of four bytes or fewer sits inline in the entry;
 * anything longer goes on a heap that starts at `heapOffset` and is referenced by
 * an offset relative to the TIFF header.
 *
 * @param {boolean} little
 * @param {Array<{tag: number, type: number, count: number, data: Buffer}>} entries
 * @param {number} heapOffset
 */
function serializeIfd(little, entries, heapOffset) {
  const { w16, w32 } = tiffWriters(little);
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const parts = [w16(sorted.length)];
  const heapParts = [];
  let heapAt = heapOffset;

  for (const entry of sorted) {
    let valueField;
    if (entry.data.length <= 4) {
      valueField = Buffer.alloc(4);
      entry.data.copy(valueField, 0);
    } else {
      valueField = w32(heapAt);
      heapParts.push(entry.data);
      heapAt += entry.data.length;
      // Keep the heap on even offsets, as every real encoder does.
      if (entry.data.length % 2 === 1) {
        heapParts.push(Buffer.from([NUL_BYTE]));
        heapAt += 1;
      }
    }
    parts.push(w16(entry.tag), w16(entry.type), w32(entry.count), valueField);
  }

  parts.push(w32(0)); // no next IFD
  return { bytes: Buffer.concat(parts), heap: Buffer.concat(heapParts), heapEnd: heapAt };
}

/**
 * @param {{latRef?: string, lat?: Array<[number, number]>, lonRef?: string,
 *          lon?: Array<[number, number]>, altRef?: number, alt?: Array<[number, number]>}} gps
 * @param {boolean} little
 */
function gpsEntries(gps, little) {
  const entries = [];
  if (gps.latRef !== undefined) {
    entries.push({ tag: 0x0001, type: 2, count: 2, data: asciiZ(gps.latRef) });
  }
  if (gps.lat !== undefined) {
    entries.push({ tag: 0x0002, type: 5, count: 3, data: rationalBytes(gps.lat, little) });
  }
  if (gps.lonRef !== undefined) {
    entries.push({ tag: 0x0003, type: 2, count: 2, data: asciiZ(gps.lonRef) });
  }
  if (gps.lon !== undefined) {
    entries.push({ tag: 0x0004, type: 5, count: 3, data: rationalBytes(gps.lon, little) });
  }
  if (gps.altRef !== undefined) {
    entries.push({ tag: 0x0005, type: 1, count: 1, data: Buffer.from([gps.altRef]) });
  }
  if (gps.alt !== undefined) {
    entries.push({ tag: 0x0006, type: 5, count: 1, data: rationalBytes(gps.alt, little) });
  }
  return entries;
}

/**
 * Build a TIFF block with IFD0, an optional Exif sub-IFD, and an optional GPS
 * sub-IFD. Offsets are computed rather than hard-coded, so a test can change one
 * tag without rewriting the layout by hand.
 *
 * @param {{little?: boolean, orientation?: number|null, make?: string|null,
 *          model?: string|null, dateTimeOriginal?: string|null,
 *          gps?: object|null, gpsPointer?: number|null}} [options]
 */
function buildTiff(options = {}) {
  const {
    little = true,
    orientation = null,
    make = null,
    model = null,
    dateTimeOriginal = null,
    gps = null,
    gpsPointer = null,
  } = options;

  const { w16, w32 } = tiffWriters(little);

  const wantExifIfd = dateTimeOriginal !== null;
  const wantGpsIfd = gps !== null;
  const wantGpsPointer = wantGpsIfd || gpsPointer !== null;

  const ifd0 = [];
  if (orientation !== null) ifd0.push({ tag: 0x0112, type: 3, count: 1, data: w16(orientation) });
  if (make !== null) ifd0.push({ tag: 0x010f, type: 2, count: make.length + 1, data: asciiZ(make) });
  if (model !== null) {
    ifd0.push({ tag: 0x0110, type: 2, count: model.length + 1, data: asciiZ(model) });
  }

  const exifIfd = [];
  if (wantExifIfd) {
    exifIfd.push({
      tag: 0x9003,
      type: 2,
      count: dateTimeOriginal.length + 1,
      data: asciiZ(dateTimeOriginal),
    });
  }

  const gpsIfd = wantGpsIfd ? gpsEntries(gps, little) : [];

  // Entry counts are known up front, so every offset can be computed before
  // anything is written.
  const ifd0Count = ifd0.length + (wantExifIfd ? 1 : 0) + (wantGpsPointer ? 1 : 0);
  const ifd0Offset = 8;
  const exifIfdOffset = ifd0Offset + ifdSize(ifd0Count);
  const gpsIfdOffset = exifIfdOffset + (wantExifIfd ? ifdSize(exifIfd.length) : 0);
  const heapStart = gpsIfdOffset + (wantGpsIfd ? ifdSize(gpsIfd.length) : 0);

  if (wantExifIfd) ifd0.push({ tag: 0x8769, type: 4, count: 1, data: w32(exifIfdOffset) });
  if (wantGpsPointer) {
    ifd0.push({
      tag: 0x8825,
      type: 4,
      count: 1,
      data: w32(gpsPointer === null ? gpsIfdOffset : gpsPointer),
    });
  }

  const first = serializeIfd(little, ifd0, heapStart);
  const second = wantExifIfd ? serializeIfd(little, exifIfd, first.heapEnd) : null;
  const third = wantGpsIfd
    ? serializeIfd(little, gpsIfd, second ? second.heapEnd : first.heapEnd)
    : null;

  const header = Buffer.concat([ascii(little ? 'II' : 'MM'), w16(42), w32(ifd0Offset)]);
  const blocks = [header, first.bytes];
  if (second) blocks.push(second.bytes);
  if (third) blocks.push(third.bytes);
  blocks.push(first.heap);
  if (second) blocks.push(second.heap);
  if (third) blocks.push(third.heap);
  return Buffer.concat(blocks);
}

/** An APP1 segment carrying an Exif TIFF block. */
function exifApp1(options = {}) {
  return jpegSegment(0xe1, Buffer.concat([EXIF_SIGNATURE, buildTiff(options)]));
}

/** What the module should compute for a DMS triple, using the same rounding. */
function expectedDegrees(degrees, minutes, seconds, sign) {
  const magnitude = degrees + minutes / 60 + seconds / 3600;
  return Math.round(sign * magnitude * 1e7) / 1e7;
}

/* ------------------------------------------------------------------ *
 * PNG construction
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @param {string} type @param {Buffer} data */
function pngChunk(type, data) {
  const typed = Buffer.concat([ascii(type), data]);
  return Buffer.concat([u32be(data.length), typed, u32be(crc32(typed))]);
}

/** The same chunk with a deliberately wrong CRC. */
function pngChunkWithBadCrc(type, data) {
  const typed = Buffer.concat([ascii(type), data]);
  const wrong = (crc32(typed) ^ 0xffffffff) >>> 0;
  return Buffer.concat([u32be(data.length), typed, u32be(wrong)]);
}

function ihdrData(width, height) {
  // width, height, bit depth 8, greyscale, no compression/filter/interlace.
  return Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 0, 0, 0, 0])]);
}

/** @param {{width?: number, height?: number, middle?: Buffer[], idat?: Buffer}} [options] */
function buildPng(options = {}) {
  const { width = 16, height = 12, middle = [], idat = null } = options;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdrData(width, height)),
    ...middle,
    idat ?? pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x01, 0x02, 0x03])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Chunk types in the order they appear, for order assertions. @param {Buffer} buffer */
function pngChunkOrder(buffer) {
  const order = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    order.push(buffer.subarray(offset + 4, offset + 8).toString('latin1'));
    offset += 12 + length;
  }
  return order;
}

/* ------------------------------------------------------------------ *
 * WebP construction
 * ------------------------------------------------------------------ */

/** @param {string} fourcc @param {Buffer} data */
function riffChunk(fourcc, data) {
  const pad = data.length % 2 === 1 ? Buffer.from([NUL_BYTE]) : Buffer.alloc(0);
  return Buffer.concat([ascii(fourcc), u32le(data.length), data, pad]);
}

/** @param {Buffer[]} chunks */
function buildWebp(chunks) {
  const payload = Buffer.concat(chunks);
  // The RIFF size counts the "WEBP" tag plus the payload.
  return Buffer.concat([ascii('RIFF'), u32le(4 + payload.length), ascii('WEBP'), payload]);
}

/** VP8X with the given flags byte and canvas size. */
function vp8xChunk(flags, width, height) {
  return riffChunk(
    'VP8X',
    Buffer.concat([Buffer.from([flags, 0, 0, 0]), u24le(width - 1), u24le(height - 1)]),
  );
}

/** A lossy bitstream chunk with a valid keyframe start code. */
function vp8Chunk(width, height) {
  const tag = Buffer.from([0x00, 0x00, 0x00]);
  const startCode = Buffer.from([0x9d, 0x01, 0x2a]);
  const size = Buffer.alloc(4);
  size.writeUInt16LE(width & 0x3fff, 0);
  size.writeUInt16LE(height & 0x3fff, 2);
  return riffChunk('VP8 ', Buffer.concat([tag, startCode, size]));
}

/** FourCC to payload, for assertions on stripped output. @param {Buffer} buffer */
function riffChunksOf(buffer) {
  const chunks = new Map();
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const fourcc = buffer.subarray(offset, offset + 4).toString('latin1');
    const size = buffer.readUInt32LE(offset + 4);
    chunks.set(fourcc, buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  return chunks;
}

/* ------------------------------------------------------------------ *
 * Other fixtures and assertion helpers
 * ------------------------------------------------------------------ */

/** ISOBMFF header: box size, "ftyp", then the brand. */
function buildHeic(brand = 'heic') {
  return Buffer.concat([u32be(24), ascii('ftyp'), ascii(brand), u32be(0), ascii('mif1')]);
}

/** A RIFF file that is emphatically not a WebP. */
function buildWave() {
  return Buffer.concat([ascii('RIFF'), u32le(36), ascii('WAVE'), ascii('fmt '), u32le(16)]);
}

/**
 * Assert that `run` throws a PhotoError with the given code and a message that
 * says something useful.
 * @param {() => unknown} run
 * @param {string} code
 */
function assertPhotoError(run, code) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof PhotoError, `expected a PhotoError, got ${error}`);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 30, 'a rejection message should tell the user what to do');
    return true;
  });
}

/** A fresh upload and temp directory pair, cleaned up by the caller. */
async function makeDirectories() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'taco-photos-'));
  const uploadDir = path.join(root, 'uploads');
  const tempDir = path.join(root, 'tmp');
  await fs.mkdir(uploadDir);
  await fs.mkdir(tempDir);
  return { root, uploadDir, tempDir };
}

/* ------------------------------------------------------------------ *
 * Identification
 * ------------------------------------------------------------------ */

test('identifies a minimal JPEG, PNG, and WebP', () => {
  assert.equal(identifyImage(buildJpeg())?.mimeType, 'image/jpeg');
  assert.equal(identifyImage(buildPng())?.mimeType, 'image/png');
  assert.equal(identifyImage(buildWebp([vp8Chunk(16, 12)]))?.mimeType, 'image/webp');

  assert.equal(identifyImage(buildJpeg())?.extension, '.jpg');
  assert.equal(identifyImage(buildPng())?.extension, '.png');
  assert.equal(identifyImage(buildWebp([vp8Chunk(16, 12)]))?.extension, '.webp');
});

test('inspectImage reports format and dimensions for each accepted format', () => {
  const jpeg = inspectImage(buildJpeg({ width: 640, height: 480 }));
  assert.equal(jpeg.ok, true);
  assert.deepEqual([jpeg.format, jpeg.width, jpeg.height], ['jpeg', 640, 480]);

  const png = inspectImage(buildPng({ width: 320, height: 200 }));
  assert.equal(png.ok, true);
  assert.deepEqual([png.format, png.width, png.height], ['png', 320, 200]);

  // From the VP8 bitstream, with no VP8X present.
  const lossy = inspectImage(buildWebp([vp8Chunk(300, 150)]));
  assert.equal(lossy.ok, true);
  assert.deepEqual([lossy.format, lossy.width, lossy.height], ['webp', 300, 150]);

  // From VP8X, which takes precedence because it describes the canvas.
  const extended = inspectImage(buildWebp([vp8xChunk(0x00, 700, 500), vp8Chunk(300, 150)]));
  assert.equal(extended.ok, true);
  assert.deepEqual([extended.width, extended.height], [700, 500]);
});

test('does not identify anything by extension or content type', () => {
  // A PNG signature on a file called .jpg is still a PNG. Nothing in the API
  // takes a filename or a content type at all, which is the point.
  assert.equal(identifyImage(buildPng())?.format, 'png');
  assert.equal(identifyImage(Buffer.alloc(0)), null);
  assert.equal(identifyImage('not bytes'), null);
  assert.equal(identifyImage(null), null);
});

/* ------------------------------------------------------------------ *
 * Rejections
 * ------------------------------------------------------------------ */

test('rejects an empty buffer', () => {
  const result = inspectImage(Buffer.alloc(0));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMPTY');
  assertPhotoError(() => stripImageMetadata(Buffer.alloc(0)), 'EMPTY');
});

test('rejects a text file', () => {
  const result = inspectImage(ascii('Notes on the al pastor at the place on Main Street.'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_FORMAT');
});

test('does not accept a RIFF WAVE file as WebP', () => {
  // "RIFF" alone also introduces WAV and AVI, so the WEBP FourCC at offset 8 is
  // what actually decides. A container check that stopped at "RIFF" would take
  // an audio file here.
  assert.equal(identifyImage(buildWave()), null);
  const result = inspectImage(buildWave());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNSUPPORTED_FORMAT');
});

test('rejects HEIC with its own code and a message for both platforms', () => {
  for (const brand of ['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'avif']) {
    const result = inspectImage(buildHeic(brand));
    assert.equal(result.ok, false, `brand ${brand} should be rejected`);
    assert.equal(result.code, 'HEIC_UNSUPPORTED', `brand ${brand} should be recognised as HEIF`);
  }

  const message = inspectImage(buildHeic('heic')).message;
  // The primary user is on Android, so the message must not read as though iOS
  // is the only case.
  assert.match(message, /Android/);
  assert.match(message, /High efficiency|HEIF/);
  assert.match(message, /iPhone/);
});

test('rejects a truncated PNG', () => {
  const truncated = buildPng().subarray(0, 40);
  assertPhotoError(() => stripImageMetadata(truncated), 'MALFORMED');
  assert.equal(inspectImage(truncated.subarray(0, 20)).code, 'MALFORMED');
});

test('rejects a PNG whose chunk CRC is wrong', () => {
  const bad = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdrData(16, 12)),
    pngChunkWithBadCrc('IDAT', Buffer.from([0x78, 0x9c, 0x00])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  assertPhotoError(() => stripImageMetadata(bad), 'MALFORMED');
});

test('rejects oversized dimensions from the header alone', () => {
  // 30000 x 30000 is 900 megapixels in a 70-byte file: a decompression bomb,
  // caught without decoding anything.
  assertPhotoError(() => stripImageMetadata(buildPng({ width: 30_000, height: 30_000 })), 'TOO_MANY_PIXELS');
  assertPhotoError(() => stripImageMetadata(buildJpeg({ width: 20_001, height: 10 })), 'TOO_MANY_PIXELS');

  const result = inspectImage(buildPng({ width: 30_000, height: 30_000 }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOO_MANY_PIXELS');
  assert.match(result.message, /megapixels/);

  // Zero and absurd dimensions are malformed rather than "too many pixels".
  assertPhotoError(() => stripImageMetadata(buildPng({ width: 0, height: 12 })), 'MALFORMED');
});

test('rejects a JPEG with no frame or no scan', () => {
  const headerOnly = Buffer.concat([SOI, sofSegment(16, 12), EOI]);
  assertPhotoError(() => stripImageMetadata(headerOnly), 'MALFORMED');

  const scanOnly = Buffer.concat([SOI, SOS_HEADER, PLAIN_SCAN, EOI]);
  assertPhotoError(() => stripImageMetadata(scanOnly), 'MALFORMED');

  // A segment that claims more bytes than the file holds.
  const lying = Buffer.concat([SOI, Buffer.from([0xff, 0xc0]), u16be(9000), Buffer.alloc(5), EOI]);
  assertPhotoError(() => stripImageMetadata(lying), 'MALFORMED');
});

/* ------------------------------------------------------------------ *
 * JPEG stripping
 * ------------------------------------------------------------------ */

test('a JPEG with nothing to strip comes back byte-identical', () => {
  const jpeg = buildJpeg();
  const result = stripImageMetadata(jpeg);
  assert.deepEqual(result.buffer, jpeg);
  assert.equal(result.removedBytes, 0);
  assert.deepEqual(result.removedSegments, []);
  assert.equal(result.orientation, null);
  assert.equal(result.metadata.hadGps, false);
});

test('removes an APP1 Exif segment and everything in it', () => {
  const needle = ascii('GPSNEEDLE-DO-NOT-KEEP');
  const jpeg = buildJpeg({
    before: [
      exifApp1({
        little: true,
        orientation: 6,
        make: needle.toString('latin1'),
        gps: { latRef: 'N', lat: [[30, 1], [16, 1], [2, 1]], lonRef: 'W', lon: [[97, 1], [44, 1], [21, 1]] },
      }),
    ],
  });

  const result = stripImageMetadata(jpeg);

  assert.ok(result.removedSegments.includes('APP1/Exif'));
  assert.ok(result.removedBytes > 0);
  // Structurally still a JPEG.
  assert.deepEqual(result.buffer.subarray(0, 2), SOI);
  assert.deepEqual(result.buffer.subarray(-2), EOI);
  // The Exif bytes are gone, not merely unreferenced.
  assert.equal(result.buffer.includes(needle), false);
  assert.equal(result.buffer.includes(EXIF_SIGNATURE), false);
  // What is left is exactly the same image with no metadata segment.
  assert.deepEqual(result.buffer, buildJpeg());
  // And the coordinates were captured on the way past.
  assert.equal(result.metadata.gpsLatitude, expectedDegrees(30, 16, 2, 1));
  assert.equal(result.orientation, 6);
});

test('drops every other metadata container and keeps a genuine JFIF APP0', () => {
  const jfif = jpegSegment(
    0xe0,
    Buffer.concat([asciiZ('JFIF'), Buffer.from([0x01, 0x02, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])]),
  );
  const fakeApp0 = jpegSegment(0xe0, ascii('NOT-A-JFIF-HEADER'));
  const xmp = jpegSegment(0xe1, Buffer.concat([asciiZ('http://ns.adobe.com/xap/1.0/'), ascii('<x:xmpmeta/>')]));
  const icc = jpegSegment(0xe2, Buffer.concat([asciiZ('ICC_PROFILE'), ascii('profile bytes')]));
  const iptc = jpegSegment(0xed, Buffer.concat([asciiZ('Photoshop 3.0'), ascii('8BIM')]));
  const app5 = jpegSegment(0xe5, ascii('vendor junk'));
  const comment = jpegSegment(0xfe, ascii('taken on a phone'));

  const jpeg = buildJpeg({ before: [jfif, fakeApp0, xmp, icc, iptc, app5, comment] });
  const result = stripImageMetadata(jpeg);

  assert.deepEqual(result.removedSegments, [
    'APP0',
    'APP1/XMP',
    'APP2/ICC',
    'APP13/Photoshop',
    'APP5',
    'COM',
  ]);
  assert.ok(result.buffer.includes(jfif), 'a real JFIF APP0 is kept');
  assert.equal(result.buffer.includes(ascii('NOT-A-JFIF-HEADER')), false);
  assert.equal(result.buffer.includes(ascii('xmpmeta')), false);
  assert.equal(result.buffer.includes(ascii('ICC_PROFILE')), false);
  assert.equal(result.buffer.includes(ascii('8BIM')), false);
  assert.equal(result.buffer.includes(ascii('taken on a phone')), false);
});

test('walks scan data containing FF 00 stuffing and restart markers', () => {
  const jpeg = buildJpeg({ scans: [TRICKY_SCAN], before: [jpegSegment(0xfe, ascii('strip me'))] });
  const result = stripImageMetadata(jpeg);

  // The scan must survive byte for byte: a walk that mistook FF 00 or FF D0 for
  // a marker would cut the image short here.
  const at = result.buffer.indexOf(TRICKY_SCAN);
  assert.ok(at > 0, 'the scan region should be present unchanged');
  assert.deepEqual(result.buffer.subarray(at, at + TRICKY_SCAN.length), TRICKY_SCAN);
  assert.deepEqual(result.buffer, buildJpeg({ scans: [TRICKY_SCAN] }));
  assert.deepEqual(result.removedSegments, ['COM']);
});

test('handles multiple scans, as progressive JPEGs have', () => {
  const secondScan = Buffer.from([0x55, 0xff, 0x00, 0x66]);
  const jpeg = buildJpeg({
    scans: [TRICKY_SCAN, secondScan],
    before: [exifApp1({ orientation: 3 })],
  });
  const result = stripImageMetadata(jpeg);

  assert.deepEqual(result.buffer, buildJpeg({ scans: [TRICKY_SCAN, secondScan] }));
  assert.ok(result.buffer.includes(secondScan));
  assert.equal(result.orientation, 3);
});

test('drops trailing junk after EOI', () => {
  const jpeg = buildJpeg({ trailing: ascii('a whole second thumbnail lives here') });
  const result = stripImageMetadata(jpeg);
  assert.deepEqual(result.buffer, buildJpeg());
  assert.equal(result.buffer.includes(ascii('thumbnail')), false);
});

/* ------------------------------------------------------------------ *
 * GPS and Exif extraction
 * ------------------------------------------------------------------ */

test('extracts GPS in both byte orders, with southern and western negatives', () => {
  for (const little of [true, false]) {
    const order = little ? 'II' : 'MM';

    const south = stripImageMetadata(
      buildJpeg({
        before: [
          exifApp1({
            little,
            gps: {
              latRef: 'S',
              lat: [[33, 1], [52, 1], [3000, 100]],
              lonRef: 'W',
              lon: [[70, 1], [39, 1], [21, 1]],
              altRef: 1,
              alt: [[1250, 100]],
            },
          }),
        ],
      }),
    );

    assert.equal(south.metadata.hadGps, true, `${order}: GPS tags were present`);
    assert.equal(south.metadata.gpsLatitude, expectedDegrees(33, 52, 30, -1), `${order}: south is negative`);
    assert.equal(south.metadata.gpsLongitude, expectedDegrees(70, 39, 21, -1), `${order}: west is negative`);
    // GPSAltitudeRef 1 means below sea level.
    assert.equal(south.metadata.gpsAltitudeMetres, -12.5, `${order}: altitude sign follows the ref`);

    const north = stripImageMetadata(
      buildJpeg({
        before: [
          exifApp1({
            little,
            gps: {
              latRef: 'N',
              lat: [[30, 1], [16, 1], [2, 1]],
              lonRef: 'E',
              lon: [[151, 1], [12, 1], [36, 1]],
              altRef: 0,
              alt: [[152, 1]],
            },
          }),
        ],
      }),
    );

    assert.equal(north.metadata.gpsLatitude, expectedDegrees(30, 16, 2, 1), `${order}: north is positive`);
    assert.equal(north.metadata.gpsLongitude, expectedDegrees(151, 12, 36, 1), `${order}: east is positive`);
    assert.equal(north.metadata.gpsAltitudeMetres, 152);
  }
});

test('extracts orientation, camera, and capture time in both byte orders', () => {
  for (const little of [true, false]) {
    const order = little ? 'II' : 'MM';
    const result = stripImageMetadata(
      buildJpeg({
        before: [
          exifApp1({
            little,
            orientation: 8,
            make: 'Google',
            model: 'Pixel 9 Pro',
            dateTimeOriginal: '2026:07:26 13:45:09',
          }),
        ],
      }),
    );

    assert.equal(result.orientation, 8, `${order}: orientation`);
    assert.equal(result.metadata.cameraMake, 'Google', `${order}: make`);
    assert.equal(result.metadata.cameraModel, 'Pixel 9 Pro', `${order}: model`);
    assert.equal(result.metadata.capturedAtRaw, '2026:07:26 13:45:09', `${order}: raw timestamp`);
    assert.equal(result.metadata.capturedAt, '2026-07-26T13:45:09', `${order}: ISO timestamp`);
    // Exif carries no timezone, so the parsed value must not claim UTC.
    assert.doesNotMatch(result.metadata.capturedAt, /Z$/);
    assert.doesNotMatch(result.metadata.capturedAt, /[+-]\d\d:\d\d$/);
  }
});

test('an out-of-range orientation is ignored rather than passed through', () => {
  const result = stripImageMetadata(buildJpeg({ before: [exifApp1({ orientation: 99 })] }));
  assert.equal(result.orientation, null);
});

test('a zero denominator yields null, never Infinity or NaN', () => {
  const result = stripImageMetadata(
    buildJpeg({
      before: [
        exifApp1({
          gps: {
            latRef: 'N',
            lat: [[30, 0], [16, 1], [2, 1]],
            lonRef: 'W',
            lon: [[97, 1], [44, 1], [21, 1]],
            alt: [[100, 0]],
          },
        }),
      ],
    }),
  );

  assert.equal(result.metadata.hadGps, true);
  assert.equal(result.metadata.gpsLatitude, null);
  // Half a coordinate is not a location, so the pair goes together.
  assert.equal(result.metadata.gpsLongitude, null);
  assert.equal(result.metadata.gpsAltitudeMetres, null);
});

test('an out-of-range latitude yields null for the pair', () => {
  const result = stripImageMetadata(
    buildJpeg({
      before: [
        exifApp1({
          gps: {
            latRef: 'N',
            lat: [[200, 1], [0, 1], [0, 1]],
            lonRef: 'E',
            lon: [[10, 1], [0, 1], [0, 1]],
          },
        }),
      ],
    }),
  );

  assert.equal(result.metadata.hadGps, true);
  assert.equal(result.metadata.gpsLatitude, null);
  assert.equal(result.metadata.gpsLongitude, null);
});

test('an out-of-range altitude is ignored', () => {
  const result = stripImageMetadata(
    buildJpeg({
      before: [
        exifApp1({
          gps: {
            latRef: 'N',
            lat: [[30, 1], [0, 1], [0, 1]],
            lonRef: 'E',
            lon: [[10, 1], [0, 1], [0, 1]],
            altRef: 0,
            alt: [[99_000, 1]],
          },
        }),
      ],
    }),
  );

  assert.equal(result.metadata.gpsAltitudeMetres, null);
  assert.equal(result.metadata.gpsLatitude, 30);
});

test('a missing hemisphere reference yields null rather than a guessed sign', () => {
  const result = stripImageMetadata(
    buildJpeg({
      before: [
        exifApp1({
          gps: { lat: [[33, 1], [52, 1], [30, 1]], lon: [[151, 1], [12, 1], [36, 1]] },
        }),
      ],
    }),
  );

  assert.equal(result.metadata.hadGps, true);
  assert.equal(result.metadata.gpsLatitude, null);
  assert.equal(result.metadata.gpsLongitude, null);
});

test('a GPS pointer past the end of the buffer does not throw', () => {
  const result = stripImageMetadata(
    buildJpeg({ before: [exifApp1({ gpsPointer: 0x7fff_0000, orientation: 1 })] }),
  );

  assert.equal(result.metadata.gpsLatitude, null);
  assert.equal(result.metadata.hadGps, false);
  // The rest of IFD0 is still readable, and the segment is still removed.
  assert.equal(result.orientation, 1);
  assert.ok(result.removedSegments.includes('APP1/Exif'));
});

test('an image with no GPS reports hadGps false', () => {
  const result = stripImageMetadata(
    buildJpeg({ before: [exifApp1({ make: 'Samsung', model: 'SM-S938B' })] }),
  );

  assert.equal(result.metadata.hadGps, false);
  assert.equal(result.metadata.gpsLatitude, null);
  assert.equal(result.metadata.gpsLongitude, null);
  assert.equal(result.metadata.cameraMake, 'Samsung');
});

test('a malformed Exif block does not throw and is still stripped', () => {
  const cases = [
    // Right signature, garbage where the TIFF header should be.
    Buffer.concat([EXIF_SIGNATURE, ascii('this is not a TIFF header at all')]),
    // Valid byte order, wrong magic number.
    Buffer.concat([EXIF_SIGNATURE, ascii('II'), Buffer.from([0x00, 0x00]), u32le(8)]),
    // Byte order marker and nothing else.
    Buffer.concat([EXIF_SIGNATURE, ascii('MM')]),
    // IFD0 pointer inside the header, which no legitimate file does.
    Buffer.concat([EXIF_SIGNATURE, ascii('II'), Buffer.from([0x2a, 0x00]), u32le(2)]),
    // A truncated TIFF block: header promises an IFD that is not there.
    Buffer.concat([EXIF_SIGNATURE, ascii('II'), Buffer.from([0x2a, 0x00]), u32le(8), Buffer.from([0x09])]),
    // Signature only.
    EXIF_SIGNATURE,
  ];

  for (const [index, payload] of cases.entries()) {
    const jpeg = buildJpeg({ before: [jpegSegment(0xe1, payload)] });
    const result = stripImageMetadata(jpeg);
    assert.deepEqual(result.buffer, buildJpeg(), `case ${index}: still a clean JPEG`);
    assert.equal(result.orientation, null, `case ${index}: no orientation`);
    assert.equal(result.metadata.hadGps, false, `case ${index}: no GPS`);
    assert.ok(result.removedSegments.includes('APP1/Exif'), `case ${index}: segment removed`);
  }
});

/* ------------------------------------------------------------------ *
 * PNG stripping
 * ------------------------------------------------------------------ */

test('drops PNG text and metadata chunks and keeps the image ones in order', () => {
  const exifTiff = buildTiff({
    little: false,
    orientation: 6,
    gps: {
      latRef: 'S',
      lat: [[12, 1], [30, 1], [0, 1]],
      lonRef: 'W',
      lon: [[45, 1], [15, 1], [0, 1]],
    },
  });

  const png = buildPng({
    middle: [
      pngChunk('gAMA', u32be(45_455)),
      pngChunk('tEXt', Buffer.concat([asciiZ('Comment'), ascii('SECRET-TEXT-CHUNK')])),
      pngChunk('eXIf', exifTiff),
      pngChunk('zTXt', Buffer.concat([asciiZ('Zipped'), Buffer.from([0x00, 0x78, 0x9c])])),
      pngChunk('iTXt', Buffer.concat([asciiZ('Author'), ascii('someone')])),
      pngChunk('tIME', Buffer.concat([u16be(2026), Buffer.from([7, 26, 13, 45, 9])])),
      pngChunk('iCCP', Buffer.concat([asciiZ('sRGB'), Buffer.from([0x00, 0x78, 0x9c])])),
      pngChunk('pHYs', Buffer.concat([u32be(3780), u32be(3780), Buffer.from([1])])),
    ],
  });

  const result = stripImageMetadata(png);

  assert.deepEqual(pngChunkOrder(result.buffer), ['IHDR', 'gAMA', 'pHYs', 'IDAT', 'IEND']);
  assert.deepEqual(result.removedSegments, ['tEXt', 'eXIf', 'zTXt', 'iTXt', 'tIME', 'iCCP']);
  assert.equal(result.buffer.includes(ascii('SECRET-TEXT-CHUNK')), false);
  assert.equal(result.buffer.includes(ascii('eXIf')), false);
  assert.ok(result.removedBytes > 0);
  assert.deepEqual([result.width, result.height], [16, 12]);

  // The eXIf chunk holds a bare TIFF block with no 'Exif' prefix, and is read
  // before it is removed just like a JPEG APP1.
  assert.equal(result.orientation, 6);
  assert.equal(result.metadata.gpsLatitude, expectedDegrees(12, 30, 0, -1));
  assert.equal(result.metadata.gpsLongitude, expectedDegrees(45, 15, 0, -1));

  // Still a valid PNG afterwards.
  const reinspected = inspectImage(result.buffer);
  assert.equal(reinspected.ok, true);
  assert.equal(reinspected.format, 'png');
});

test('a PNG with nothing to strip comes back byte-identical', () => {
  const png = buildPng();
  const result = stripImageMetadata(png);
  assert.deepEqual(result.buffer, png);
  assert.deepEqual(result.removedSegments, []);
});

test('keeps APNG animation chunks', () => {
  const png = buildPng({
    middle: [
      pngChunk('acTL', Buffer.concat([u32be(2), u32be(0)])),
      pngChunk('fcTL', Buffer.alloc(26)),
      pngChunk('tEXt', Buffer.concat([asciiZ('Note'), ascii('drop me')])),
    ],
  });
  const result = stripImageMetadata(png);
  assert.deepEqual(pngChunkOrder(result.buffer), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'IEND']);
  assert.deepEqual(result.removedSegments, ['tEXt']);
});

test('a bad CRC on a chunk being removed anyway is not fatal', () => {
  // Documented behaviour: only chunks we keep are verified, because a corrupt
  // text chunk we are deleting cannot damage the image.
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdrData(16, 12)),
    pngChunkWithBadCrc('tEXt', Buffer.concat([asciiZ('Note'), ascii('corrupt')])),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x03])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const result = stripImageMetadata(png);
  assert.deepEqual(result.removedSegments, ['tEXt']);
});

test('rejects a PNG with no IEND', () => {
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdrData(16, 12)),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x03])),
  ]);
  assertPhotoError(() => stripImageMetadata(png), 'MALFORMED');
});

/* ------------------------------------------------------------------ *
 * WebP stripping
 * ------------------------------------------------------------------ */

test('drops a WebP EXIF chunk, clears the VP8X flag, and fixes the RIFF size', () => {
  const exifTiff = buildTiff({
    little: true,
    orientation: 3,
    gps: { latRef: 'N', lat: [[19, 1], [26, 1], [0, 1]], lonRef: 'W', lon: [[99, 1], [8, 1], [0, 1]] },
  });

  // Flags: ICC (0x20) + alpha (0x10) + Exif (0x08) + XMP (0x04).
  const webp = buildWebp([
    vp8xChunk(0x3c, 700, 500),
    riffChunk('ALPH', Buffer.from([0x01, 0x02, 0x03, 0x04])),
    vp8Chunk(700, 500),
    riffChunk('ICCP', ascii('an ICC profile')),
    riffChunk('EXIF', exifTiff),
    riffChunk('XMP ', ascii('<x:xmpmeta/>')),
  ]);

  const result = stripImageMetadata(webp);
  const chunks = riffChunksOf(result.buffer);

  assert.deepEqual(result.removedSegments, ['ICCP', 'EXIF', 'XMP ']);
  assert.equal(chunks.has('EXIF'), false);
  assert.equal(chunks.has('XMP '), false);
  assert.equal(chunks.has('ICCP'), false);
  assert.ok(chunks.has('VP8X') && chunks.has('VP8 ') && chunks.has('ALPH'));

  // Only the alpha bit should remain set. Leaving Exif or XMP advertised after
  // removing the chunk makes the file internally inconsistent.
  assert.equal(chunks.get('VP8X')[0], 0x10);

  // The RIFF size field counts everything after itself.
  assert.equal(result.buffer.readUInt32LE(4), result.buffer.length - 8);
  assert.equal(result.buffer.includes(ascii('xmpmeta')), false);
  assert.equal(result.buffer.includes(ascii('an ICC profile')), false);

  assert.deepEqual([result.width, result.height], [700, 500]);
  assert.equal(result.orientation, 3);
  assert.equal(result.metadata.gpsLatitude, expectedDegrees(19, 26, 0, 1));
  assert.equal(result.metadata.gpsLongitude, expectedDegrees(99, 8, 0, -1));

  const reinspected = inspectImage(result.buffer);
  assert.equal(reinspected.ok, true);
  assert.equal(reinspected.format, 'webp');
});

test('handles odd-length RIFF chunk padding', () => {
  const oddAlpha = Buffer.from([0xaa, 0xbb, 0xcc]);
  const webp = buildWebp([
    vp8xChunk(0x1c, 64, 48),
    riffChunk('ALPH', oddAlpha),
    riffChunk('XMP ', ascii('odd')),
    vp8Chunk(64, 48),
  ]);

  // The pad byte is present in the stream but not counted in the chunk size, so
  // a parser that ignored it would read every later chunk one byte off.
  const result = stripImageMetadata(webp);
  const chunks = riffChunksOf(result.buffer);

  assert.deepEqual(chunks.get('ALPH'), oddAlpha);
  assert.equal(chunks.has('XMP '), false);
  assert.ok(chunks.has('VP8 '));
  assert.equal(chunks.get('VP8X')[0], 0x10);
  assert.equal(result.buffer.readUInt32LE(4), result.buffer.length - 8);
  assert.equal(result.buffer.length % 2, 0, 'a RIFF file stays even in length');
  assert.deepEqual([result.width, result.height], [64, 48]);
});

test('a WebP with nothing to strip comes back unchanged', () => {
  const webp = buildWebp([vp8Chunk(32, 24)]);
  const result = stripImageMetadata(webp);
  assert.deepEqual(result.buffer, webp);
  assert.deepEqual(result.removedSegments, []);
});

test('rejects a WebP whose RIFF size or chunk size runs past the end', () => {
  const webp = buildWebp([vp8Chunk(32, 24)]);

  const bigRiff = Buffer.from(webp);
  bigRiff.writeUInt32LE(webp.length * 4, 4);
  assertPhotoError(() => stripImageMetadata(bigRiff), 'MALFORMED');

  const bigChunk = Buffer.from(webp);
  bigChunk.writeUInt32LE(0x7000_0000, 16);
  assertPhotoError(() => stripImageMetadata(bigChunk), 'MALFORMED');

  const empty = Buffer.concat([ascii('RIFF'), u32le(4), ascii('WEBP')]);
  assertPhotoError(() => stripImageMetadata(empty), 'MALFORMED');
});

/* ------------------------------------------------------------------ *
 * Display filenames
 * ------------------------------------------------------------------ */

test('sanitizeDisplayFilename reduces a name to a safe label', () => {
  assert.equal(sanitizeDisplayFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeDisplayFilename('..\\..\\windows\\system32\\config'), 'config');
  assert.equal(sanitizeDisplayFilename('C:\\Users\\bob\\taco.jpg'), 'taco.jpg');
  assert.equal(sanitizeDisplayFilename('/etc/shadow'), 'shadow');

  // A NUL can truncate a string in anything downstream that reaches C code.
  assert.equal(sanitizeDisplayFilename(`taco${NUL_CHARACTER}.jpg.exe`), 'taco.jpg.exe');
  assert.equal(sanitizeDisplayFilename(`${NUL_CHARACTER}${NUL_CHARACTER}`), 'photo');

  // Control characters, including the ones that would break a log line.
  const control = `ta${String.fromCharCode(7)}co${String.fromCharCode(10)}x${String.fromCharCode(27)}.jpg`;
  assert.equal(sanitizeDisplayFilename(control), 'tacox.jpg');

  // A bidi override can make an extension render reversed.
  assert.equal(sanitizeDisplayFilename(`taco${String.fromCharCode(0x202e)}gpj.exe`), 'tacogpj.exe');

  // Empty, whitespace, and dot-only results fall back rather than returning ''.
  assert.equal(sanitizeDisplayFilename(''), 'photo');
  assert.equal(sanitizeDisplayFilename('   '), 'photo');
  assert.equal(sanitizeDisplayFilename('.'), 'photo');
  assert.equal(sanitizeDisplayFilename('..'), 'photo');
  assert.equal(sanitizeDisplayFilename('.hidden'), 'hidden');
  assert.equal(sanitizeDisplayFilename(null), 'photo');
  assert.equal(sanitizeDisplayFilename(42), 'photo');

  // Length is capped.
  const long = `${'a'.repeat(496)}.jpg`;
  const capped = sanitizeDisplayFilename(long);
  assert.equal(long.length, 500);
  assert.ok(capped.length <= 120, `expected at most 120 characters, got ${capped.length}`);
  assert.ok(capped.length > 0);

  // The result never contains a path separator or a NUL.
  for (const name of ['../../etc/passwd', `a${NUL_CHARACTER}b`, 'C:\\x\\y.jpg', long]) {
    const label = sanitizeDisplayFilename(name);
    assert.equal(label.includes('/'), false);
    assert.equal(label.includes('\\'), false);
    assert.equal(label.includes(NUL_CHARACTER), false);
  }
});

/* ------------------------------------------------------------------ *
 * storePhoto
 * ------------------------------------------------------------------ */

test('storePhoto writes a stripped file and returns its metadata', async () => {
  const { root, uploadDir, tempDir } = await makeDirectories();
  try {
    const needle = ascii('GPSNEEDLE-DO-NOT-KEEP');
    const bytes = buildJpeg({
      width: 4032,
      height: 3024,
      before: [
        exifApp1({
          little: true,
          orientation: 6,
          make: needle.toString('latin1'),
          model: 'Pixel 9 Pro',
          dateTimeOriginal: '2026:07:26 13:45:09',
          gps: {
            latRef: 'N',
            lat: [[30, 1], [16, 1], [2, 1]],
            lonRef: 'W',
            lon: [[97, 1], [44, 1], [21, 1]],
            altRef: 0,
            alt: [[149, 1]],
          },
        }),
      ],
    });

    const stored = await storePhoto({
      bytes,
      originalName: '../../etc/PXL_20260726_134509.jpg',
      uploadDir,
      tempDir,
    });

    assert.match(stored.storageName, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/);
    assert.equal(stored.mimeType, 'image/jpeg');
    assert.deepEqual([stored.width, stored.height], [4032, 3024]);
    assert.equal(stored.orientation, 6);
    // The client filename is a label only.
    assert.equal(stored.originalName, 'PXL_20260726_134509.jpg');

    assert.equal(stored.metadata.gpsLatitude, expectedDegrees(30, 16, 2, 1));
    assert.equal(stored.metadata.gpsLongitude, expectedDegrees(97, 44, 21, -1));
    assert.equal(stored.metadata.gpsAltitudeMetres, 149);
    assert.equal(stored.metadata.hadGps, true);
    assert.equal(stored.metadata.capturedAt, '2026-07-26T13:45:09');
    assert.equal(stored.metadata.cameraModel, 'Pixel 9 Pro');

    // Exactly one file, under the UUID name, with no temp file left behind.
    assert.deepEqual(await fs.readdir(uploadDir), [stored.storageName]);
    assert.deepEqual(await fs.readdir(tempDir), []);

    const onDisk = await fs.readFile(path.join(uploadDir, stored.storageName));
    assert.equal(onDisk.length, stored.byteSize);
    assert.ok(onDisk.length < bytes.length, 'the stored file is smaller than the upload');
    assert.equal(onDisk.includes(needle), false, 'no Exif bytes reached the disk');
    assert.equal(onDisk.includes(EXIF_SIGNATURE), false);
    assert.deepEqual(onDisk.subarray(0, 2), SOI);
    assert.deepEqual(onDisk.subarray(-2), EOI);

    const { createHash } = await import('node:crypto');
    assert.equal(createHash('sha256').update(onDisk).digest('hex'), stored.sha256);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('storePhoto leaves nothing behind when validation fails', async () => {
  const { root, uploadDir, tempDir } = await makeDirectories();
  try {
    const cases = [
      [ascii('this is not an image at all'), 'UNSUPPORTED_FORMAT'],
      [Buffer.alloc(0), 'EMPTY'],
      [buildHeic('heic'), 'HEIC_UNSUPPORTED'],
      [buildPng({ width: 30_000, height: 30_000 }), 'TOO_MANY_PIXELS'],
      [buildPng().subarray(0, 40), 'MALFORMED'],
    ];

    for (const [bytes, code] of cases) {
      await assert.rejects(
        () => storePhoto({ bytes, originalName: 'x.jpg', uploadDir, tempDir }),
        (error) => {
          assert.ok(error instanceof PhotoError);
          assert.equal(error.code, code);
          return true;
        },
      );
      // Nothing written, in either directory, on any failure path.
      assert.deepEqual(await fs.readdir(tempDir), [], `${code}: temp directory stays empty`);
      assert.deepEqual(await fs.readdir(uploadDir), [], `${code}: upload directory stays empty`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('storePhoto enforces maxBytes against the bytes actually received', async () => {
  const { root, uploadDir, tempDir } = await makeDirectories();
  try {
    const bytes = buildJpeg();
    await assert.rejects(
      () => storePhoto({ bytes, uploadDir, tempDir, maxBytes: 8 }),
      (error) => {
        assert.equal(error.code, 'TOO_LARGE');
        assert.match(error.message, /MB/);
        return true;
      },
    );
    assert.deepEqual(await fs.readdir(tempDir), []);
    assert.deepEqual(await fs.readdir(uploadDir), []);

    // The same bytes are fine under a sane ceiling.
    const stored = await storePhoto({ bytes, uploadDir, tempDir, maxBytes: 10 * 1024 * 1024 });
    assert.equal(stored.byteSize, bytes.length);
    assert.equal(stored.originalName, 'photo');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('storePhoto stores PNG and WebP under the right extension and type', async () => {
  const { root, uploadDir, tempDir } = await makeDirectories();
  try {
    const png = await storePhoto({ bytes: buildPng(), uploadDir, tempDir });
    assert.match(png.storageName, /\.png$/);
    assert.equal(png.mimeType, 'image/png');

    const webp = await storePhoto({
      bytes: buildWebp([vp8xChunk(0x08, 64, 48), vp8Chunk(64, 48), riffChunk('EXIF', buildTiff({ orientation: 1 }))]),
      uploadDir,
      tempDir,
    });
    assert.match(webp.storageName, /\.webp$/);
    assert.equal(webp.mimeType, 'image/webp');

    assert.equal((await fs.readdir(uploadDir)).length, 2);
    assert.deepEqual(await fs.readdir(tempDir), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an absurd IFD entry count is refused without reading out of bounds', () => {
  // 60000 entries declared in a block that is a few dozen bytes long.
  const tiff = Buffer.concat([ascii('II'), Buffer.from([0x2a, 0x00]), u32le(8), u32le(0xea60)]);
  const jpeg = buildJpeg({ before: [jpegSegment(0xe1, Buffer.concat([EXIF_SIGNATURE, tiff]))] });
  const result = stripImageMetadata(jpeg);
  assert.equal(result.metadata.hadGps, false);
  assert.deepEqual(result.buffer, buildJpeg());
});

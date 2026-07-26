/**
 * Password hashing, verification, and policy.
 *
 * See docs/security-decisions.md for the reasoning and sources. The short
 * version:
 *
 *  - Argon2id is OWASP's first choice and is available with no native dependency
 *    from Node 24.7.0 via `crypto.argon2`. That API may still be marked
 *    experimental, so it is probed at boot with a real hash rather than trusted
 *    on a version check, and scrypt is used if the probe fails for any reason.
 *  - Hashes are PHC strings that carry their own algorithm and parameters, so
 *    verification dispatches on what the row actually holds and accounts are
 *    upgraded transparently on next login.
 *  - Concurrent hashing is capped, because a memory-hard KDF is a
 *    denial-of-service vector against your own container if it is not.
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

/** Argon2id parameters. OWASP minimum: 19 MiB, 2 iterations, 1 lane. */
const ARGON2_PARAMS = Object.freeze({
  memory: 19456, // KiB
  passes: 2,
  parallelism: 1,
  tagLength: 32,
});

/**
 * scrypt parameters. An OWASP-listed set (N=2^15, r=8, p=3).
 *
 * maxmem MUST be raised: Node defaults it to 32 MiB and throws when
 * 128 * N * r exceeds it, which every OWASP setting but the weakest does. At
 * N=2^15, r=8 that is 32 MiB of allocation per hash, so this is not optional.
 */
const SCRYPT_PARAMS = Object.freeze({
  N: 32768, // 2^15
  r: 8,
  p: 3,
  keylen: 32,
  maxmem: 96 * 1024 * 1024,
});

const SALT_BYTES = 16;

/** NIST SP 800-63B: 15 character minimum without MFA. Not 8. */
export const MIN_PASSWORD_LENGTH = 15;

/** Bounds KDF work. NIST wants at least 64 permitted; this is far above it. */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * Whether Argon2id is usable in this runtime. Set by probeHashing().
 * @type {boolean}
 */
let argon2Available = false;
let probed = false;

/**
 * A hash of a random value, computed once at boot with production parameters.
 * Verifying against this on a username miss keeps the response time of an
 * unknown account indistinguishable from a wrong password.
 * @type {string|null}
 */
let dummyHash = null;

/* ------------------------------------------------------------------ *
 * Concurrency cap
 * ------------------------------------------------------------------ */

const MAX_CONCURRENT_HASHES = 2;
let activeHashes = 0;
/** @type {Array<() => void>} */
const hashQueue = [];

/**
 * Run `task` with at most MAX_CONCURRENT_HASHES others in flight.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function withHashSlot(task) {
  if (activeHashes >= MAX_CONCURRENT_HASHES) {
    await new Promise((resolve) => hashQueue.push(resolve));
  }
  activeHashes += 1;
  try {
    return await task();
  } finally {
    activeHashes -= 1;
    const next = hashQueue.shift();
    if (next) next();
  }
}

/* ------------------------------------------------------------------ *
 * PHC string encoding
 * ------------------------------------------------------------------ */

/** PHC uses unpadded standard base64. */
function b64(buffer) {
  return buffer.toString('base64').replace(/=+$/, '');
}

function unb64(text) {
  return Buffer.from(text, 'base64');
}

/**
 * Parse a stored hash. Returns null for anything malformed rather than
 * throwing, so a corrupt row fails a login instead of crashing a request.
 * @param {string} stored
 */
function parsePhc(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('$')) return null;
  const parts = stored.split('$');
  // ['', algorithm, ...params, salt, tag]
  if (parts.length < 4) return null;
  const algorithm = parts[1];
  const tag = parts[parts.length - 1];
  const salt = parts[parts.length - 2];
  /** @type {Record<string, string>} */
  const params = {};
  for (const chunk of parts.slice(2, parts.length - 2)) {
    for (const pair of chunk.split(',')) {
      const [key, value] = pair.split('=');
      if (key) params[key] = value;
    }
  }
  if (!salt || !tag) return null;
  return { algorithm, params, salt, tag };
}

/* ------------------------------------------------------------------ *
 * Algorithm implementations
 * ------------------------------------------------------------------ */

/**
 * @param {string} password
 * @param {Buffer} salt
 * @returns {Promise<Buffer>}
 */
function argon2idRaw(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        memory: ARGON2_PARAMS.memory,
        passes: ARGON2_PARAMS.passes,
        parallelism: ARGON2_PARAMS.parallelism,
        tagLength: ARGON2_PARAMS.tagLength,
      },
      (error, tag) => (error ? reject(error) : resolve(Buffer.from(tag))),
    );
  });
}

/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {{N: number, r: number, p: number, keylen: number, maxmem: number}} params
 * @returns {Promise<Buffer>}
 */
async function scryptRaw(password, salt, params) {
  return scryptAsync(Buffer.from(password, 'utf8'), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Decide which algorithm this runtime will use, and build the dummy hash.
 *
 * Call once during startup. Argon2 is probed by actually hashing, not by
 * checking a version number, so an API that exists but behaves differently than
 * expected downgrades cleanly to scrypt instead of failing every login.
 *
 * @param {{log?: (message: string) => void}} [options]
 * @returns {Promise<{algorithm: 'argon2id'|'scrypt'}>}
 */
export async function probeHashing(options = {}) {
  const log = options.log ?? (() => {});

  if (typeof crypto.argon2 === 'function') {
    try {
      const tag = await argon2idRaw('probe', crypto.randomBytes(SALT_BYTES));
      argon2Available = tag.length === ARGON2_PARAMS.tagLength;
    } catch (error) {
      argon2Available = false;
      log(`argon2id unavailable (${error.message}); using scrypt`);
    }
  }

  if (!argon2Available) {
    // Fail fast if scrypt at our parameters cannot run either, rather than
    // discovering it on the first login attempt.
    await scryptRaw('probe', crypto.randomBytes(SALT_BYTES), SCRYPT_PARAMS);
  }

  probed = true;
  const algorithm = argon2Available ? 'argon2id' : 'scrypt';
  log(`password hashing: ${algorithm}`);

  // Built with the same code path a real password takes.
  dummyHash = await hashPassword(crypto.randomBytes(32).toString('base64'));

  return { algorithm };
}

/** The algorithm this process will use for new hashes. */
export function currentAlgorithm() {
  return argon2Available ? 'argon2id' : 'scrypt';
}

/**
 * Hash a password into a PHC string.
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('hashPassword requires a non-empty string');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    // Refuse rather than truncate: silently hashing a prefix would mean a
    // shorter password also unlocks the account.
    throw new Error('Password exceeds the maximum length');
  }

  const salt = crypto.randomBytes(SALT_BYTES);

  return withHashSlot(async () => {
    if (argon2Available) {
      const tag = await argon2idRaw(password, salt);
      const { memory, passes, parallelism } = ARGON2_PARAMS;
      return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
    }
    const tag = await scryptRaw(password, salt, SCRYPT_PARAMS);
    const ln = Math.log2(SCRYPT_PARAMS.N);
    return `$scrypt$ln=${ln},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$${b64(salt)}$${b64(tag)}`;
  });
}

/**
 * Verify a password against a stored PHC string.
 *
 * `needsRehash` is true when the stored hash used an older algorithm or weaker
 * parameters than we now target. The caller re-hashes and updates the row while
 * the plaintext is still in hand.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<{ok: boolean, needsRehash: boolean}>}
 */
export async function verifyPassword(password, stored) {
  const parsed = parsePhc(stored);
  if (!parsed || typeof password !== 'string') {
    return { ok: false, needsRehash: false };
  }
  // Do not spend KDF time on an input we would refuse to hash anyway.
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, needsRehash: false };
  }

  const salt = unb64(parsed.salt);
  const expected = unb64(parsed.tag);

  /** @type {Buffer|null} */
  let actual = null;
  let needsRehash = false;

  try {
    await withHashSlot(async () => {
      if (parsed.algorithm === 'argon2id') {
        if (typeof crypto.argon2 !== 'function') return;
        const memory = Number(parsed.params.m);
        const passes = Number(parsed.params.t);
        const parallelism = Number(parsed.params.p);
        if (!memory || !passes || !parallelism) return;
        actual = await new Promise((resolve, reject) => {
          crypto.argon2(
            'argon2id',
            {
              message: Buffer.from(password, 'utf8'),
              nonce: salt,
              memory,
              passes,
              parallelism,
              tagLength: expected.length,
            },
            (error, tag) => (error ? reject(error) : resolve(Buffer.from(tag))),
          );
        });
        needsRehash =
          memory < ARGON2_PARAMS.memory ||
          passes < ARGON2_PARAMS.passes ||
          expected.length < ARGON2_PARAMS.tagLength;
      } else if (parsed.algorithm === 'scrypt') {
        const ln = Number(parsed.params.ln);
        const r = Number(parsed.params.r);
        const p = Number(parsed.params.p);
        if (!ln || !r || !p || ln > 22) return;
        const N = 2 ** ln;
        actual = await scryptRaw(password, salt, {
          N,
          r,
          p,
          keylen: expected.length,
          // Size to this hash's own parameters so an older, cheaper hash still
          // verifies, with a ceiling so a tampered row cannot request 4 GiB.
          maxmem: Math.max(SCRYPT_PARAMS.maxmem, 128 * N * r + 1024 * 1024),
        });
        // Any scrypt hash needs upgrading once Argon2id is available.
        needsRehash =
          argon2Available ||
          N < SCRYPT_PARAMS.N ||
          r < SCRYPT_PARAMS.r ||
          expected.length < SCRYPT_PARAMS.keylen;
      }
    });
  } catch {
    // A malformed row or a KDF that refused the stored parameters is a failed
    // login, not a crash.
    return { ok: false, needsRehash: false };
  }

  if (!actual || actual.length !== expected.length) {
    return { ok: false, needsRehash: false };
  }

  const ok = crypto.timingSafeEqual(actual, expected);
  return { ok, needsRehash: ok && needsRehash };
}

/**
 * Burn the same work a real verification would, for the username-miss path.
 *
 * Without this, an unknown account returns in microseconds while a known one
 * spends the full KDF budget, and response timing becomes a reliable account
 * enumeration oracle no matter how generic the error message is.
 *
 * @returns {Promise<void>}
 */
export async function verifyDummyPassword() {
  if (!dummyHash) {
    if (!probed) throw new Error('probeHashing() must run during startup');
    return;
  }
  await verifyPassword('not the password', dummyHash);
}

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

/**
 * Passwords rejected outright. Kept short on purpose: with a 15 character
 * minimum, almost every classic weak password is already excluded by length,
 * so this list only needs to cover long-but-obvious choices.
 *
 * Compared case-insensitively against the whole password, never a substring,
 * per NIST SP 800-63B.
 */
const BLOCKED_PASSWORDS = new Set([
  'passwordpassword',
  'password12345678',
  'passwordpassword1',
  '123456789012345',
  '1234567890123456',
  '111111111111111',
  '000000000000000',
  'qwertyuiopasdfgh',
  'qwertyuiopasdfghjkl',
  'abcdefghijklmnop',
  'aaaaaaaaaaaaaaa',
  'iloveyouforever',
  'letmeinletmein',
  'administrator123',
  'thisismypassword',
  'mypasswordisthis',
  'correcthorsebatterystaple',
  'tacotacotacotaco',
  'tacobelltacobell',
  'tacoanalyzer123',
]);

/**
 * Check a proposed password against policy.
 *
 * Returns a list of human-readable problems, empty when acceptable. Deliberately
 * has NO composition rules (no "must contain a symbol"): NIST SP 800-63B
 * explicitly forbids them, because they push people toward predictable
 * substitutions without adding real entropy.
 *
 * @param {string} password
 * @param {{email?: string, displayName?: string}} [context]
 * @returns {string[]}
 */
export function checkPasswordPolicy(password, context = {}) {
  const problems = [];

  if (typeof password !== 'string' || password.length === 0) {
    return ['Enter a password.'];
  }

  // Count Unicode code points, not UTF-16 units, so an emoji counts as one
  // character the way a user would expect.
  const length = [...password].length;

  if (length < MIN_PASSWORD_LENGTH) {
    problems.push(
      `Use at least ${MIN_PASSWORD_LENGTH} characters. ` +
        'A short phrase of a few words is easier to remember and harder to guess ' +
        'than a short jumble.',
    );
  }
  if (length > MAX_PASSWORD_LENGTH) {
    problems.push(`Use no more than ${MAX_PASSWORD_LENGTH} characters.`);
  }
  if (password.trim().length === 0) {
    problems.push('A password cannot be only spaces.');
  }

  const normalized = password.normalize('NFKC').toLowerCase();

  if (BLOCKED_PASSWORDS.has(normalized)) {
    problems.push('That password is too well known. Choose something else.');
  }

  // A single repeated character, however long, has almost no entropy.
  if (/^(.)\1+$/u.test(password)) {
    problems.push('That password is a single repeated character.');
  }

  // A password built from the account's own identifiers is guessable by anyone
  // who knows who the account belongs to.
  const localPart = (context.email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length >= 4 && normalized.includes(localPart)) {
    problems.push('Do not build your password out of your email address.');
  }
  const displayName = (context.displayName ?? '').toLowerCase().trim();
  if (displayName.length >= 4 && normalized.includes(displayName)) {
    problems.push('Do not build your password out of your name.');
  }
  if (normalized.includes('tacoanalyzer') || normalized.includes('taco analyzer')) {
    problems.push('Do not build your password out of the name of this site.');
  }

  return problems;
}

/**
 * Generate an admin-issued initial password.
 *
 * The server generates this, never an admin, so no guessable house pattern can
 * exist across accounts. Crockford-style base32 without look-alike characters,
 * grouped for reading aloud, since it is handed over verbally or on paper.
 *
 * Five groups of five characters from a 32 character alphabet is 125 bits.
 *
 * @returns {string} e.g. 'K7M2X-9PQRT-4H8VN-3JWYC-6BFDG'
 */
export function generateInitialPassword() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I/L
  const groups = 5;
  const perGroup = 5;
  const bytes = crypto.randomBytes(groups * perGroup);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  const out = [];
  for (let i = 0; i < groups; i += 1) {
    out.push(chars.slice(i * perGroup, (i + 1) * perGroup).join(''));
  }
  return out.join('-');
}

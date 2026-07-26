/**
 * Configuration, read from the environment once at startup.
 *
 * Two principles:
 *
 *  1. Insecure settings must be opted into, never fallen into. COOKIE_SECURE
 *     defaults to on, so forgetting to configure the app cannot produce a
 *     deployment that hands out non-Secure session cookies.
 *  2. Misconfiguration fails at boot, not on the first request. A contradiction
 *     like "secure cookies over an http:// base URL" would otherwise present as
 *     users mysteriously unable to log in.
 *
 * Note there is no application secret to manage: sessions and CSRF tokens are
 * random values stored server side rather than signed payloads, so there is
 * nothing here to leak or rotate.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} name
 * @param {string} fallback
 */
function str(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * Parse a boolean-ish env var. Accepts 1/0, true/false, yes/no, on/off.
 * Anything else is an error rather than a silent default, because a typo in a
 * security flag must not quietly disable it.
 * @param {string} name
 * @param {boolean} fallback
 */
function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(
    `${name} must be a boolean (1/0, true/false, yes/no, on/off), got "${raw}".`,
  );
}

/**
 * @param {string} name
 * @param {number} fallback
 */
function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a whole number, got "${raw}".`);
  }
  return Number(raw.trim());
}

/**
 * Build the config object, validating as we go.
 * @returns {{
 *   env: string,
 *   host: string,
 *   port: number,
 *   baseUrl: string,
 *   allowedOrigins: string[],
 *   dataDir: string,
 *   databaseFile: string,
 *   uploadDir: string,
 *   tempDir: string,
 *   cookieSecure: boolean,
 *   cookieName: string,
 *   trustProxy: boolean,
 *   maxUploadBytes: number,
 *   logSql: boolean,
 *   isProduction: boolean,
 * }}
 */
export function loadConfig() {
  const env = str('NODE_ENV', 'production');
  const isProduction = env === 'production';

  const host = str('HOST', '0.0.0.0');
  const port = int('PORT', 8787);
  if (port < 1 || port > 65535) {
    throw new Error(`PORT must be between 1 and 65535, got ${port}.`);
  }

  const dataDir = path.resolve(str('DATA_DIR', path.join(process.cwd(), 'data')));

  const cookieSecure = bool('COOKIE_SECURE', true);

  // The public origin, used for the CSRF Origin check and for absolute links.
  const baseUrl = str('BASE_URL', `http://localhost:${port}`).replace(/\/+$/, '');
  let parsedBase;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new Error(`BASE_URL is not a valid URL: "${baseUrl}".`);
  }
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    throw new Error('BASE_URL must be an http:// or https:// URL.');
  }

  // A Secure cookie cannot be set from a non-secure origin at all, so this
  // combination would silently break every login. Catch it here instead.
  if (cookieSecure && parsedBase.protocol === 'http:' && parsedBase.hostname !== 'localhost') {
    throw new Error(
      'COOKIE_SECURE is on but BASE_URL is http://. A browser will refuse a ' +
        'Secure cookie from a non-secure origin, so nobody would be able to log in.\n' +
        'Either serve the app over https:// (recommended: the installer sets up ' +
        'a TLS reverse proxy), or set COOKIE_SECURE=0 to accept an insecure ' +
        'LAN deployment where session tokens travel in cleartext.',
    );
  }

  // Over HTTPS the __Host- prefix pins the cookie to this exact origin with
  // Path=/ and no Domain. It requires Secure, so it is impossible over plain
  // HTTP. The differing name is deliberate: flipping to TLS orphans every
  // cookie issued during the HTTP phase and forces a fresh, secure login.
  const cookieName = cookieSecure ? '__Host-id' : 'id';

  const allowedOrigins = [parsedBase.origin];
  // Additional origins the app may legitimately be reached on, comma separated.
  // Useful when the same box answers on a LAN IP and a hostname.
  for (const extra of str('EXTRA_ORIGINS', '').split(',')) {
    const trimmed = extra.trim();
    if (!trimmed) continue;
    try {
      allowedOrigins.push(new URL(trimmed).origin);
    } catch {
      throw new Error(`EXTRA_ORIGINS contains an invalid URL: "${trimmed}".`);
    }
  }

  const config = {
    env,
    isProduction,
    host,
    port,
    baseUrl,
    allowedOrigins,
    dataDir,
    databaseFile: path.join(dataDir, str('DB_FILENAME', 'taco.db')),
    uploadDir: path.join(dataDir, 'uploads'),
    // Uploads are spooled here first, then moved into uploadDir once validated.
    // Same filesystem, so the move is atomic rather than a copy.
    tempDir: path.join(dataDir, 'tmp'),
    cookieSecure,
    cookieName,
    // Only enable behind a proxy you control that OVERWRITES, not appends,
    // X-Forwarded-For. Otherwise a client can forge its own address and defeat
    // per-IP throttling.
    trustProxy: bool('TRUST_PROXY', false),
    maxUploadBytes: int('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
    logSql: bool('LOG_SQL', false),
  };

  return config;
}

/**
 * Create the runtime directories with restrictive permissions.
 *
 * 0o700 on the data directory: the database contains password hashes and
 * session material, and the upload directory contains user photos. Nothing on
 * the box other than the service account has any business reading them.
 *
 * @param {{dataDir: string, uploadDir: string, tempDir: string}} config
 */
export function ensureDirectories(config) {
  for (const directory of [config.dataDir, config.uploadDir, config.tempDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // mkdirSync's mode is ignored when the directory already exists, so set it
    // explicitly to correct a previously loose deployment. Not applicable on
    // Windows, where chmod is largely a no-op.
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(directory, 0o700);
      } catch {
        // A permission we cannot tighten is worth continuing past; the installer
        // is responsible for ownership.
      }
    }
  }
}

/**
 * Warnings to print at startup. Returned rather than logged so the caller
 * controls formatting and the test suite can assert on them.
 * @param {ReturnType<typeof loadConfig>} config
 * @returns {string[]}
 */
export function configWarnings(config) {
  const warnings = [];

  if (!config.cookieSecure) {
    warnings.push(
      'COOKIE_SECURE is OFF. Session cookies are sent without the Secure flag, ' +
        'so session tokens travel in cleartext and anyone on this network can ' +
        'read or replace them. Acceptable only for a closed LAN demo. Do not ' +
        'expose this deployment to the internet.',
    );
  }

  if (config.trustProxy) {
    warnings.push(
      'TRUST_PROXY is on: X-Forwarded-For is believed. Make sure the proxy in ' +
        'front of this app overwrites that header rather than appending to it, ' +
        'or clients can forge their address and evade per-IP login throttling.',
    );
  }

  if (!config.isProduction) {
    warnings.push(`NODE_ENV is "${config.env}", not "production".`);
  }

  return warnings;
}

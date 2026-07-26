/**
 * Static asset serving.
 *
 * This is an explicit allowlist rather than a directory server, and that is the
 * whole point: with a fixed map from URL to file there is no path to traverse,
 * no way to reach a dotfile, and no chance of accidentally exposing something
 * that later lands in the same folder. The app only has a handful of assets, so
 * a generic static handler would be more risk than convenience.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PUBLIC_DIR = path.join(import.meta.dirname, '..', '..', 'public');

/**
 * URL path to filename and content type. Adding an asset means adding a line
 * here, deliberately.
 */
const ASSETS = new Map([
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml' }],
  ['/favicon.ico', { file: 'favicon.svg', type: 'image/svg+xml' }],
]);

/**
 * Cache of file contents and their ETags.
 *
 * These files never change while the process runs (a deploy restarts the
 * service), so reading each once keeps every page load off the disk. The ETag is
 * a hash of the content, so a client revalidating gets a cheap 304.
 *
 * @type {Map<string, {body: Buffer, etag: string, type: string}>}
 */
const cache = new Map();

/**
 * @param {string} urlPath
 * @returns {{body: Buffer, etag: string, type: string}|null}
 */
function load(urlPath) {
  const cached = cache.get(urlPath);
  if (cached) return cached;

  const asset = ASSETS.get(urlPath);
  if (!asset) return null;

  const fullPath = path.join(PUBLIC_DIR, asset.file);

  // Belt and braces: the map above cannot express a traversal, but assert the
  // resolved path is still inside PUBLIC_DIR so a future edit cannot introduce
  // one silently.
  if (!path.resolve(fullPath).startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    return null;
  }

  let body;
  try {
    body = fs.readFileSync(fullPath);
  } catch {
    return null;
  }

  const etag = `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
  const entry = { body, etag, type: asset.type };
  cache.set(urlPath, entry);
  return entry;
}

/**
 * @param {import('hono').Hono} app
 */
export function registerAssetRoutes(app) {
  for (const urlPath of ASSETS.keys()) {
    app.get(urlPath, (c) => {
      const asset = load(urlPath);
      if (!asset) return c.notFound();

      // A matching ETag means the browser already has it.
      if (c.req.header('if-none-match') === asset.etag) {
        return c.body(null, 304, { ETag: asset.etag });
      }

      return c.body(asset.body, 200, {
        'Content-Type': asset.type,
        ETag: asset.etag,
        // Short max-age with must-revalidate rather than a long immutable
        // cache: these filenames are not content-hashed, so a long cache would
        // strand users on stale CSS after a deploy.
        'Cache-Control': 'public, max-age=300, must-revalidate',
      });
    });
  }
}

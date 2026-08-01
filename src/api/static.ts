/**
 * Static file serving for the web UI.
 *
 * The UI is three files with no build step, so this is deliberately the smallest
 * thing that can serve them correctly rather than a general-purpose file server:
 * an allow-list of extensions, a resolved-path containment check, and nothing
 * else. It exists so that one process and one port serve both the API and the
 * page that reads it — the deployment already routes a single origin through
 * Traefik, and a second container to serve three static files would be worse in
 * every direction.
 *
 * Anything outside `root`, or with an extension not in the allow-list, is a miss
 * and falls through to the API's own 404. There is no directory listing and no
 * traversal escape: the resolved path is checked against the resolved root, so
 * `..`, symlinks, and encoded separators all fail the same way.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * The page is a hash-routed SPA, so every route is `index.html`. Caching it is
 * how a deploy ships stale JavaScript to everyone who visited yesterday; the
 * assets beside it are small enough that revalidating them costs nothing worth
 * measuring.
 */
const CACHE = 'no-cache';

export function createStatic(root: string) {
  const base = resolve(root);

  return async function serveStatic(pathname: string, res: ServerResponse, head: boolean): Promise<boolean> {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false; // malformed escape: not our file, and not worth guessing at
    }
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel === '') rel = '/index.html';

    const ext = extname(rel).toLowerCase();
    const type = TYPES[ext];
    if (!type) return false;

    const file = resolve(join(base, rel));
    // Containment, not string matching: `base + '/../evil'` resolves out and is
    // rejected here rather than by hoping the URL never contained a `..`.
    if (file !== base && !file.startsWith(base + sep)) return false;

    let size: number;
    try {
      const s = await stat(file);
      if (!s.isFile()) return false;
      size = s.size;
    } catch {
      return false;
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': size,
      'cache-control': CACHE,
      // The page reads the same origin, but the API is already open to everyone
      // and the assets are public files; there is nothing here to protect.
      'x-content-type-options': 'nosniff',
    });
    if (head) {
      res.end();
      return true;
    }

    await new Promise<void>((done) => {
      const stream = createReadStream(file);
      stream.on('error', () => {
        res.destroy();
        done();
      });
      stream.on('close', done);
      stream.pipe(res);
    });
    return true;
  };
}

export type StaticHandler = ReturnType<typeof createStatic>;

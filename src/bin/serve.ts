/**
 * Fiber Atlas API server.
 *
 *   node --experimental-sqlite src/bin/serve.ts
 *
 * Serves every network whose database exists, side by side. A network with no
 * database is skipped with a warning rather than faked — an endpoint that answers
 * confidently from an empty store is worse than one that is absent.
 *
 * Env: PORT (8080), HOST (0.0.0.0), FIBER_ATLAS_DB_DIR (./data).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../db.ts';
import { createApi, type NetworkStore } from '../api/server.ts';
import { NETWORKS } from '../config.ts';

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';
const dir = process.env['FIBER_ATLAS_DB_DIR'] ?? './data';

const networks: NetworkStore[] = [];
const pending: string[] = [];
for (const name of Object.keys(NETWORKS)) {
  const path = join(dir, `fiber-atlas.${name}.db`);
  if (!existsSync(path)) {
    pending.push(name);
    console.warn(`${name}: no database yet at ${path} — not served until the scan creates it`);
    continue;
  }
  // Read-only: the API shares these files with the scanner and ingest, and has no
  // business writing to them. Enforced by SQLite rather than by discipline.
  networks.push({ name, store: new Store(path, { readOnly: true }) });
  console.log(`serving ${name}  <- ${path}`);
}

// Come up regardless. On a fresh deployment the API starts alongside the scanners
// that produce its data, so exiting here means restart-looping for the whole
// backfill — hours on testnet — and no /health to show progress against. Serving
// nothing while saying so is strictly better than being absent; requests for a
// network with no database get an honest 503, never an empty-but-confident answer.
if (networks.length === 0) {
  console.warn(`no databases in ${dir} yet. Serving /health only until a scan produces one.`);
}

const server = createApi(networks, { pending });
server.listen(port, host, () => {
  console.log(`fiber-atlas api on http://${host}:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      for (const n of networks) n.store.close();
      process.exit(0);
    });
  });
}

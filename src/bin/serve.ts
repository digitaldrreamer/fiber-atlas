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
for (const name of Object.keys(NETWORKS)) {
  const path = join(dir, `fiber-atlas.${name}.db`);
  if (!existsSync(path)) {
    console.warn(`skipping ${name}: no database at ${path}`);
    continue;
  }
  // Read-only: the API shares these files with the scanner and ingest, and has no
  // business writing to them. Enforced by SQLite rather than by discipline.
  networks.push({ name, store: new Store(path, { readOnly: true }) });
  console.log(`serving ${name}  <- ${path}`);
}

if (networks.length === 0) {
  console.error(`no databases found in ${dir}. Run a scan first (npm run scan).`);
  process.exit(1);
}

const server = createApi(networks);
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

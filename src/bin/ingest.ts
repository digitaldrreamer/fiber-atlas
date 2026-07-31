/**
 * Atlas gossip ingest CLI.
 *
 *   node --experimental-sqlite src/bin/ingest.ts [--watch] [--interval 60]
 *
 * Env: FIBER_RPC_URL (default http://127.0.0.1:8227), plus the usual FIBER_ATLAS_DB.
 *
 * Requires a local fnn node synced to gossip. There is no public Fiber RPC to point
 * at: fnn binds to localhost and refuses a public interface without auth.
 */

import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { Store } from '../db.ts';
import { FiberRpc } from '../atlas/graph.ts';
import { ingestGraph } from '../atlas/ingest.ts';
import { sleep } from '../ckb/rpc.ts';

const { values } = parseArgs({
  options: {
    watch: { type: 'boolean', default: false },
    interval: { type: 'string', default: '60' },
  },
});

const cfg = loadConfig();
const fiberUrl = process.env['FIBER_RPC_URL'] ?? 'http://127.0.0.1:8227';
const rpc = new FiberRpc(fiberUrl);
const store = new Store(cfg.dbPath);

console.log(`fiber rpc  ${fiberUrl}`);
console.log(`db         ${cfg.dbPath}\n`);

async function once(): Promise<void> {
  const t0 = Date.now();
  const r = await ingestGraph(rpc, store);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `nodes=${r.nodes} channels=${r.channels} ` +
      `directions(with_update=${r.directionsWithUpdate} missing=${r.directionsMissing}) ` +
      `malformed_outpoints=${r.malformedOutpoints} in ${secs}s`,
  );
  if (r.malformedOutpoints > 0) {
    console.log(`  WARNING: ${r.malformedOutpoints} channel_outpoint(s) failed to parse.`);
  }

  // Join integrity (A+05): do gossip channels line up with L1 funding cells?
  const j = store.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM channel WHERE node1_pubkey IS NOT NULL) AS gossip,
         (SELECT COUNT(*) FROM channel WHERE open_tx_hash IS NOT NULL) AS l1,
         (SELECT COUNT(*) FROM channel WHERE node1_pubkey IS NOT NULL AND open_tx_hash IS NOT NULL) AS both`,
    )
    .get() as { gossip: number; l1: number; both: number };
  const pct = j.gossip === 0 ? 'n/a' : `${((j.both / j.gossip) * 100).toFixed(1)}%`;
  console.log(`  join: gossip=${j.gossip} l1=${j.l1} overlap=${j.both} (${pct} of gossip channels seen on L1)`);
}

try {
  if (values.watch) {
    const interval = Number(values.interval) * 1000;
    console.log(`watching every ${values.interval}s (ctrl-c to stop)\n`);
    for (;;) {
      await once();
      await sleep(interval);
    }
  } else {
    await once();
  }
} catch (err) {
  console.error(`ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (!values.watch) store.close();
}

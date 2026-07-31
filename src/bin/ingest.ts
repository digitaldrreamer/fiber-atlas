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

/**
 * Peer count is a hard health gate, not a statistic.
 *
 * An fnn node with zero peers keeps answering `graph_channels` from whatever it
 * synced before its connections went away. Nothing errors, the node logs nothing,
 * and every derived metric computes cleanly over a stale subgraph. The join rate is
 * measured *against gossip*, so a truncated graph silently flatters it — a node
 * isolated by a version mismatch reported 43% while seeing a fifth of the network.
 * See plan.md §1.2.
 */
async function peerCount(): Promise<number> {
  const res = await rpc.call<{ peers: unknown[] }>('list_peers', []);
  return res.peers?.length ?? 0;
}

async function once(): Promise<void> {
  const t0 = Date.now();
  const peers = await peerCount();
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

  if (peers === 0) {
    console.log(`  peers=0 — NODE IS ISOLATED. Gossip is stale; join rate suppressed.`);
    console.log(`  Check the fnn version against the network: the version distribution in`);
    console.log(`  graph_nodes is authoritative, releases/latest is not (plan.md §1.2).`);
    return;
  }

  // Both directions, always. They answer different questions and only the second
  // bounds attribution; reporting the first alone overstates coverage by more than
  // an order of magnitude (SPEC-FAULTLINE §2.3).
  const fwd = j.gossip === 0 ? 'n/a' : `${((j.both / j.gossip) * 100).toFixed(1)}%`;
  const rev = j.l1 === 0 ? 'n/a' : `${((j.both / j.l1) * 100).toFixed(1)}%`;
  console.log(`  peers=${peers}  gossip=${j.gossip} l1=${j.l1} overlap=${j.both}`);
  console.log(`    gossip->L1 ${fwd}  (join integrity; converges to ~100%)`);
  console.log(`    L1->gossip ${rev}  (channel population that is public)`);

  // The channel ratio above is not the coverage figure — most L1 channels closed
  // before we ever synced. What a consumer can act on is the share of *events* that
  // name a node pair, which only grows as we keep observing (SPEC-FAULTLINE §2.3).
  const e = store.db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(attribution = 'node_pair') AS np FROM event_attributed`,
    )
    .get() as { n: number; np: number };
  const cov = e.n === 0 ? 'n/a' : `${((e.np / e.n) * 100).toFixed(2)}%`;
  console.log(`    events node-attributed ${e.np}/${e.n} = ${cov}  <- PUBLISHED COVERAGE`);
}

try {
  if (values.watch) {
    const interval = Number(values.interval) * 1000;
    console.log(`watching every ${values.interval}s (ctrl-c to stop)\n`);
    for (;;) {
      // A watcher that exits on the first transient error is not a watcher. The node
      // restarts, the network drops — the loop must outlive both.
      try {
        await once();
      } catch (err) {
        console.error(`  ingest pass failed (retrying next tick): ${err instanceof Error ? err.message : String(err)}`);
      }
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

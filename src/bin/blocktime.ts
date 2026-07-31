/**
 * Block-time backfill.
 *
 *   node --experimental-sqlite src/bin/blocktime.ts [--watch] [--interval 600]
 *
 * Env: FIBER_NETWORK, CKB_RPC_URL, FIBER_ATLAS_DB, BLOCKTIME_BATCH (100).
 *
 * Faultline records block numbers. Nothing else in the archive carries wall-clock
 * time, so without this pass every date in the API would have to be estimated from
 * block height — and an estimate presented as a timestamp is the failure mode this
 * project exists to avoid. Each row here is a header the chain returned.
 *
 * Resumable by construction: the work list is "referenced blocks with no row yet",
 * recomputed each pass. Interrupt it anywhere and it picks up where it stopped; run
 * it after every scan and it fetches only the newly-referenced blocks.
 */

import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { CkbRpc, mapPool, sleep, type Header } from '../ckb/rpc.ts';
import { Store } from '../db.ts';

const { values } = parseArgs({
  options: {
    watch: { type: 'boolean', default: false },
    interval: { type: 'string', default: '600' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`fiber-atlas block-time backfill

  --watch          keep running, re-checking for newly referenced blocks
  --interval SECS  seconds between passes when watching (default 600)
`);
  process.exit(0);
}

const cfg = loadConfig();
const rpc = new CkbRpc(cfg.ckbRpcUrl);
const store = new Store(cfg.dbPath);

// Bounded so an interrupted pass loses at most one chunk of work, and so the
// missing-blocks query — a UNION over the whole archive — is not re-run per block.
const CHUNK = 5_000;
const BATCH = Number(process.env['BLOCKTIME_BATCH'] ?? 100);

console.log(`network   ${cfg.name}`);
console.log(`ckb rpc   ${cfg.ckbRpcUrl}`);
console.log(`db        ${cfg.dbPath}\n`);

const batched = await rpc.supportsBatch();
console.log(
  batched
    ? `batching  ${BATCH} headers per request`
    : `batching  UNSUPPORTED by this endpoint — falling back to one request per header`,
);

/** Fetch headers for one chunk, batched if the endpoint allows it. */
async function fetchTimes(blocks: readonly number[]): Promise<{ blockNumber: number; timestampMs: number }[]> {
  const out: { blockNumber: number; timestampMs: number }[] = [];

  const take = (n: number, h: Header | null) => {
    // A referenced block with no header is not a normal condition — it means the
    // endpoint is on a different chain or behind our own archive. Skipping it leaves
    // the row absent, which the API renders as "unknown", so it stays honest; the
    // count is reported so it cannot pass unnoticed.
    if (h) out.push({ blockNumber: n, timestampMs: Number(BigInt(h.timestamp)) });
  };

  if (batched) {
    const groups: number[][] = [];
    for (let i = 0; i < blocks.length; i += BATCH) groups.push(blocks.slice(i, i + BATCH));
    await mapPool(groups, cfg.concurrency, async (group) => {
      const headers = await rpc.getHeadersByNumber(group);
      group.forEach((n, i) => take(n, headers[i] ?? null));
    });
  } else {
    await mapPool(blocks, cfg.concurrency, async (n) => take(n, await rpc.getHeaderByNumber(n)));
  }
  return out;
}

async function once(): Promise<void> {
  const start = store.blockTimeCoverage();
  if (start.referenced === start.resolved) {
    console.log(`all ${start.referenced} referenced blocks already timed.`);
    return;
  }
  console.log(
    `${start.resolved}/${start.referenced} blocks timed — fetching ${start.referenced - start.resolved}`,
  );

  const t0 = Date.now();
  let done = 0;
  let missing = 0;
  for (;;) {
    const blocks = store.blocksMissingTime(CHUNK);
    if (blocks.length === 0) break;
    const rows = await fetchTimes(blocks);
    store.putBlockTimes(rows);
    missing += blocks.length - rows.length;
    done += blocks.length;

    // Guard against a spin: if a chunk yields nothing storable, the same blocks come
    // back next iteration forever. Stop and say so rather than loop silently.
    if (rows.length === 0) {
      console.log(`\n  ${blocks.length} blocks returned no header — stopping this pass.`);
      break;
    }
    const rate = done / ((Date.now() - t0) / 1000);
    process.stdout.write(`  ${done} fetched  (${rate.toFixed(0)}/s)\r`);
  }

  const end = store.blockTimeCoverage();
  const pct = end.referenced ? ((end.resolved / end.referenced) * 100).toFixed(2) : 'n/a';
  console.log(`\ncoverage  ${end.resolved}/${end.referenced} = ${pct}%  in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (missing > 0) console.log(`  WARNING: ${missing} referenced block(s) returned no header.`);
}

try {
  if (values.watch) {
    const interval = Number(values.interval) * 1000;
    console.log(`watching every ${values.interval}s (ctrl-c to stop)\n`);
    for (;;) {
      try {
        await once();
      } catch (err) {
        console.error(`  pass failed (retrying next tick): ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(interval);
    }
  } else {
    await once();
  }
} catch (err) {
  console.error(`blocktime failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  if (!values.watch) store.close();
}

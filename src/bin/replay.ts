/**
 * Re-derive every event from the local archive. No network access.
 *
 * This is what the archive buys: a classification rule can change, or a later phase
 * can need a field this one did not extract, without re-crawling ~190k transactions
 * against a third-party endpoint. Replay drops the derived tables and rebuilds them
 * from `raw_tx` + `scan_hit`.
 *
 *   node --experimental-sqlite src/bin/replay.ts
 */

import { loadConfig } from '../config.ts';
import { CkbRpc } from '../ckb/rpc.ts';
import { Store } from '../db.ts';
import { FaultlineScanner, type ScanProgress } from '../faultline/scanner.ts';

const cfg = loadConfig();
const store = new Store(cfg.dbPath);

// A replay must not be able to reach the network: if the archive is incomplete, that
// should surface as a missing transaction, not as a silent background crawl.
const offline = new CkbRpc('http://127.0.0.1:0/', { retries: 0, timeoutMs: 1 });
const scanner = new FaultlineScanner(offline, store, cfg, 1);

const archive = store.archiveStats();
if (archive.txs === 0) {
  console.error('archive is empty — run `npm run scan` first.');
  process.exit(1);
}

console.log(`replaying from archive: ${archive.txs.toLocaleString()} txs, ` +
  `${archive.hits.toLocaleString()} indexer hits, ${(archive.bytes / 1e6).toFixed(1)} MB\n`);

const blank = (pass: 'funding' | 'commitment'): ScanProgress => ({
  pass,
  pagesDone: 0,
  txsSeen: 0,
  opens: 0,
  closes: 0,
  penalties: 0,
  settlements: 0,
  unclassified: 0,
});

const keys = scanner.scanKeys();
store.resetDerived();

const funding = blank('funding');
const f = scanner.archivedRows(keys.funding);
scanner.processFundingRows(f.rows, f.txs, funding);
console.log(`funding-lock    txs=${funding.txsSeen} opens=${funding.opens} closes=${funding.closes}`);

const commitment = blank('commitment');
const c = scanner.archivedRows(keys.commitment);
scanner.processCommitmentRows(c.rows, c.txs, commitment);
console.log(
  `commitment-lock txs=${commitment.txsSeen} penalties=${commitment.penalties} ` +
    `settlements=${commitment.settlements} unclassified=${commitment.unclassified}`,
);

const reattributed = store.reconcileAttribution();
console.log(`\nreconciled attribution for ${reattributed} event(s)`);

const missing = c.txs.filter((t) => t === null).length + f.txs.filter((t) => t === null).length;
if (missing > 0) {
  console.log(`\nWARNING: ${missing} archived indexer hit(s) have no archived transaction.`);
  console.log('The archive is incomplete — re-run `npm run scan` to fill the gaps.');
}

console.log('\nrun `npm run stats` for the breakdown.');
store.close();

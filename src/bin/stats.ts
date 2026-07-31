/**
 * Report what the scan actually found.
 *
 * The class distribution here is the first novel output of the project: it is not
 * published anywhere, and it is what the reliability model in SPEC-FAULTLINE §4 has
 * to be calibrated against.
 */

import { loadConfig } from '../config.ts';
import { Store } from '../db.ts';

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const q = <T>(sql: string): T[] => store.db.prepare(sql).all() as T[];
const one = <T>(sql: string): T => store.db.prepare(sql).get() as T;

const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1)}%`);

console.log(`\nfiber-atlas — faultline scan results (${cfg.name})\n${'='.repeat(52)}\n`);

const ch = one<{ total: number; open: number; closed: number; coop: number; force: number }>(`
  SELECT COUNT(*) AS total,
         SUM(close_kind IS NULL) AS open,
         SUM(close_kind IS NOT NULL) AS closed,
         SUM(close_kind = 'cooperative') AS coop,
         SUM(close_kind = 'force_close') AS force
  FROM channel`);

console.log('CHANNELS');
console.log(`  known                ${ch.total}`);
console.log(`  still open           ${ch.open}`);
console.log(`  closed               ${ch.closed}`);
if (ch.closed > 0) {
  console.log(`    cooperative        ${ch.coop}  (${pct(ch.coop, ch.closed)} of closes)`);
  console.log(`    force-close        ${ch.force}  (${pct(ch.force, ch.closed)} of closes)`);
}

const cc = one<{ total: number; spent: number; penalty: number; settlement: number; unk: number }>(`
  SELECT COUNT(*) AS total,
         SUM(spend_tx_hash IS NOT NULL) AS spent,
         SUM(spend_kind = 'penalty') AS penalty,
         SUM(spend_kind = 'settlement') AS settlement,
         SUM(spend_tx_hash IS NOT NULL AND spend_kind IS NULL) AS unk
  FROM commitment_cell`);

console.log('\nCOMMITMENT CELLS (force-close products)');
console.log(`  seen                 ${cc.total}`);
console.log(`  unspent              ${cc.total - cc.spent}`);
console.log(`  spent                ${cc.spent}`);
if (cc.spent > 0) {
  console.log(`    settlement         ${cc.settlement}  (${pct(cc.settlement, cc.spent)})`);
  console.log(`    PENALTY            ${cc.penalty}  (${pct(cc.penalty, cc.spent)})`);
  if (cc.unk) console.log(`    unclassified       ${cc.unk}`);
}

console.log('\nEVENT FEED');
for (const r of q<{ kind: string; n: number; attributed: number }>(`
  SELECT kind, COUNT(*) AS n, SUM(channel_outpoint IS NOT NULL) AS attributed
  FROM event GROUP BY kind ORDER BY n DESC`)) {
  console.log(`  ${r.kind.padEnd(20)} ${String(r.n).padStart(6)}   attributed ${pct(r.attributed, r.n)}`);
}

// The join hit rate bounds Faultline's real coverage (SPEC-FAULTLINE §2.3) and is a
// published metric, not an internal detail. At this phase it is channel-level only;
// node-level attribution arrives with the gossip graph in Phase 3.
const ev = one<{ n: number; attributed: number }>(
  'SELECT COUNT(*) AS n, SUM(channel_outpoint IS NOT NULL) AS attributed FROM event',
);
console.log(`\n  total events         ${ev.n}`);
console.log(`  channel-attributed   ${ev.attributed}  (${pct(ev.attributed, ev.n)})`);
console.log(`  quarantined          ${ev.n - ev.attributed}  (retained, never dropped — F+04)`);

if (cc.penalty > 0) {
  console.log('\nPENALTIES (provable misbehaviour — strongest negative signal)');
  for (const p of q<{ tx: string; b: number; ch: string | null }>(`
    SELECT tx_hash AS tx, block_number AS b, channel_outpoint AS ch
    FROM event WHERE kind = 'penalty' ORDER BY block_number DESC LIMIT 10`)) {
    console.log(`  block ${p.b}  ${p.tx.slice(0, 20)}..  channel ${p.ch ? p.ch.slice(0, 20) + '..' : 'UNATTRIBUTED'}`);
  }
}

const blocks = one<{ lo: number | null; hi: number | null }>(
  'SELECT MIN(block_number) AS lo, MAX(block_number) AS hi FROM event',
);
if (blocks.lo !== null) console.log(`\nblock range covered   ${blocks.lo} .. ${blocks.hi}`);

console.log();
store.close();

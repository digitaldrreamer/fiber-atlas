/**
 * Faultline L1 scanner CLI.
 *
 *   node --experimental-sqlite src/bin/scan.ts [--pages N] [--restart]
 *
 * Env: FIBER_NETWORK (testnet|mainnet), CKB_RPC_URL, FIBER_ATLAS_DB, SCAN_CONCURRENCY
 */

import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { CkbRpc } from '../ckb/rpc.ts';
import { Store } from '../db.ts';
import { FaultlineScanner, type ScanProgress } from '../faultline/scanner.ts';

const { values } = parseArgs({
  options: {
    pages: { type: 'string' },
    restart: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(`fiber-atlas faultline scanner

  --pages N   stop after N pages per pass (default: run to the chain tip)
  --restart   ignore the stored cursor and rescan from genesis
`);
  process.exit(0);
}

const cfg = loadConfig();
const rpc = new CkbRpc(cfg.ckbRpcUrl);
const store = new Store(cfg.dbPath);

console.log(`network   ${cfg.name}`);
console.log(`ckb rpc   ${cfg.ckbRpcUrl}`);
console.log(`db        ${cfg.dbPath}`);
console.log(`funding   ${cfg.fundingLockCodeHash}`);
console.log(`commit    ${cfg.commitmentLockCodeHash}\n`);

const scanner = new FaultlineScanner(rpc, store, cfg);

const report = (p: ScanProgress) => {
  const bits = [`pages ${p.pagesDone}`, `txs ${p.txsSeen}`];
  if (p.pass === 'funding') bits.push(`opens ${p.opens}`, `closes ${p.closes}`);
  else bits.push(`penalties ${p.penalties}`, `settlements ${p.settlements}`);
  if (p.unclassified) bits.push(`unclassified ${p.unclassified}`);
  process.stdout.write(`  [${p.pass}] ${bits.join('  ')}\r`);
};

try {
  console.log('preflight: verifying the configured code hashes actually index...');
  await scanner.preflight();
  console.log('preflight: ok\n');

  const opts = {
    ...(values.pages ? { maxPages: Number(values.pages) } : {}),
    restart: values.restart ?? false,
    onProgress: report,
  };

  const [funding, commitment] = await scanner.scanAll(opts);
  process.stdout.write('\n');

  const reattributed = store.reconcileAttribution();
  if (reattributed > 0) console.log(`\nreconciled attribution for ${reattributed} event(s)`);
  console.log(
    `\nfunding-lock pass    txs=${funding!.txsSeen} opens=${funding!.opens} closes=${funding!.closes}`,
  );
  console.log(
    `commitment-lock pass txs=${commitment!.txsSeen} penalties=${commitment!.penalties} ` +
      `settlements=${commitment!.settlements} unclassified=${commitment!.unclassified}`,
  );
  console.log('\nrun `npm run stats` for the classification breakdown.');
} catch (err) {
  process.stdout.write('\n');
  console.error(`scan failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  store.close();
}

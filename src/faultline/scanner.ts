/**
 * Faultline L1 scanner — SPEC-FAULTLINE.md §2.
 *
 * Detection is independent of the gossip graph (§2.3): scanning by lock code hash
 * finds closes and penalties network-wide with no Fiber node running. Attribution to
 * nodes needs the graph and arrives in Phase 3.
 *
 * Two passes, each independently resumable via a persisted indexer cursor:
 *   1. funding-lock  — outputs open channels, inputs close them (classified here)
 *   2. commitment-lock — outputs are force-close products, inputs are penalty/settlement
 */

import { CkbRpc, mapPool, type GroupedTx, type SearchKey, type Transaction } from '../ckb/rpc.ts';
import type { Store } from '../db.ts';
import { classifyClose, classifyCommitmentSpend, outPointKey } from './classify.ts';
import type { NetworkConfig } from '../config.ts';

const PAGE_LIMIT = 200;

export interface ScanProgress {
  pass: 'funding' | 'commitment';
  pagesDone: number;
  txsSeen: number;
  opens: number;
  closes: number;
  penalties: number;
  settlements: number;
  unclassified: number;
}

export interface ScanOptions {
  /** Stop after this many pages per pass (a full backfill is unbounded). */
  maxPages?: number;
  /** Ignore any stored cursor and rescan from the start. */
  restart?: boolean;
  onProgress?: (p: ScanProgress) => void;
}

export class FaultlineScanner {
  readonly #rpc: CkbRpc;
  readonly #store: Store;
  readonly #cfg: NetworkConfig;

  constructor(rpc: CkbRpc, store: Store, cfg: NetworkConfig) {
    this.#rpc = rpc;
    this.#store = store;
    this.#cfg = cfg;
  }

  #searchKey(codeHash: string): SearchKey {
    return {
      script: { code_hash: codeHash, hash_type: 'type', args: '0x' },
      script_type: 'lock',
      script_search_mode: 'prefix',
      group_by_transaction: true,
    };
  }

  /**
   * A configured-but-wrong code hash returns an empty result set, which reads exactly
   * like a quiet network. SPEC-FAULTLINE §2.1 requires treating that as a
   * configuration failure until proven otherwise, so the first page is checked
   * explicitly rather than being allowed to no-op.
   */
  async preflight(): Promise<void> {
    for (const [label, hash] of [
      ['funding-lock', this.#cfg.fundingLockCodeHash],
      ['commitment-lock', this.#cfg.commitmentLockCodeHash],
    ] as const) {
      const page = await this.#rpc.getTransactionsPage(this.#searchKey(hash), 'asc', 1);
      if (page.objects.length === 0) {
        throw new Error(
          `preflight failed: no transactions found for ${label} on ${this.#cfg.name} ` +
            `(code_hash ${hash}). Either the network config is wrong or the RPC is not indexing. ` +
            `An empty scan is a configuration failure, not evidence of a quiet network.`,
        );
      }
    }
  }

  async scanAll(opts: ScanOptions = {}): Promise<ScanProgress[]> {
    return [await this.scanFundingLock(opts), await this.scanCommitmentLock(opts)];
  }

  /** Pass 1: channel opens and closes. */
  async scanFundingLock(opts: ScanOptions = {}): Promise<ScanProgress> {
    const scanKey = `${this.#cfg.name}:funding_lock`;
    const progress: ScanProgress = {
      pass: 'funding',
      pagesDone: 0,
      txsSeen: 0,
      opens: 0,
      closes: 0,
      penalties: 0,
      settlements: 0,
      unclassified: 0,
    };

    await this.#eachPage(scanKey, this.#cfg.fundingLockCodeHash, opts, async (rows) => {
      const txs = await this.#fetchTxs(rows, opts);
      this.#store.transaction(() => {
        for (const [i, row] of rows.entries()) {
          const tx = txs[i];
          if (!tx) continue;
          progress.txsSeen++;
          const block = Number(row.block_number);

          for (const [ioType, ioIndexHex] of row.cells) {
            const ioIndex = Number(ioIndexHex);

            if (ioType === 'output') {
              // A funding cell was created: a channel opened.
              const out = tx.outputs[ioIndex];
              if (!out) continue;
              this.#store.upsertChannelOpen({
                channel_outpoint: outPointKey(row.tx_hash, ioIndex),
                open_tx_hash: row.tx_hash,
                open_block: block,
                capacity: out.capacity,
                udt_type_script: out.type ? JSON.stringify(out.type) : null,
                funding_lock_args: out.lock.args,
              });
              progress.opens++;
            } else {
              // A funding cell was spent: the channel closed.
              const input = tx.inputs[ioIndex];
              if (!input) continue;
              const channelOutpoint = outPointKey(
                input.previous_output.tx_hash,
                Number(input.previous_output.index),
              );
              const { kind, commitmentOutputIndices } = classifyClose(
                tx,
                this.#cfg.commitmentLockCodeHash,
              );

              this.#store.upsertChannelClose({
                channel_outpoint: channelOutpoint,
                close_tx_hash: row.tx_hash,
                close_block: block,
                close_kind: kind,
              });

              // A force close creates its commitment cells in the very same tx that
              // spends the funding cell. Recording the link here is what later gives
              // penalties channel-level attribution without a heuristic.
              for (const outIdx of commitmentOutputIndices) {
                const out = tx.outputs[outIdx];
                if (!out) continue;
                this.#store.upsertCommitmentCreated({
                  commitment_outpoint: outPointKey(row.tx_hash, outIdx),
                  channel_outpoint: channelOutpoint,
                  created_tx_hash: row.tx_hash,
                  created_block: block,
                  capacity: out.capacity,
                  lock_args: out.lock.args,
                });
              }

              this.#store.insertEvent({
                kind: kind === 'force_close' ? 'force_close' : 'cooperative_close',
                block_number: block,
                tx_hash: row.tx_hash,
                channel_outpoint: channelOutpoint,
                detail: { commitment_outputs: commitmentOutputIndices.length },
              });
              progress.closes++;
            }
          }
        }
      });
      progress.pagesDone++;
      opts.onProgress?.(progress);
    });

    return progress;
  }

  /** Pass 2: penalties and settlements against commitment cells. */
  async scanCommitmentLock(opts: ScanOptions = {}): Promise<ScanProgress> {
    const scanKey = `${this.#cfg.name}:commitment_lock`;
    const progress: ScanProgress = {
      pass: 'commitment',
      pagesDone: 0,
      txsSeen: 0,
      opens: 0,
      closes: 0,
      penalties: 0,
      settlements: 0,
      unclassified: 0,
    };

    await this.#eachPage(scanKey, this.#cfg.commitmentLockCodeHash, opts, async (rows) => {
      const txs = await this.#fetchTxs(rows, opts);
      this.#store.transaction(() => {
        for (const [i, row] of rows.entries()) {
          const tx = txs[i];
          if (!tx) continue;
          progress.txsSeen++;
          const block = Number(row.block_number);

          for (const [ioType, ioIndexHex] of row.cells) {
            const ioIndex = Number(ioIndexHex);

            if (ioType === 'output') {
              // Usually already recorded by pass 1 (same tx spends the funding cell).
              // Recorded again here so a commitment cell created by a tx the funding
              // pass has not yet reached is still captured — the passes are independent.
              const out = tx.outputs[ioIndex];
              if (!out) continue;
              this.#store.upsertCommitmentCreated({
                commitment_outpoint: outPointKey(row.tx_hash, ioIndex),
                channel_outpoint: null,
                created_tx_hash: row.tx_hash,
                created_block: block,
                capacity: out.capacity,
                lock_args: out.lock.args,
              });
              continue;
            }

            const input = tx.inputs[ioIndex];
            if (!input) continue;
            const commitmentOutpoint = outPointKey(
              input.previous_output.tx_hash,
              Number(input.previous_output.index),
            );
            const spend = classifyCommitmentSpend(tx, ioIndex);

            this.#store.upsertCommitmentSpent({
              commitment_outpoint: commitmentOutpoint,
              spend_tx_hash: row.tx_hash,
              spend_block: block,
              spend_kind: spend?.kind ?? null,
              unlock_count: spend?.unlockCount ?? null,
              unclassified_reason: spend ? null : 'witness missing or malformed',
            });

            if (!spend) {
              progress.unclassified++;
              continue;
            }

            // Channel-level attribution comes free when the creating force-close is
            // known; otherwise the event is quarantined, not dropped (F+04).
            const channelOutpoint = this.#store.channelForCommitment(commitmentOutpoint);

            this.#store.insertEvent({
              kind: spend.kind,
              block_number: block,
              tx_hash: row.tx_hash,
              channel_outpoint: channelOutpoint,
              detail: { unlock_count: spend.unlockCount, commitment_outpoint: commitmentOutpoint },
            });

            if (spend.kind === 'penalty') progress.penalties++;
            else progress.settlements++;
          }
        }
      });
      progress.pagesDone++;
      opts.onProgress?.(progress);
    });

    return progress;
  }

  /** Paginate `get_transactions` in ascending order, persisting the cursor per page. */
  async #eachPage(
    scanKey: string,
    codeHash: string,
    opts: ScanOptions,
    handle: (rows: GroupedTx[]) => Promise<void>,
  ): Promise<void> {
    const searchKey = this.#searchKey(codeHash);
    let cursor = opts.restart ? null : this.#store.getCursor(scanKey);
    let pages = 0;

    for (;;) {
      if (opts.maxPages !== undefined && pages >= opts.maxPages) return;
      const page = await this.#rpc.getTransactionsPage(
        searchKey,
        'asc',
        PAGE_LIMIT,
        cursor ?? undefined,
      );
      if (page.objects.length === 0) return;

      await handle(page.objects);

      // Persisted only after the page is durably applied, so a crash re-does one
      // page rather than skipping it. Every write is idempotent, making that safe.
      cursor = page.last_cursor;
      this.#store.setCursor(scanKey, cursor);
      pages++;

      if (page.objects.length < PAGE_LIMIT) return;
    }
  }

  #fetchTxs(rows: GroupedTx[], opts: ScanOptions): Promise<(Transaction | null)[]> {
    void opts;
    return mapPool(rows, 8, (row) => this.#rpc.getTransaction(row.tx_hash));
  }
}

/**
 * SQLite store (node:sqlite — no native dependency).
 *
 * Phase 1 stores L1 facts only. Node-level attribution arrives in Phase 3, when the
 * gossip graph supplies `channel_outpoint -> {node1, node2}`; the schema leaves room
 * for it rather than pretending it exists.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ChannelRow {
  channel_outpoint: string;
  open_tx_hash: string | null;
  open_block: number | null;
  capacity: string | null;
  udt_type_script: string | null;
  close_tx_hash: string | null;
  close_block: number | null;
  close_kind: string | null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Resumable scan position, one row per (network, scanned script).
CREATE TABLE IF NOT EXISTS scan_cursor (
  scan_key    TEXT PRIMARY KEY,
  last_cursor TEXT,
  tip_seen    INTEGER,
  updated_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Archive: the crawl is paid once, ever.
--
-- Enumerating and fetching the full history is ~190k RPC round-trips against a
-- third-party endpoint. Storing only derived fields would mean any later change to
-- a classification rule, or any field a future phase needs and this one did not
-- anticipate, forces the whole crawl again. So both halves of the network's answer
-- are archived verbatim:
--   raw_tx    — the transaction as returned
--   scan_hit  — the indexer's grouping (io_type/io_index), which is NOT derivable
--               from the transaction alone and would otherwise be unrecoverable
-- Together these make re-classification a local replay. See bin/replay.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_tx (
  tx_hash    TEXT PRIMARY KEY,
  tx_json    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- The key includes cells_json, NOT just (scan_key, tx_hash). The indexer iterates by
-- script args, so a transaction that touches two cells with different args is
-- returned once per args — commonly as [["output","0x0"]] and [["input","0x0"]]
-- separately. Keying on tx_hash alone silently discards the second hit, which on
-- testnet loses ~⅓ of commitment-lock rows and with them the penalties they carry.
CREATE TABLE IF NOT EXISTS scan_hit (
  scan_key     TEXT NOT NULL,
  tx_hash      TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  cells_json   TEXT NOT NULL,
  PRIMARY KEY (scan_key, tx_hash, cells_json)
);
CREATE INDEX IF NOT EXISTS idx_scan_hit_block ON scan_hit(scan_key, block_number);

-- A channel, keyed by its funding cell outpoint. This is the join key to the
-- gossip graph (SPEC-ATLAS §2.2) and the anchor for all attribution.
CREATE TABLE IF NOT EXISTS channel (
  channel_outpoint TEXT PRIMARY KEY,
  open_tx_hash     TEXT,
  open_block       INTEGER,
  capacity         TEXT,
  udt_type_script  TEXT,
  funding_lock_args TEXT,
  close_tx_hash    TEXT,
  close_block      INTEGER,
  close_kind       TEXT CHECK (close_kind IN ('cooperative','force_close') OR close_kind IS NULL),
  first_seen       INTEGER NOT NULL,
  last_seen        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_close ON channel(close_kind, close_block);

-- Commitment cells created by a force close, and how each was later spent.
CREATE TABLE IF NOT EXISTS commitment_cell (
  commitment_outpoint TEXT PRIMARY KEY,
  channel_outpoint    TEXT,
  created_tx_hash     TEXT NOT NULL,
  created_block       INTEGER,
  capacity            TEXT,
  lock_args           TEXT,
  spend_tx_hash       TEXT,
  spend_block         INTEGER,
  spend_kind          TEXT CHECK (spend_kind IN ('penalty','settlement') OR spend_kind IS NULL),
  unlock_count        INTEGER,
  unclassified_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_commitment_spend ON commitment_cell(spend_kind);
CREATE INDEX IF NOT EXISTS idx_commitment_channel ON commitment_cell(channel_outpoint);

-- Canonical chronological event feed (SPEC-FAULTLINE §6 /faultline/events).
-- channel_outpoint IS NULL means quarantined-but-retained (F+04): a real event we
-- could not tie to a channel. Never dropped.
CREATE TABLE IF NOT EXISTS event (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                   TEXT NOT NULL CHECK (kind IN ('cooperative_close','force_close','penalty','settlement')),
  block_number           INTEGER NOT NULL,
  tx_hash                TEXT NOT NULL,
  channel_outpoint       TEXT,
  attribution_confidence TEXT NOT NULL CHECK (attribution_confidence IN ('channel','unattributed')),
  detail                 TEXT,
  detected_at            INTEGER NOT NULL,
  UNIQUE (kind, tx_hash, channel_outpoint)
);
CREATE INDEX IF NOT EXISTS idx_event_block ON event(block_number);
CREATE INDEX IF NOT EXISTS idx_event_kind ON event(kind);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  getCursor(key: string): string | null {
    const row = this.db.prepare('SELECT last_cursor FROM scan_cursor WHERE scan_key = ?').get(key) as
      | { last_cursor: string | null }
      | undefined;
    return row?.last_cursor ?? null;
  }

  setCursor(key: string, cursor: string | null): void {
    this.db
      .prepare(
        `INSERT INTO scan_cursor (scan_key, last_cursor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(scan_key) DO UPDATE SET last_cursor = excluded.last_cursor, updated_at = excluded.updated_at`,
      )
      .run(key, cursor, Date.now());
  }

  getRawTx(txHash: string): string | null {
    const row = this.db.prepare('SELECT tx_json FROM raw_tx WHERE tx_hash = ?').get(txHash) as
      | { tx_json: string }
      | undefined;
    return row?.tx_json ?? null;
  }

  putRawTx(txHash: string, txJson: string): void {
    this.db
      .prepare(
        `INSERT INTO raw_tx (tx_hash, tx_json, fetched_at) VALUES (?,?,?)
         ON CONFLICT(tx_hash) DO NOTHING`,
      )
      .run(txHash, txJson, Date.now());
  }

  putScanHit(scanKey: string, txHash: string, blockNumber: number, cellsJson: string): void {
    this.db
      .prepare(
        `INSERT INTO scan_hit (scan_key, tx_hash, block_number, cells_json) VALUES (?,?,?,?)
         ON CONFLICT(scan_key, tx_hash, cells_json) DO NOTHING`,
      )
      .run(scanKey, txHash, blockNumber, cellsJson);
  }

  /** All archived indexer hits for a pass, in block order — the replay input. */
  scanHits(scanKey: string): { tx_hash: string; block_number: number; cells_json: string }[] {
    return this.db
      .prepare(
        'SELECT tx_hash, block_number, cells_json FROM scan_hit WHERE scan_key = ? ORDER BY block_number, tx_hash',
      )
      .all(scanKey) as { tx_hash: string; block_number: number; cells_json: string }[];
  }

  archiveStats(): { txs: number; hits: number; bytes: number } {
    const r = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM raw_tx) AS txs,
                (SELECT COUNT(*) FROM scan_hit) AS hits,
                (SELECT COALESCE(SUM(LENGTH(tx_json)), 0) FROM raw_tx) AS bytes`,
      )
      .get() as { txs: number; hits: number; bytes: number };
    return r;
  }

  /**
   * Drop everything derived from the archive, keeping the archive itself.
   * Replay rebuilds these from raw_tx + scan_hit with no network access.
   */
  resetDerived(): void {
    this.db.exec('DELETE FROM event; DELETE FROM commitment_cell; DELETE FROM channel;');
  }

  upsertChannelOpen(r: {
    channel_outpoint: string;
    open_tx_hash: string;
    open_block: number;
    capacity: string;
    udt_type_script: string | null;
    funding_lock_args: string;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO channel (channel_outpoint, open_tx_hash, open_block, capacity, udt_type_script,
                              funding_lock_args, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(channel_outpoint) DO UPDATE SET
           open_tx_hash = excluded.open_tx_hash,
           open_block = excluded.open_block,
           capacity = excluded.capacity,
           udt_type_script = excluded.udt_type_script,
           funding_lock_args = excluded.funding_lock_args,
           last_seen = excluded.last_seen`,
      )
      .run(
        r.channel_outpoint,
        r.open_tx_hash,
        r.open_block,
        r.capacity,
        r.udt_type_script,
        r.funding_lock_args,
        now,
        now,
      );
  }

  upsertChannelClose(r: {
    channel_outpoint: string;
    close_tx_hash: string;
    close_block: number;
    close_kind: string;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO channel (channel_outpoint, close_tx_hash, close_block, close_kind, first_seen, last_seen)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(channel_outpoint) DO UPDATE SET
           close_tx_hash = excluded.close_tx_hash,
           close_block = excluded.close_block,
           close_kind = excluded.close_kind,
           last_seen = excluded.last_seen`,
      )
      .run(r.channel_outpoint, r.close_tx_hash, r.close_block, r.close_kind, now, now);
  }

  upsertCommitmentCreated(r: {
    commitment_outpoint: string;
    channel_outpoint: string | null;
    created_tx_hash: string;
    created_block: number;
    capacity: string;
    lock_args: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO commitment_cell (commitment_outpoint, channel_outpoint, created_tx_hash,
                                      created_block, capacity, lock_args)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(commitment_outpoint) DO UPDATE SET
           channel_outpoint = COALESCE(excluded.channel_outpoint, commitment_cell.channel_outpoint),
           created_tx_hash = excluded.created_tx_hash,
           created_block = excluded.created_block,
           capacity = excluded.capacity,
           lock_args = excluded.lock_args`,
      )
      .run(
        r.commitment_outpoint,
        r.channel_outpoint,
        r.created_tx_hash,
        r.created_block,
        r.capacity,
        r.lock_args,
      );
  }

  upsertCommitmentSpent(r: {
    commitment_outpoint: string;
    spend_tx_hash: string;
    spend_block: number;
    spend_kind: string | null;
    unlock_count: number | null;
    unclassified_reason: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO commitment_cell (commitment_outpoint, created_tx_hash, spend_tx_hash, spend_block,
                                      spend_kind, unlock_count, unclassified_reason)
         VALUES (?, '', ?, ?, ?, ?, ?)
         ON CONFLICT(commitment_outpoint) DO UPDATE SET
           spend_tx_hash = excluded.spend_tx_hash,
           spend_block = excluded.spend_block,
           spend_kind = excluded.spend_kind,
           unlock_count = excluded.unlock_count,
           unclassified_reason = excluded.unclassified_reason`,
      )
      .run(
        r.commitment_outpoint,
        r.spend_tx_hash,
        r.spend_block,
        r.spend_kind,
        r.unlock_count,
        r.unclassified_reason,
      );
  }

  /** Resolve the channel a commitment cell belongs to, via the tx that created it. */
  channelForCommitment(commitmentOutpoint: string): string | null {
    const row = this.db
      .prepare('SELECT channel_outpoint FROM commitment_cell WHERE commitment_outpoint = ?')
      .get(commitmentOutpoint) as { channel_outpoint: string | null } | undefined;
    return row?.channel_outpoint ?? null;
  }

  insertEvent(r: {
    kind: string;
    block_number: number;
    tx_hash: string;
    channel_outpoint: string | null;
    detail?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO event (kind, block_number, tx_hash, channel_outpoint, attribution_confidence, detail, detected_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (kind, tx_hash, channel_outpoint) DO NOTHING`,
      )
      .run(
        r.kind,
        r.block_number,
        r.tx_hash,
        r.channel_outpoint,
        r.channel_outpoint ? 'channel' : 'unattributed',
        r.detail === undefined ? null : JSON.stringify(r.detail),
        Date.now(),
      );
  }

  /**
   * Re-derive channel attribution for commitment-cell events.
   *
   * The two scan passes are independent and progress at different rates, so a
   * penalty can be recorded before the force-close that created its commitment cell
   * has been seen. Attributing only at insert time would freeze those events as
   * unattributed forever — under-counting exactly the attributable penalties the
   * feed exists to surface. Attribution is therefore a separate, idempotent step,
   * safe to re-run after every scan.
   *
   * Returns the number of events newly attributed.
   */
  reconcileAttribution(): number {
    const res = this.db
      .prepare(
        `UPDATE OR IGNORE event
            SET channel_outpoint = (
                  SELECT c.channel_outpoint FROM commitment_cell c
                   WHERE c.commitment_outpoint = json_extract(event.detail, '$.commitment_outpoint')
                     AND c.channel_outpoint IS NOT NULL),
                attribution_confidence = 'channel'
          WHERE kind IN ('penalty','settlement')
            AND channel_outpoint IS NULL
            AND EXISTS (
                  SELECT 1 FROM commitment_cell c
                   WHERE c.commitment_outpoint = json_extract(event.detail, '$.commitment_outpoint')
                     AND c.channel_outpoint IS NOT NULL)`,
      )
      .run();
    return Number(res.changes);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

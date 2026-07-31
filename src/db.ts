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
  -- DEPRECATED — do not read. Records only whether channel_outpoint was non-null at
  -- insert time, which is "we identified the channel", NOT the SPEC-FAULTLINE §3
  -- attribution level. Read event_attributed.attribution instead.
  attribution_confidence TEXT NOT NULL CHECK (attribution_confidence IN ('channel','unattributed')),
  detail                 TEXT,
  detected_at            INTEGER NOT NULL,
  UNIQUE (kind, tx_hash, channel_outpoint)
);
CREATE INDEX IF NOT EXISTS idx_event_block ON event(block_number);
CREATE INDEX IF NOT EXISTS idx_event_kind ON event(kind);
CREATE INDEX IF NOT EXISTS idx_event_outpoint ON event(channel_outpoint);

-- ---------------------------------------------------------------------------
-- Atlas: the gossip graph (SPEC-ATLAS §3).
-- ---------------------------------------------------------------------------

-- Keyed on pubkey, matching fnn v0.8.0+ exactly. See SPEC-ATLAS §2.1 on why no
-- local alias is introduced.
CREATE TABLE IF NOT EXISTS node (
  pubkey              TEXT PRIMARY KEY,
  node_name           TEXT,
  version             TEXT,
  addresses_json      TEXT,
  features_json       TEXT,
  chain_hash          TEXT,
  auto_accept_min_ckb TEXT,
  udt_cfg_json        TEXT,
  last_announced      INTEGER,
  first_seen          INTEGER NOT NULL,
  last_seen           INTEGER NOT NULL
);

-- Per-direction ChannelUpdateInfo. A direction absent from gossip has NO ROW here,
-- which is distinct from a row with enabled = 0 (SPEC-ATLAS §3): absence is "unknown",
-- enabled = 0 is a positive statement that the direction is unusable.
CREATE TABLE IF NOT EXISTS channel_update (
  channel_outpoint  TEXT NOT NULL,
  direction         INTEGER NOT NULL CHECK (direction IN (1,2)),
  timestamp         INTEGER,
  enabled           INTEGER,
  fee_rate          TEXT,
  tlc_minimum_value TEXT,
  tlc_expiry_delta  TEXT,
  last_seen         INTEGER NOT NULL,
  PRIMARY KEY (channel_outpoint, direction)
);

-- ---------------------------------------------------------------------------
-- Wall-clock, fetched from chain headers. Never interpolated.
--
-- Everything Faultline records is stamped with a block number and nothing else, so
-- until this table is populated there is no honest time axis anywhere in the API:
-- "era 38" is a 1M-block bucket that a reader will silently translate into months.
-- Estimating a timestamp from a neighbouring block would be the exact failure this
-- project exists to avoid, so each row is a header the chain actually returned.
--
-- Sparse by design: only blocks that something references. A row's absence means
-- "not fetched yet", which the API must render as null, never as an estimate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS block_time (
  block_number INTEGER PRIMARY KEY,
  timestamp_ms INTEGER NOT NULL,
  fetched_at   INTEGER NOT NULL
);

-- Cursor/health for the gossip ingest loop.
CREATE TABLE IF NOT EXISTS gossip_sync (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_at    INTEGER,
  nodes_seen     INTEGER,
  channels_seen  INTEGER
);
`;

/**
 * Attribution level, derived — never stored.
 *
 * SPEC-FAULTLINE §3 grades attribution by *who* an event can be pinned on. Knowing
 * the `channel_outpoint` is not that: it says which channel, not which nodes. The
 * node pair only exists if the channel is in the gossip graph, and gossip carries
 * only live, public channels (§2.3).
 *
 * Conflating the two overstates coverage by more than an order of magnitude — on
 * testnet, 70% of events have an outpoint while 2.2% have a node pair. That is the
 * precise error §2.3 was written to forbid, so the honest figure is computed rather
 * than trusted to a column.
 *
 * Deriving it also fixes a staleness bug by construction. Gossip membership is not
 * fixed: a channel absent today becomes attributable the moment we observe it while
 * still open. A value frozen at insert time can only decay — the same failure that
 * made `reconcileAttribution()` necessary for `channel_outpoint`.
 *
 *   node_pair    — outpoint known AND the channel is in gossip. Attributable to
 *                  {node1, node2}. THIS is the coverage figure Faultline publishes.
 *   channel      — outpoint known, channel absent from gossip. A real, verifiable
 *                  on-chain event that names no node. Private, or closed before we
 *                  first synced.
 *   unattributed — no outpoint. Quarantined, never dropped (F+04).
 */
const ATTRIBUTION_VIEW = `
CREATE VIEW IF NOT EXISTS event_attributed AS
SELECT e.id, e.kind, e.block_number, e.tx_hash, e.channel_outpoint, e.detail,
       e.detected_at,
       c.node1_pubkey, c.node2_pubkey,
       CASE
         WHEN e.channel_outpoint IS NULL   THEN 'unattributed'
         WHEN c.node1_pubkey IS NOT NULL   THEN 'node_pair'
         ELSE 'channel'
       END AS attribution
  FROM event e
  LEFT JOIN channel c ON c.channel_outpoint = e.channel_outpoint;
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    if (path !== ':memory:' && !opts.readOnly) mkdirSync(dirname(path), { recursive: true });
    // Read-only is enforced by SQLite, not by convention. The API serves the same
    // files the scanner and ingest write, and a serving process has no business
    // mutating them — an accidental write is a corrupted archive, not a bad response.
    // The options argument is omitted entirely rather than passed as undefined:
    // node:sqlite rejects an explicit undefined with `The "options" argument must be
    // an object`. Node 24.10 tolerated it, 24.18 does not.
    this.db = opts.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
    if (opts.readOnly) return;

    // The L1 backfill and the gossip ingest are separate processes writing the same
    // file. WAL allows one writer at a time; without a busy timeout the loser of a
    // race fails instead of waiting.
    this.db.exec('PRAGMA busy_timeout = 30000;');
    this.db.exec(SCHEMA);
    this.#migrate();
    // After #migrate: the view reads channel.node1_pubkey, which migration adds.
    this.db.exec(ATTRIBUTION_VIEW);
  }

  /**
   * Additive column migrations.
   *
   * `CREATE TABLE IF NOT EXISTS` will not add columns to an existing table, and the
   * L1 archive is expensive enough that dropping and rebuilding is not an option.
   * Gossip fields are therefore added in place, idempotently.
   */
  #migrate(): void {
    const cols = (table: string) =>
      new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (r) => r.name,
        ),
      );

    const channelCols = cols('channel');
    const additions: [string, string][] = [
      ['node1_pubkey', 'TEXT'],
      ['node2_pubkey', 'TEXT'],
      ['gossip_capacity', 'TEXT'],
      ['gossip_udt_type_script', 'TEXT'],
      ['created_timestamp', 'INTEGER'],
      ['gossip_first_seen', 'INTEGER'],
      ['gossip_last_seen', 'INTEGER'],
    ];
    for (const [name, type] of additions) {
      if (!channelCols.has(name)) {
        this.db.exec(`ALTER TABLE channel ADD COLUMN ${name} ${type}`);
      }
    }
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

  upsertNode(n: {
    pubkey: string;
    node_name: string;
    version: string;
    addresses_json: string;
    features_json: string;
    chain_hash: string;
    auto_accept_min_ckb: string;
    udt_cfg_json: string;
    last_announced: number;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO node (pubkey, node_name, version, addresses_json, features_json, chain_hash,
                           auto_accept_min_ckb, udt_cfg_json, last_announced, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(pubkey) DO UPDATE SET
           node_name = excluded.node_name, version = excluded.version,
           addresses_json = excluded.addresses_json, features_json = excluded.features_json,
           chain_hash = excluded.chain_hash, auto_accept_min_ckb = excluded.auto_accept_min_ckb,
           udt_cfg_json = excluded.udt_cfg_json, last_announced = excluded.last_announced,
           last_seen = excluded.last_seen`,
      )
      .run(n.pubkey, n.node_name, n.version, n.addresses_json, n.features_json, n.chain_hash,
           n.auto_accept_min_ckb, n.udt_cfg_json, n.last_announced, now, now);
  }

  /**
   * Merge gossip facts into the channel row keyed by the SAME canonical
   * channel_outpoint the L1 scanner uses. This is the join (SPEC-ATLAS §2.2).
   */
  upsertChannelGossip(c: {
    channel_outpoint: string;
    node1_pubkey: string;
    node2_pubkey: string;
    gossip_capacity: string;
    gossip_udt_type_script: string | null;
    created_timestamp: number;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO channel (channel_outpoint, node1_pubkey, node2_pubkey, gossip_capacity,
                              gossip_udt_type_script, created_timestamp,
                              gossip_first_seen, gossip_last_seen, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(channel_outpoint) DO UPDATE SET
           node1_pubkey = excluded.node1_pubkey,
           node2_pubkey = excluded.node2_pubkey,
           gossip_capacity = excluded.gossip_capacity,
           gossip_udt_type_script = excluded.gossip_udt_type_script,
           created_timestamp = excluded.created_timestamp,
           gossip_first_seen = COALESCE(channel.gossip_first_seen, excluded.gossip_first_seen),
           gossip_last_seen = excluded.gossip_last_seen,
           last_seen = excluded.last_seen`,
      )
      .run(c.channel_outpoint, c.node1_pubkey, c.node2_pubkey, c.gossip_capacity,
           c.gossip_udt_type_script, c.created_timestamp, now, now, now, now);
  }

  upsertChannelUpdate(u: {
    channel_outpoint: string;
    direction: 1 | 2;
    timestamp: number;
    enabled: number;
    fee_rate: string;
    tlc_minimum_value: string;
    tlc_expiry_delta: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO channel_update (channel_outpoint, direction, timestamp, enabled, fee_rate,
                                     tlc_minimum_value, tlc_expiry_delta, last_seen)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(channel_outpoint, direction) DO UPDATE SET
           timestamp = excluded.timestamp, enabled = excluded.enabled,
           fee_rate = excluded.fee_rate, tlc_minimum_value = excluded.tlc_minimum_value,
           tlc_expiry_delta = excluded.tlc_expiry_delta, last_seen = excluded.last_seen`,
      )
      .run(u.channel_outpoint, u.direction, u.timestamp, u.enabled, u.fee_rate,
           u.tlc_minimum_value, u.tlc_expiry_delta, Date.now());
  }

  recordGossipSync(nodes: number, channels: number): void {
    this.db
      .prepare(
        `INSERT INTO gossip_sync (id, last_run_at, nodes_seen, channels_seen) VALUES (1,?,?,?)
         ON CONFLICT(id) DO UPDATE SET last_run_at = excluded.last_run_at,
           nodes_seen = excluded.nodes_seen, channels_seen = excluded.channels_seen`,
      )
      .run(Date.now(), nodes, channels);
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

  /**
   * Event counts by attribution level, overall and per kind.
   *
   * `node_pair` is the only row that supports a per-node claim; see ATTRIBUTION_VIEW.
   */
  attributionBreakdown(): { kind: string; attribution: string; n: number }[] {
    return this.db
      .prepare(
        `SELECT kind, attribution, COUNT(*) AS n
           FROM event_attributed
          GROUP BY kind, attribution
          ORDER BY kind, attribution`,
      )
      .all() as { kind: string; attribution: string; n: number }[];
  }

  // -------------------------------------------------------------------------
  // Block time
  // -------------------------------------------------------------------------

  /**
   * Every block number anything in the archive refers to.
   *
   * The union is deliberately wider than `event`: a channel's open block never
   * produces an event row, but the API dates a channel's lifetime from it, and a
   * commitment's create/spend blocks are what a force-close timeline is drawn from.
   */
  static readonly REFERENCED_BLOCKS = `
    SELECT block_number AS b FROM event
    UNION SELECT open_block     FROM channel         WHERE open_block     IS NOT NULL
    UNION SELECT close_block    FROM channel         WHERE close_block    IS NOT NULL
    UNION SELECT created_block  FROM commitment_cell WHERE created_block  IS NOT NULL
    UNION SELECT spend_block    FROM commitment_cell WHERE spend_block    IS NOT NULL`;

  /** Referenced blocks with no header fetched yet, oldest first. */
  blocksMissingTime(limit: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT b FROM (${Store.REFERENCED_BLOCKS})
             WHERE b NOT IN (SELECT block_number FROM block_time)
             ORDER BY b LIMIT ?`,
        )
        .all(limit) as { b: number }[]
    ).map((r) => r.b);
  }

  putBlockTimes(rows: readonly { blockNumber: number; timestampMs: number }[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO block_time (block_number, timestamp_ms, fetched_at)
            VALUES (?, ?, ?)
       ON CONFLICT(block_number) DO NOTHING`,
    );
    const now = Date.now();
    this.transaction(() => {
      for (const r of rows) stmt.run(r.blockNumber, r.timestampMs, now);
    });
  }

  /**
   * How much of the archive can be placed in time.
   *
   * Published rather than kept internal: a UI that draws a date axis over 60%
   * coverage is drawing a lie, and the only defence is telling it the number.
   */
  blockTimeCoverage(): { referenced: number; resolved: number } {
    return this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM (${Store.REFERENCED_BLOCKS}))       AS referenced,
                (SELECT COUNT(*) FROM (${Store.REFERENCED_BLOCKS}) r
                   JOIN block_time bt ON bt.block_number = r.b)           AS resolved`,
      )
      .get() as { referenced: number; resolved: number };
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

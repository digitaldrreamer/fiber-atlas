/**
 * Fiber Atlas HTTP API (v0). Read-only, zero dependencies, `node:http`.
 *
 * Every route is scoped to a network — `/v0/:network/...` — and every response
 * carries its `network` back. This is not a convenience, it is the spec's central
 * constraint (SPEC-FAULTLINE §4.2): testnet and mainnet tell opposite stories, so a
 * figure that travels without its network label is a figure that will eventually be
 * quoted as the other one's.
 *
 * Three normative requirements are enforced in the response shapes rather than left
 * to documentation, because documentation does not survive being consumed by a
 * client author in a hurry:
 *
 *   A+04  Capacity is never presented as spendable. The field is `capacity_shannons`
 *         and channel payloads carry an explicit `capacity_is_not_balance` note.
 *   F-02  No attribution without its confidence label. Every event embeds
 *         `attribution` ∈ {node_pair, channel, unattributed}.
 *   F+05  Counts are never served alone. Reliability payloads pair every count with
 *         an exposure-normalised rate and the window it was measured over.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Store } from '../db.ts';

export interface NetworkStore {
  readonly name: string;
  readonly store: Store;
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/** Shannons per CKB. Kept explicit so no caller has to guess the unit. */
const SHANNONS_PER_CKB = 100_000_000;

interface Ctx {
  readonly net: NetworkStore;
  readonly url: URL;
}

function intParam(url: URL, key: string, dflt: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return dflt;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return dflt;
  return Math.min(n, max);
}

const all = <T>(net: NetworkStore, sql: string, ...args: unknown[]): T[] =>
  net.store.db.prepare(sql).all(...(args as never[])) as T[];
const one = <T>(net: NetworkStore, sql: string, ...args: unknown[]): T | undefined =>
  net.store.db.prepare(sql).get(...(args as never[])) as T | undefined;

// ---------------------------------------------------------------------------
// Reliability
// ---------------------------------------------------------------------------

/**
 * Windowed reliability for one node, or for the network when pubkey is null.
 *
 * The window is not optional and there is no lifetime variant, deliberately.
 * SPEC-FAULTLINE §4.1: testnet's lifetime force-close rate is 42%, a figure that
 * describes no period anyone operates in and would permanently condemn every node
 * online during the 2025-08 → 2026-01 era. A lifetime endpoint would be used.
 */
function reliability(net: NetworkStore, pubkey: string | null, windowBlocks: number) {
  const tip = one<{ hi: number | null }>(net, 'SELECT MAX(block_number) AS hi FROM event')?.hi ?? 0;
  const since = Math.max(0, tip - windowBlocks);

  const where = pubkey
    ? `AND (node1_pubkey = ? OR node2_pubkey = ?)`
    : '';
  const args = pubkey ? [since, pubkey, pubkey] : [since];

  const counts = one<{
    total: number; coop: number; force: number; penalty: number; attributed: number;
  }>(
    net,
    `SELECT COUNT(*) AS total,
            SUM(kind = 'cooperative_close') AS coop,
            SUM(kind = 'force_close')       AS force,
            SUM(kind = 'penalty')           AS penalty,
            SUM(attribution = 'node_pair')  AS attributed
       FROM event_attributed
      WHERE block_number >= ? ${where}`,
    ...args,
  )!;

  const closes = (counts.coop ?? 0) + (counts.force ?? 0);
  const rate = (n: number | null) => (closes === 0 ? null : Number(((n ?? 0) / closes).toFixed(4)));

  return {
    window: { blocks: windowBlocks, from_block: since, to_block: tip },
    counts: {
      closes,
      cooperative: counts.coop ?? 0,
      force_close: counts.force ?? 0,
      penalty: counts.penalty ?? 0,
    },
    // F+05: rates alongside counts, never counts alone. A node with 500 channels
    // accrues more raw events than one with 5 without being less reliable.
    rates: {
      force_close_per_close: rate(counts.force),
      penalty_per_close: rate(counts.penalty),
    },
    node_attributed_events: counts.attributed ?? 0,
    caveats: [
      'A force-close is evidence, not proof of misbehaviour: a peer going offline forces one too (SPEC-FAULTLINE §4.5).',
      'Successes are never counted. No off-chain success is creditable, so absence of failure is the only positive signal.',
      'Rates are windowed. There is deliberately no lifetime figure; see SPEC-FAULTLINE §4.1.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function nodes(c: Ctx) {
  const limit = intParam(c.url, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const offset = intParam(c.url, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const rows = all<Record<string, unknown>>(
    c.net,
    `SELECT n.pubkey, n.node_name, n.version, n.first_seen, n.last_seen,
            (SELECT COUNT(*) FROM channel c
              WHERE (c.node1_pubkey = n.pubkey OR c.node2_pubkey = n.pubkey)
                AND c.close_kind IS NULL) AS open_channels
       FROM node n ORDER BY open_channels DESC, n.pubkey LIMIT ? OFFSET ?`,
    limit,
    offset,
  );
  const total = one<{ n: number }>(c.net, 'SELECT COUNT(*) AS n FROM node')!.n;
  return { total, limit, offset, nodes: rows };
}

function node(c: Ctx, pubkey: string) {
  const n = one<Record<string, unknown>>(c.net, 'SELECT * FROM node WHERE pubkey = ?', pubkey);
  if (!n) return null;
  const channels = all<Record<string, unknown>>(
    c.net,
    `SELECT channel_outpoint, node1_pubkey, node2_pubkey, capacity AS capacity_shannons,
            close_kind, close_block
       FROM channel WHERE node1_pubkey = ? OR node2_pubkey = ? LIMIT ?`,
    pubkey,
    pubkey,
    MAX_LIMIT,
  );
  const w = intParam(c.url, 'window_blocks', 200_000, 10_000_000);
  return {
    node: n,
    channels,
    capacity_is_not_balance:
      'capacity_shannons is the channel total, an upper bound. Fiber does not broadcast balances, so no field here is spendable liquidity (SPEC-ATLAS §5.1, A+04).',
    faultline: reliability(c.net, pubkey, w),
  };
}

function channels(c: Ctx) {
  const limit = intParam(c.url, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const offset = intParam(c.url, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const status = c.url.searchParams.get('status');
  const where =
    status === 'open' ? 'WHERE close_kind IS NULL'
    : status === 'closed' ? 'WHERE close_kind IS NOT NULL'
    : '';
  const rows = all<Record<string, unknown>>(
    c.net,
    `SELECT channel_outpoint, node1_pubkey, node2_pubkey, capacity AS capacity_shannons,
            open_block, close_kind, close_block
       FROM channel ${where} ORDER BY COALESCE(close_block, open_block) DESC LIMIT ? OFFSET ?`,
    limit,
    offset,
  );
  const total = one<{ n: number }>(c.net, `SELECT COUNT(*) AS n FROM channel ${where}`)!.n;
  return {
    total,
    limit,
    offset,
    capacity_is_not_balance:
      'capacity_shannons is an upper bound, never spendable liquidity (A+04).',
    channels: rows,
  };
}

function channel(c: Ctx, outpoint: string) {
  const ch = one<Record<string, unknown>>(
    c.net,
    'SELECT *, capacity AS capacity_shannons FROM channel WHERE channel_outpoint = ?',
    outpoint,
  );
  if (!ch) return null;
  const events = all<Record<string, unknown>>(
    c.net,
    `SELECT kind, block_number, tx_hash, attribution, detail
       FROM event_attributed WHERE channel_outpoint = ? ORDER BY block_number`,
    outpoint,
  );
  return { channel: ch, events };
}

function events(c: Ctx) {
  const limit = intParam(c.url, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const offset = intParam(c.url, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const kind = c.url.searchParams.get('kind');
  const kinds = ['cooperative_close', 'force_close', 'penalty', 'settlement'];
  const where = kind && kinds.includes(kind) ? 'WHERE kind = ?' : '';
  const args: unknown[] = kind && kinds.includes(kind) ? [kind, limit, offset] : [limit, offset];
  const rows = all<Record<string, unknown>>(
    c.net,
    `SELECT kind, block_number, tx_hash, channel_outpoint, node1_pubkey, node2_pubkey,
            attribution, detail
       FROM event_attributed ${where} ORDER BY block_number DESC LIMIT ? OFFSET ?`,
    ...args,
  );
  return {
    total: one<{ n: number }>(c.net, `SELECT COUNT(*) AS n FROM event_attributed ${where}`,
      ...(kind && kinds.includes(kind) ? [kind] : []))!.n,
    limit,
    offset,
    // F-02 / F+04: attribution travels with every event, and unattributed events are
    // served rather than hidden — they are real, verifiable, on-chain facts that
    // simply name no node.
    attribution_levels: {
      node_pair: 'Attributable to {node1, node2}. The only level supporting a per-node claim.',
      channel: 'Channel identified, but absent from gossip. Real event, names no node.',
      unattributed: 'No channel outpoint. Quarantined, never dropped.',
    },
    events: rows,
  };
}

/** The era analysis — the project's most useful output, and network-scoped by nature. */
function eras(c: Ctx) {
  const rows = all<{ era: number; n: number; force: number; penalty: number }>(
    c.net,
    `SELECT close_block / 1000000 AS era,
            COUNT(*) AS n,
            SUM(close_kind = 'force_close') AS force,
            0 AS penalty
       FROM channel WHERE close_kind IS NOT NULL GROUP BY era ORDER BY era`,
  );
  const penalties = all<{ era: number; n: number }>(
    c.net,
    `SELECT block_number / 1000000 AS era, COUNT(*) AS n
       FROM event WHERE kind = 'penalty' GROUP BY era`,
  );
  const pmap = new Map(penalties.map((p) => [p.era, p.n]));
  return {
    note:
      'Force-close rate is not stationary. Reliability must be read per era, never as a lifetime aggregate (SPEC-FAULTLINE §4.1).',
    eras: rows.map((r) => ({
      block_era: `${r.era}M`,
      closes: r.n,
      force_closes: r.force,
      force_close_rate: Number((r.force / r.n).toFixed(4)),
      penalties: pmap.get(r.era) ?? 0,
    })),
  };
}

function summary(c: Ctx) {
  const ch = one<{ total: number; open: number; coop: number; force: number }>(
    c.net,
    `SELECT COUNT(*) AS total,
            SUM(close_kind IS NULL) AS open,
            SUM(close_kind = 'cooperative') AS coop,
            SUM(close_kind = 'force_close') AS force
       FROM channel`,
  )!;
  const pen = one<{ n: number }>(c.net, "SELECT COUNT(*) AS n FROM event WHERE kind = 'penalty'")!;
  const gossip = one<{ live_public: number; nodes: number }>(
    c.net,
    `SELECT (SELECT COUNT(*) FROM channel WHERE close_kind IS NULL AND node1_pubkey IS NOT NULL) AS live_public,
            (SELECT COUNT(*) FROM node) AS nodes`,
  )!;
  const closed = (ch.coop ?? 0) + (ch.force ?? 0);
  const ev = one<{ n: number; np: number }>(
    c.net,
    "SELECT COUNT(*) AS n, SUM(attribution = 'node_pair') AS np FROM event_attributed",
  )!;
  return {
    channels: {
      known: ch.total,
      open: ch.open,
      closed,
      cooperative: ch.coop ?? 0,
      force_close: ch.force ?? 0,
      force_close_rate_lifetime: closed ? Number(((ch.force ?? 0) / closed).toFixed(4)) : null,
      lifetime_rate_warning:
        'Lifetime rates are published for completeness and MUST NOT be used as a reliability signal — see /eras.',
    },
    penalties_all_time: pen.n,
    gossip: {
      nodes: gossip.nodes,
      live_public_channels: gossip.live_public,
      publicly_announced_share: ch.open
        ? Number((gossip.live_public / ch.open).toFixed(4))
        : null,
    },
    attribution: {
      events: ev.n,
      node_attributed: ev.np ?? 0,
      coverage: ev.n ? Number(((ev.np ?? 0) / ev.n).toFixed(4)) : null,
      note:
        'Coverage grows with observation time, not with backfill size: attribution needs the channel seen in gossip while open (SPEC-FAULTLINE §3.1).',
    },
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createApi(networks: NetworkStore[], opts: { version?: string } = {}) {
  const byName = new Map(networks.map((n) => [n.name, n]));

  const send = (res: ServerResponse, code: number, body: unknown) => {
    const json = JSON.stringify(body, null, 2);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': code === 200 ? 'public, max-age=30' : 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(json);
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return send(res, 400, { error: 'bad request' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: 'read-only API; use GET' });
    }

    const seg = url.pathname.split('/').filter(Boolean);

    try {
      if (seg.length === 0) {
        return send(res, 200, {
          service: 'fiber-atlas',
          version: opts.version ?? '0.1.0',
          networks: [...byName.keys()],
          note: 'Every figure is network-scoped. Testnet and mainnet differ by more than an order of magnitude; never quote one as the other.',
          routes: [
            '/health',
            '/v0/{network}/summary',
            '/v0/{network}/eras',
            '/v0/{network}/nodes',
            '/v0/{network}/nodes/{pubkey}',
            '/v0/{network}/channels?status=open|closed',
            '/v0/{network}/channels/{outpoint}',
            '/v0/{network}/faultline/events?kind=penalty|force_close|cooperative_close',
          ],
        });
      }

      if (seg.length === 1 && seg[0] === 'health') {
        const health = [...byName.values()].map((net) => {
          const sync = one<{ last_run_at: number | null; channels_seen: number | null }>(
            net,
            'SELECT last_run_at, channels_seen FROM gossip_sync WHERE id = 1',
          );
          const tip = one<{ hi: number | null }>(net, 'SELECT MAX(block_number) AS hi FROM event');
          return {
            network: net.name,
            l1_max_event_block: tip?.hi ?? null,
            gossip_last_run_at: sync?.last_run_at ?? null,
            gossip_channels_seen: sync?.channels_seen ?? null,
          };
        });
        return send(res, 200, { ok: true, networks: health });
      }

      if (seg[0] !== 'v0') return send(res, 404, { error: 'not found' });

      const net = byName.get(seg[1] ?? '');
      if (!net) {
        return send(res, 404, {
          error: `unknown network '${seg[1] ?? ''}'`,
          networks: [...byName.keys()],
        });
      }
      const c: Ctx = { net, url };
      const rest = seg.slice(2);
      const wrap = (body: unknown) => send(res, 200, { network: net.name, ...(body as object) });

      if (rest.length === 1 && rest[0] === 'summary') return wrap(summary(c));
      if (rest.length === 1 && rest[0] === 'eras') return wrap(eras(c));
      if (rest.length === 1 && rest[0] === 'nodes') return wrap(nodes(c));
      if (rest.length === 2 && rest[0] === 'nodes') {
        const n = node(c, rest[1] as string);
        return n ? wrap(n) : send(res, 404, { error: 'node not found', network: net.name });
      }
      if (rest.length === 1 && rest[0] === 'channels') return wrap(channels(c));
      if (rest.length === 2 && rest[0] === 'channels') {
        const ch = channel(c, rest[1] as string);
        return ch ? wrap(ch) : send(res, 404, { error: 'channel not found', network: net.name });
      }
      if (rest.length === 2 && rest[0] === 'faultline' && rest[1] === 'events') return wrap(events(c));
      if (rest.length === 2 && rest[0] === 'faultline' && rest[1] === 'penalties') {
        url.searchParams.set('kind', 'penalty');
        return wrap(events(c));
      }
      if (rest.length === 3 && rest[0] === 'faultline' && rest[1] === 'nodes') {
        const w = intParam(url, 'window_blocks', 200_000, 10_000_000);
        return wrap({ pubkey: rest[2], faultline: reliability(net, rest[2] as string, w) });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      // Never leak a stack trace or a SQL string to a public endpoint.
      console.error(`[api] ${url.pathname}:`, err);
      return send(res, 500, { error: 'internal error' });
    }
  });
}

export { SHANNONS_PER_CKB };

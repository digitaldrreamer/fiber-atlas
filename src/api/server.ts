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
import { routableIps } from '../atlas/multiaddr.ts';

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
// Time
// ---------------------------------------------------------------------------

/**
 * Wall-clock for a block, or null.
 *
 * Null is a real answer and must survive to the client: a header we have not
 * fetched is unknown, and the neighbouring blocks' times are not evidence about
 * this one. Every consumer therefore has to handle a missing date, which is the
 * point — an interface that cannot express "unknown" will invent something.
 */
function withTime(row: Record<string, unknown>, ...fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    const ms = row[`${f}_timestamp_ms`];
    out[`${f}_at`] = typeof ms === 'number' ? new Date(ms).toISOString() : null;
    delete out[`${f}_timestamp_ms`];
  }
  return out;
}

/** `LEFT JOIN` a block_time row. Left, always: an unresolved block must not drop a row. */
const timeJoin = (alias: string, col: string) =>
  `LEFT JOIN block_time ${alias} ON ${alias}.block_number = ${col}`;

// ---------------------------------------------------------------------------
// Network location
// ---------------------------------------------------------------------------

/**
 * Where the network physically sits, by country and by hosting AS.
 *
 * Counted per NODE, not per address: a node announcing three addresses in one
 * datacentre is one node there, and counting addresses would silently weight
 * multi-homed hosts. A node whose addresses are all unresolved (or all private) is
 * counted in `unresolved_nodes` rather than dropped — a concentration figure whose
 * denominator quietly excludes what it could not resolve is not a concentration
 * figure.
 */
function geo(c: Ctx) {
  const rows = all<{ pubkey: string; addresses_json: string | null }>(
    c.net,
    'SELECT pubkey, addresses_json FROM node',
  );
  const loc = new Map<string, { country_code: string | null; country_name: string | null; asn_org: string | null; asn: string | null }>();
  for (const r of all<{ ip: string; country_code: string | null; country_name: string | null; asn_org: string | null; asn: string | null }>(
    c.net,
    'SELECT ip, country_code, country_name, asn_org, asn FROM ip_location',
  )) {
    loc.set(r.ip, r);
  }

  const countries = new Map<string, { code: string | null; name: string | null; nodes: number }>();
  const providers = new Map<string, { asn: string | null; org: string | null; nodes: number }>();
  let unresolved = 0;
  let noRoutable = 0;

  for (const n of rows) {
    const ips = routableIps(n.addresses_json);
    if (ips.length === 0) {
      noRoutable++;
      continue;
    }
    const hits = ips.map((ip) => loc.get(ip)).filter((x): x is NonNullable<typeof x> => x != null);
    if (hits.length === 0) {
      unresolved++;
      continue;
    }
    // One vote per node per distinct country/AS, so a multi-homed node in a single
    // region is not counted three times.
    for (const cc of new Set(hits.map((h) => h.country_code ?? 'unknown'))) {
      const cur = countries.get(cc) ?? {
        code: cc === 'unknown' ? null : cc,
        name: hits.find((h) => (h.country_code ?? 'unknown') === cc)?.country_name ?? null,
        nodes: 0,
      };
      cur.nodes++;
      countries.set(cc, cur);
    }
    for (const org of new Set(hits.map((h) => h.asn_org ?? 'unknown'))) {
      const cur = providers.get(org) ?? {
        asn: hits.find((h) => (h.asn_org ?? 'unknown') === org)?.asn ?? null,
        org: org === 'unknown' ? null : org,
        nodes: 0,
      };
      cur.nodes++;
      providers.set(org, cur);
    }
  }

  const resolved = rows.length - unresolved - noRoutable;
  return {
    coverage: {
      nodes: rows.length,
      resolved_nodes: resolved,
      unresolved_nodes: unresolved,
      nodes_without_routable_address: noRoutable,
      note:
        'unresolved_nodes announce a routable address that has not been looked up yet. nodes_without_routable_address announce only private/loopback addresses — those have no location to find. Neither is counted in the breakdowns below; read them against resolved_nodes, not against nodes.',
    },
    countries: [...countries.values()].sort((a, b) => b.nodes - a.nodes),
    hosting_providers: [...providers.values()].sort((a, b) => b.nodes - a.nodes),
    source:
      'Cloudflare Radar, keyed on the IP addresses nodes themselves broadcast in gossip. Nothing is probed or scanned; DNS addresses are not resolved.',
  };
}

/**
 * Continuous-presence history for one node.
 *
 * The closest thing to a positive reliability signal this project can honestly
 * produce. It is NOT reliability — a node can be continuously announced and still
 * force-close on you — but "reachable without interruption for 40 days" is a real,
 * observed fact, which is more than the on-chain record can offer about any
 * specific node (0.27% attribution coverage; zero on mainnet).
 *
 * `observed_since` is when THIS ARCHIVE started watching, not when the node
 * appeared. The table cannot be backfilled — nobody recorded who was online before
 * it existed — so early readings understate every node and must say so.
 */
function nodeUptime(c: Ctx, pubkey: string) {
  const runs = all<{ started_at: number; last_seen_at: number }>(
    c.net,
    'SELECT started_at, last_seen_at FROM node_presence WHERE pubkey = ? ORDER BY started_at',
    pubkey,
  );
  const watchedFrom = one<{ t: number | null }>(
    c.net,
    'SELECT MIN(started_at) AS t FROM node_presence',
  )?.t ?? null;

  if (runs.length === 0) {
    return {
      observed: false,
      observed_since: watchedFrom ? new Date(watchedFrom).toISOString() : null,
      reason:
        'No presence run recorded. Either this archive has not observed the node since presence tracking began, or tracking has only just started.',
    };
  }
  const last = runs[runs.length - 1]!;
  const durations = runs.map((r) => r.last_seen_at - r.started_at);
  return {
    observed: true,
    observed_since: watchedFrom ? new Date(watchedFrom).toISOString() : null,
    current_run: {
      started_at: new Date(last.started_at).toISOString(),
      last_seen_at: new Date(last.last_seen_at).toISOString(),
      days: Number(((last.last_seen_at - last.started_at) / 86400000).toFixed(2)),
    },
    runs: runs.length,
    longest_run_days: Number((Math.max(...durations) / 86400000).toFixed(2)),
    caveats: [
      'Measured from observed_since only. This table cannot be backfilled, so a node online for a year reads as short-lived until enough time passes.',
      'Presence is OUR observation. If the observing node loses peers, every run ends at once — cross-check /health.gossip_last_run_at before reading a break as the node going away.',
      'Continuous presence is not reliability. It says the node was announced, not that it behaved.',
    ],
  };
}

/** Per-node location, shaped for a node page. Same rules as `geo`. */
function nodeLocations(c: Ctx, addressesJson: string | null) {
  const ips = routableIps(addressesJson);
  if (ips.length === 0) return { addresses: [], note: 'No routable address announced (private or loopback only).' };
  const rows = ips.map((ip) => {
    const r = one<{ ip_version: string | null; country_code: string | null; country_name: string | null; asn: string | null; asn_org: string | null }>(
      c.net,
      'SELECT ip_version, country_code, country_name, asn, asn_org FROM ip_location WHERE ip = ?',
      ip,
    );
    return {
      ip,
      resolved: r != null,
      ip_version: r?.ip_version ?? null,
      country_code: r?.country_code ?? null,
      country_name: r?.country_name ?? null,
      asn: r?.asn ?? null,
      asn_org: r?.asn_org ?? null,
    };
  });
  return { addresses: rows, source: 'Cloudflare Radar, on gossip-announced addresses only.' };
}

// ---------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------

/**
 * Percentiles over a sample, computed here rather than in SQL.
 *
 * A mean alone is misleading for every quantity this project holds: channel
 * capacity, fee rate and force-close resolution time are all heavily skewed, and
 * two of the three have a long tail that a mean hides completely. `n` travels with
 * the summary so a caller can see how much sample it is reading.
 */
function summarise(values: number[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))] as number;
  return {
    n: v.length,
    min: v[0] as number,
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p95: at(0.95),
    max: v[v.length - 1] as number,
    mean: Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)),
  };
}

/** Bucket ages (in ms) into human spans. Buckets, not a mean: staleness is not normal. */
function ageBuckets(agesMs: number[]): Record<string, number> {
  const H = 3_600_000;
  const b = { under_1h: 0, h1_6: 0, h6_24: 0, d1_7: 0, over_7d: 0 };
  for (const a of agesMs) {
    if (a < H) b.under_1h++;
    else if (a < 6 * H) b.h1_6++;
    else if (a < 24 * H) b.h6_24++;
    else if (a < 7 * 24 * H) b.d1_7++;
    else b.over_7d++;
  }
  return b;
}

/**
 * Capacity, fee and channel-lifetime distributions.
 *
 * Every Lightning explorer leads with these and none of them exists for Fiber.
 * Capacity comes from the L1 archive (authoritative and complete); fee rate from
 * live gossip (partial by nature); lifetime needs both a dated open and a dated
 * close, so its `n` is smaller than the closed-channel count and says so.
 */
function distribution(c: Ctx) {
  const caps = all<{ capacity: string | null }>(
    c.net,
    'SELECT capacity FROM channel WHERE close_kind IS NULL',
  )
    .map((r) => hexToNumber(r.capacity))
    .filter((n): n is number => n !== null);

  const fees = all<{ fee_rate: string | null }>(c.net, 'SELECT fee_rate FROM channel_update')
    .map((r) => hexToNumber(r.fee_rate))
    .filter((n): n is number => n !== null);

  const lifetimes = all<{ days: number }>(
    c.net,
    `SELECT (cb.timestamp_ms - ob.timestamp_ms) / 86400000.0 AS days
       FROM channel ch
       JOIN block_time ob ON ob.block_number = ch.open_block
       JOIN block_time cb ON cb.block_number = ch.close_block
      WHERE ch.close_kind IS NOT NULL AND cb.timestamp_ms >= ob.timestamp_ms`,
  ).map((r) => Number(r.days.toFixed(4)));

  const closedTotal = one<{ n: number }>(
    c.net,
    'SELECT COUNT(*) AS n FROM channel WHERE close_kind IS NOT NULL',
  )!.n;

  return {
    open_channel_capacity_shannons: {
      ...(summarise(caps) ?? {}),
      total: caps.reduce((a, b) => a + b, 0),
      source: 'L1 archive — complete for channels this scan has not seen close.',
    },
    announced_fee_rate_shannons_per_kb: {
      ...(summarise(fees) ?? {}),
      source:
        'Live gossip only, one sample per announced direction. Covers currently-announced channels, not the archive.',
    },
    closed_channel_lifetime_days: {
      ...(summarise(lifetimes) ?? {}),
      closed_channels_total: closedTotal,
      dated_coverage: closedTotal ? Number((lifetimes.length / closedTotal).toFixed(4)) : null,
      source:
        'Open and close block header timestamps. Only channels with BOTH dated are included; compare n against closed_channels_total.',
    },
    capacity_is_not_balance:
      'Capacity is an upper bound on what a channel could carry, never spendable liquidity (A+04).',
  };
}

/**
 * How fresh the live view is — per channel direction and per node.
 *
 * The gossip half of this project is the only part that changes between polls, and
 * a stale announcement is the closest thing to a routing-liveness signal a passive
 * observer can produce. Reported as buckets rather than an average because the
 * distribution is not unimodal: most channels are re-announced constantly and a
 * tail has not been heard from in weeks, and a mean would sit in the empty middle.
 */
function liveness(c: Ctx) {
  const now = Date.now();
  const updates = all<{ timestamp: number | null; enabled: number | null; last_seen: number }>(
    c.net,
    'SELECT timestamp, enabled, last_seen FROM channel_update',
  );
  const nodes = all<{ last_seen: number }>(c.net, 'SELECT last_seen FROM node');

  const announced = updates
    .map((u) => u.timestamp)
    .filter((t): t is number => typeof t === 'number');

  return {
    as_of: new Date(now).toISOString(),
    channel_directions: {
      total: updates.length,
      enabled: updates.filter((u) => u.enabled === 1).length,
      disabled: updates.filter((u) => u.enabled === 0).length,
      unknown: updates.filter((u) => u.enabled === null).length,
      announcement_age: ageBuckets(announced.map((t) => now - t)),
      undated: updates.length - announced.length,
    },
    nodes: {
      total: nodes.length,
      last_seen_age: ageBuckets(nodes.map((n) => now - n.last_seen)),
    },
    caveats: [
      'Staleness is measured against OUR observation, so it degrades if the observing node loses peers. Cross-check /health.gossip_last_run_at.',
      'A stale announcement is a soft signal. It suggests a path is not being maintained; it does not prove the channel is unusable.',
      'enabled=unknown means gossip carried no ChannelUpdate for that direction — not that it is disabled (SPEC-ATLAS §3).',
    ],
  };
}

/**
 * How long a force-close actually takes to resolve on chain.
 *
 * A force-close creates a commitment cell; the funds are not moved until that cell
 * is spent, either by the counterparty sweeping a revoked state (penalty) or by
 * normal settlement. The gap between those two blocks is the wait a user actually
 * experiences when a channel fails, and it is derivable from L1 alone — no gossip,
 * no attribution, so it is complete rather than a 0.29% sample. It is not published
 * anywhere else for Fiber.
 *
 * Commitment cells with no spend are reported separately and NOT as a latency of
 * zero or as an average-so-far: an unresolved close is a different outcome, not a
 * fast one.
 */
function faultlineTiming(c: Ctx) {
  const rows = all<{ spend_kind: string; hours: number }>(
    c.net,
    `SELECT cc.spend_kind,
            (sb.timestamp_ms - cb.timestamp_ms) / 3600000.0 AS hours
       FROM commitment_cell cc
       JOIN block_time cb ON cb.block_number = cc.created_block
       JOIN block_time sb ON sb.block_number = cc.spend_block
      WHERE cc.spend_kind IS NOT NULL AND sb.timestamp_ms >= cb.timestamp_ms`,
  );
  const by = (kind: string) =>
    summarise(rows.filter((r) => r.spend_kind === kind).map((r) => Number(r.hours.toFixed(4))));

  const unspent = one<{ n: number; oldest: number | null }>(
    c.net,
    `SELECT COUNT(*) AS n, MIN(bt.timestamp_ms) AS oldest
       FROM commitment_cell cc
       LEFT JOIN block_time bt ON bt.block_number = cc.created_block
      WHERE cc.spend_kind IS NULL`,
  )!;

  return {
    what_this_measures:
      'Blocks between a force-close creating a commitment cell and that cell being spent, converted to hours via chain header timestamps. This is the on-chain wait after a channel fails.',
    resolution_hours: {
      penalty: by('penalty'),
      settlement: by('settlement'),
    },
    unresolved: {
      commitment_cells: unspent.n,
      oldest_created_at: unspent.oldest ? new Date(unspent.oldest).toISOString() : null,
      note:
        'Commitment cells this scan has never seen spent. Counted separately, never folded into the averages above — an unresolved close is a different outcome, not a fast one. Some are simply abandoned testnet channels.',
    },
    caveats: [
      'Derived from L1 only, so it is complete — unlike node-level attribution, which covers 0.29% of events.',
      'A long settlement time is usually a contract delay period elapsing, not a participant failing.',
    ],
  };
}

/**
 * Channel opens and closes per calendar month, across the whole archive.
 *
 * Possible only since block headers were fetched — before that every channel had a
 * height and no date. Calendar months, not block buckets, because this is the one
 * view meant to be read against the outside world (a release, an incident, a
 * hackathon) rather than against chain progress.
 *
 * A month is included only if it has a dated event; gaps are real gaps.
 */
function activity(c: Ctx) {
  const opens = all<{ month: string; n: number }>(
    c.net,
    `SELECT strftime('%Y-%m', bt.timestamp_ms / 1000, 'unixepoch') AS month, COUNT(*) AS n
       FROM channel ch JOIN block_time bt ON bt.block_number = ch.open_block
      GROUP BY month`,
  );
  const closes = all<{ month: string; n: number; force: number }>(
    c.net,
    `SELECT strftime('%Y-%m', bt.timestamp_ms / 1000, 'unixepoch') AS month,
            COUNT(*) AS n, SUM(ch.close_kind = 'force_close') AS force
       FROM channel ch JOIN block_time bt ON bt.block_number = ch.close_block
      WHERE ch.close_kind IS NOT NULL
      GROUP BY month`,
  );
  const months = [...new Set([...opens.map((o) => o.month), ...closes.map((x) => x.month)])].sort();
  const oMap = new Map(opens.map((o) => [o.month, o.n]));
  const cMap = new Map(closes.map((x) => [x.month, x]));

  let net = 0;
  return {
    months: months.map((m) => {
      const o = oMap.get(m) ?? 0;
      const cl = cMap.get(m);
      net += o - (cl?.n ?? 0);
      return {
        month: m,
        opened: o,
        closed: cl?.n ?? 0,
        force_closed: cl?.force ?? 0,
        // Running total of opens minus closes. Not the same as "channels open at the
        // end of this month" for any month before the scan began, and named so it
        // cannot be mistaken for it.
        cumulative_net_opened: net,
      };
    }),
    note:
      'Calendar months from chain header timestamps. Channels with an undated open or close block are omitted from that side of the count; compare totals against /summary.',
  };
}

/**
 * How concentrated the network is, by channel count and by capacity.
 *
 * Reported over nodes visible in gossip, which is the only place node identity
 * exists — so this describes the announced network, not the whole archive. Three
 * measures rather than one because they disagree usefully: a top-N share is legible,
 * HHI is the standard, and neither survives being quoted without `nodes`.
 *
 * On both networks this is currently dominated by a handful of participants, and on
 * testnet by a two-node test harness. That is the finding, but it is also a warning:
 * a concentration figure over 6 nodes is arithmetic, not economics.
 */
function concentration(c: Ctx) {
  const rows = all<{ pubkey: string; node_name: string | null }>(
    c.net,
    'SELECT pubkey, node_name FROM node',
  );
  const chans = all<{ node1_pubkey: string | null; node2_pubkey: string | null; capacity: string | null }>(
    c.net,
    'SELECT node1_pubkey, node2_pubkey, capacity FROM channel WHERE close_kind IS NULL AND node1_pubkey IS NOT NULL',
  );

  const cap = new Map<string, number>();
  const cnt = new Map<string, number>();
  for (const ch of chans) {
    const v = hexToNumber(ch.capacity) ?? 0;
    for (const p of [ch.node1_pubkey, ch.node2_pubkey]) {
      if (!p) continue;
      cap.set(p, (cap.get(p) ?? 0) + v);
      cnt.set(p, (cnt.get(p) ?? 0) + 1);
    }
  }

  const measure = (m: Map<string, number>) => {
    const vals = [...m.values()].sort((a, b) => b - a);
    const total = vals.reduce((a, b) => a + b, 0);
    if (total === 0) return null;
    const share = (k: number) => Number((vals.slice(0, k).reduce((a, b) => a + b, 0) / total).toFixed(4));
    // Herfindahl–Hirschman index on shares, 0..1. 1 means one participant holds all.
    const hhi = vals.reduce((acc, v) => acc + (v / total) ** 2, 0);
    return {
      participants: vals.length,
      total,
      top1_share: share(1),
      top3_share: share(3),
      top10_share: share(10),
      hhi: Number(hhi.toFixed(4)),
    };
  };

  const named = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([pubkey, value]) => ({
        pubkey,
        node_name: rows.find((r) => r.pubkey === pubkey)?.node_name || null,
        value,
      }));

  return {
    scope: {
      nodes_in_gossip: rows.length,
      announced_open_channels: chans.length,
      note:
        'Covers only channels currently announced in gossip, because node identity exists nowhere else. It is not the whole archive — compare /summary.channels.open.',
      why_participants_can_exceed_nodes:
        'A channel keeps both pubkeys after a node stops announcing itself, so `participants` counts every pubkey holding an announced open channel and can exceed `nodes_in_gossip`. Neither number is wrong; they answer different questions.',
    },
    by_capacity_shannons: { ...(measure(cap) ?? {}), top: named(cap) },
    by_channel_count: { ...(measure(cnt) ?? {}), top: named(cnt) },
    caveats: [
      'A concentration figure over a handful of nodes is arithmetic, not economics. Read `participants` first.',
      'On testnet two nodes form a test harness holding an order of magnitude more channels than any real participant; they dominate every ranking here.',
      'Capacity is an upper bound, never a balance (A+04).',
    ],
  };
}

/**
 * Force-closes whose commitment cell has never been seen spent.
 *
 * A force-close puts funds in a commitment cell; until that cell is spent, they
 * have not moved. These are the channels where that has not happened — on mainnet a
 * genuine operational alert, on testnet mostly abandoned experiments. Served as a
 * list rather than a count so it is actionable, and dated so age is visible.
 *
 * "Never seen spent" is a statement about this archive, not proof funds are stuck:
 * a spend in a block after the scan's cursor would not be here yet.
 */
function unresolved(c: Ctx) {
  const limit = intParam(c.url, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const offset = intParam(c.url, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const rows = all<Record<string, unknown>>(
    c.net,
    `SELECT cc.commitment_outpoint, cc.channel_outpoint, cc.created_tx_hash, cc.created_block,
            cc.capacity AS capacity_shannons,
            ch.node1_pubkey, ch.node2_pubkey,
            bt.timestamp_ms AS created_block_timestamp_ms
       FROM commitment_cell cc
       LEFT JOIN channel ch ON ch.channel_outpoint = cc.channel_outpoint
       ${timeJoin('bt', 'cc.created_block')}
      WHERE cc.spend_kind IS NULL
      ORDER BY cc.created_block DESC, cc.commitment_outpoint
      LIMIT ? OFFSET ?`,
    limit,
    offset,
  );
  const total = one<{ n: number; oldest: number | null }>(
    c.net,
    `SELECT COUNT(*) AS n, MIN(bt.timestamp_ms) AS oldest
       FROM commitment_cell cc LEFT JOIN block_time bt ON bt.block_number = cc.created_block
      WHERE cc.spend_kind IS NULL`,
  )!;
  const now = Date.now();
  return {
    total: total.n,
    limit,
    offset,
    oldest_created_at: total.oldest ? new Date(total.oldest).toISOString() : null,
    what_this_is:
      'Commitment cells created by a force-close that this archive has never seen spent. Funds in them have not moved. This is a statement about our scan, not proof that they are permanently stuck.',
    commitment_cells: rows.map((r) => {
      const withDate = decimalCapacity(withTime(r, 'created_block'));
      const at = withDate['created_block_at'];
      return {
        ...withDate,
        age_days:
          typeof at === 'string' ? Number(((now - Date.parse(at)) / 86400000).toFixed(1)) : null,
      };
    }),
  };
}

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

  /**
   * Nothing observed is reported as nothing observed, never as zero failures.
   *
   * This is the single most dangerous line in the API. A per-node query filters on
   * `node1_pubkey OR node2_pubkey`, which only ever matches `node_pair` events — and
   * across all of testnet exactly 1 force-close and 0 penalties carry that level.
   * `SUM()` over no rows is NULL, so coercing to 0 would render, for essentially
   * every node in existence, `force_close: 0, penalty: 0` — a clean bill of health
   * issued on no evidence, which is worse than saying nothing. Absence of data and
   * absence of failure are different claims and are returned as different shapes.
   */
  const observedEvents = counts.total ?? 0;
  if (observedEvents === 0) {
    return {
      window: { blocks: windowBlocks, from_block: since, to_block: tip },
      observed: false,
      counts: null,
      rates: null,
      node_attributed_events: 0,
      no_data_reason: pubkey
        ? 'No on-chain event in this window is attributable to this node. Attribution needs the channel present in gossip while it was open (SPEC-FAULTLINE §3.1); most closes predate any observation of them. This is not a clean record — it is no record.'
        : 'No on-chain event falls in this window.',
      caveats: CAVEATS,
    };
  }

  const closes = (counts.coop ?? 0) + (counts.force ?? 0);
  const rate = (n: number | null) => (closes === 0 ? null : Number(((n ?? 0) / closes).toFixed(4)));

  return {
    window: { blocks: windowBlocks, from_block: since, to_block: tip },
    observed: true,
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
    caveats: CAVEATS,
  };
}

const CAVEATS = [
  'A force-close is evidence, not proof of misbehaviour: a peer going offline forces one too (SPEC-FAULTLINE §4.5).',
  'Successes are never counted. No off-chain success is creditable, so absence of failure is the only positive signal.',
  'Rates are windowed. There is deliberately no lifetime figure; see SPEC-FAULTLINE §4.1.',
  'observed=false means no attributable evidence exists, NOT that the node has a clean record.',
];

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
  const limit = intParam(c.url, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const offset = intParam(c.url, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const rows = all<Record<string, unknown>>(
    c.net,
    `SELECT ch.channel_outpoint, ch.node1_pubkey, ch.node2_pubkey,
            ch.capacity AS capacity_shannons, ch.open_block, ch.close_kind, ch.close_block,
            ot.timestamp_ms AS open_block_timestamp_ms,
            ct.timestamp_ms AS close_block_timestamp_ms
       FROM channel ch
       ${timeJoin('ot', 'ch.open_block')}
       ${timeJoin('ct', 'ch.close_block')}
      WHERE ch.node1_pubkey = ? OR ch.node2_pubkey = ?
      ORDER BY COALESCE(ch.close_block, ch.open_block) DESC, ch.channel_outpoint
      LIMIT ? OFFSET ?`,
    pubkey,
    pubkey,
    limit,
    offset,
  );
  // Previously capped at 500 with no total, so a node with more channels than that
  // silently showed a truncated list that read as complete.
  const total = one<{ n: number }>(
    c.net,
    'SELECT COUNT(*) AS n FROM channel WHERE node1_pubkey = ? OR node2_pubkey = ?',
    pubkey,
    pubkey,
  )!.n;
  const w = intParam(c.url, 'window_blocks', 200_000, 10_000_000);
  return {
    node: n,
    channels: {
      total,
      limit,
      offset,
      items: rows.map((r) => decimalCapacity(withTime(r, 'open_block', 'close_block'))),
    },
    live_policy: nodePolicy(c, pubkey),
    location: nodeLocations(c, (n['addresses_json'] as string | null) ?? null),
    uptime: nodeUptime(c, pubkey),
    capacity_is_not_balance:
      'capacity_shannons is the channel total, an upper bound. Fiber does not broadcast balances, so no field here is spendable liquidity (SPEC-ATLAS §5.1, A+04).',
    faultline: reliability(c.net, pubkey, w),
  };
}

/**
 * What this node's channels currently announce: routing enabled, and at what fee.
 *
 * The only fast-moving data the project holds. Everything else here is either
 * settled history or a slowly-growing archive; `channel_update` changes between
 * gossip polls, which is what makes a live dashboard worth refreshing at all.
 *
 * Scoped to live gossip by construction — `channel_update` only ever has rows for
 * channels currently announced — so the counts describe now, not the archive.
 */
function nodePolicy(c: Ctx, pubkey: string) {
  const rows = all<{
    channel_outpoint: string; enabled: number | null; fee_rate: string | null; timestamp: number | null;
  }>(
    c.net,
    `SELECT u.channel_outpoint, u.enabled, u.fee_rate, u.timestamp
       FROM channel_update u
       JOIN channel ch ON ch.channel_outpoint = u.channel_outpoint
      WHERE ch.node1_pubkey = ? OR ch.node2_pubkey = ?`,
    pubkey,
    pubkey,
  );

  // Aggregated here rather than in SQL because fee_rate is stored as the hex string
  // gossip carries ("0x3e8"). SQLite's CAST(... AS INTEGER) reads that as 0 and
  // reports every node's fee floor as zero — wrong, and wrong in a direction a
  // reader would act on.
  const fees = rows.map((r) => hexToNumber(r.fee_rate)).filter((n): n is number => n !== null);
  const stamps = rows.map((r) => r.timestamp).filter((t): t is number => typeof t === 'number');
  return {
    announced_channels: new Set(rows.map((r) => r.channel_outpoint)).size,
    directions: {
      total: rows.length,
      enabled: rows.filter((r) => r.enabled === 1).length,
      disabled: rows.filter((r) => r.enabled === 0).length,
      unknown: rows.filter((r) => r.enabled === null).length,
    },
    fee_rate_shannons_per_kb: fees.length
      ? { min: Math.min(...fees), max: Math.max(...fees) }
      : null,
    newest_update_at: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
    note:
      'A direction with no row is unknown, not disabled (SPEC-ATLAS §3). Both are counted separately above. Covers only channels currently in gossip.',
  };
}

/**
 * Capacity is archived as the chain's hex string. Serve it as a number.
 *
 * `capacity_shannons: "0x18ba036600"` is a field whose name promises a unit and
 * whose value is a string in another base — `Number(x)` on it yields NaN and
 * `parseInt(x)` yields 0. Converted once, here, so no consumer has to know.
 */
function decimalCapacity(row: Record<string, unknown>): Record<string, unknown> {
  if (!('capacity_shannons' in row)) return row;
  return { ...row, capacity_shannons: hexToNumber(row['capacity_shannons'] as string | null) };
}

/** Gossip carries these as hex strings. Returns null rather than 0 for anything unparseable. */
function hexToNumber(v: string | null | undefined): number | null {
  if (typeof v !== 'string' || v === '') return null;
  try {
    const n = Number(BigInt(v));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
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
    `SELECT ch.channel_outpoint, ch.node1_pubkey, ch.node2_pubkey,
            ch.capacity AS capacity_shannons, ch.open_block, ch.close_kind, ch.close_block,
            ot.timestamp_ms AS open_block_timestamp_ms,
            ct.timestamp_ms AS close_block_timestamp_ms,
            (SELECT COUNT(*) FROM channel_update u
              WHERE u.channel_outpoint = ch.channel_outpoint) AS announced_directions
       FROM channel ch
       ${timeJoin('ot', 'ch.open_block')}
       ${timeJoin('ct', 'ch.close_block')}
       ${where}
      -- channel_outpoint breaks the tie: COALESCE(close, open) collides constantly,
      -- and without a total order LIMIT/OFFSET can repeat or skip rows between pages.
      ORDER BY COALESCE(ch.close_block, ch.open_block) DESC, ch.channel_outpoint
      LIMIT ? OFFSET ?`,
    limit,
    offset,
  );
  const total = one<{ n: number }>(c.net, `SELECT COUNT(*) AS n FROM channel ch ${where}`)!.n;
  return {
    total,
    limit,
    offset,
    capacity_is_not_balance:
      'capacity_shannons is an upper bound, never spendable liquidity (A+04).',
    channels: rows.map((r) => decimalCapacity(withTime(r, 'open_block', 'close_block'))),
  };
}

function channel(c: Ctx, outpoint: string) {
  const ch = one<Record<string, unknown>>(
    c.net,
    `SELECT ch.*, ch.capacity AS capacity_shannons,
            ot.timestamp_ms AS open_block_timestamp_ms,
            ct.timestamp_ms AS close_block_timestamp_ms
       FROM channel ch
       ${timeJoin('ot', 'ch.open_block')}
       ${timeJoin('ct', 'ch.close_block')}
      WHERE ch.channel_outpoint = ?`,
    outpoint,
  );
  if (!ch) return null;
  const events = all<Record<string, unknown>>(
    c.net,
    `SELECT e.kind, e.block_number, e.tx_hash, e.attribution, e.detail,
            bt.timestamp_ms AS block_timestamp_ms
       FROM event_attributed e
       ${timeJoin('bt', 'e.block_number')}
      WHERE e.channel_outpoint = ? ORDER BY e.block_number, e.id`,
    outpoint,
  );
  return {
    channel: decimalCapacity(withTime(ch, 'open_block', 'close_block')),
    events: events.map((e) => withTime(e, 'block')),
    updates: channelUpdates(c, outpoint),
  };
}

/**
 * Per-direction routing policy as last announced.
 *
 * Ingested since the first gossip pass and, until now, served by nothing — the only
 * data in the archive that changes between polls was the only data with no route to
 * a consumer.
 */
function channelUpdates(c: Ctx, outpoint: string) {
  const rows = all<{
    direction: number; timestamp: number | null; enabled: number | null;
    fee_rate: string | null; tlc_minimum_value: string | null; tlc_expiry_delta: string | null;
    last_seen: number;
  }>(
    c.net,
    `SELECT direction, timestamp, enabled, fee_rate, tlc_minimum_value, tlc_expiry_delta, last_seen
       FROM channel_update WHERE channel_outpoint = ? ORDER BY direction`,
    outpoint,
  );
  const present = new Set(rows.map((r) => r.direction));
  return {
    directions: rows.map((r) => ({
      direction: r.direction,
      enabled: r.enabled === null ? null : r.enabled === 1,
      fee_rate_shannons_per_kb: hexToNumber(r.fee_rate),
      tlc_minimum_value_shannons: hexToNumber(r.tlc_minimum_value),
      tlc_expiry_delta_ms: hexToNumber(r.tlc_expiry_delta),
      announced_at: r.timestamp ? new Date(r.timestamp).toISOString() : null,
      last_seen_at: new Date(r.last_seen).toISOString(),
    })),
    // SPEC-ATLAS §3: a missing direction and a disabled direction are different
    // claims, and collapsing them would turn "we have not heard" into "it is down".
    missing_directions: [1, 2].filter((d) => !present.has(d)),
    note:
      'A direction listed in missing_directions is UNKNOWN, not disabled. Rows exist only while the channel is announced in gossip; a closed channel has none.',
  };
}

function events(c: Ctx) {
  const limit = intParam(c.url, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const kind = c.url.searchParams.get('kind');
  const kinds = ['cooperative_close', 'force_close', 'penalty', 'settlement'];
  const filtered = kind !== null && kinds.includes(kind);

  const clauses: string[] = [];
  const args: unknown[] = [];
  if (filtered) {
    clauses.push('e.kind = ?');
    args.push(kind);
  }

  /**
   * Keyset pagination on (block_number, id).
   *
   * Block number alone is not unique — 93k testnet events land in 54k blocks — so
   * `ORDER BY block_number DESC` is not a total order, and LIMIT/OFFSET over it can
   * return a row twice or skip it entirely as pages are fetched. `id` breaks every
   * tie. `offset` still works because the order is now total, but `after` is what a
   * client walking the whole feed should use: it is stable even if the scanner
   * inserts new rows mid-walk.
   */
  const after = c.url.searchParams.get('after');
  if (after !== null) {
    const m = /^(\d+)\.(\d+)$/.exec(after);
    if (!m) return { error: 'bad cursor: expected "<block_number>.<id>" from next_cursor' };
    clauses.push('(e.block_number < ? OR (e.block_number = ? AND e.id < ?))');
    args.push(Number(m[1]), Number(m[1]), Number(m[2]));
  }
  const offset = after === null ? intParam(c.url, 'offset', 0, Number.MAX_SAFE_INTEGER) : 0;
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = all<Record<string, unknown>>(
    c.net,
    `SELECT e.id, e.kind, e.block_number, e.tx_hash, e.channel_outpoint,
            e.node1_pubkey, e.node2_pubkey, e.attribution, e.detail,
            bt.timestamp_ms AS block_timestamp_ms
       FROM event_attributed e
       ${timeJoin('bt', 'e.block_number')}
       ${where}
      ORDER BY e.block_number DESC, e.id DESC
      LIMIT ? OFFSET ?`,
    ...args,
    limit,
    offset,
  );
  const last = rows[rows.length - 1];
  return {
    total: one<{ n: number }>(
      c.net,
      `SELECT COUNT(*) AS n FROM event_attributed e ${filtered ? 'WHERE e.kind = ?' : ''}`,
      ...(filtered ? [kind] : []),
    )!.n,
    limit,
    offset,
    next_cursor:
      rows.length === limit && last ? `${last['block_number']}.${last['id']}` : null,
    // F-02 / F+04: attribution travels with every event, and unattributed events are
    // served rather than hidden — they are real, verifiable, on-chain facts that
    // simply name no node.
    attribution_levels: {
      node_pair: 'Attributable to {node1, node2}. The only level supporting a per-node claim.',
      channel: 'Channel identified, but absent from gossip. Real event, names no node.',
      unattributed: 'No channel outpoint. Quarantined, never dropped.',
    },
    events: rows.map((r) => withTime(r, 'block')),
  };
}

/** The era analysis — the project's most useful output, and network-scoped by nature. */
/**
 * Below this, an era's rate is reported as null rather than as a number.
 *
 * Mainnet's earliest era holds 4 closes. Three of them force-closing prints a 75%
 * bar next to eras built from thousands, and a reader comparing bar heights has no
 * way to see that one of them is noise. The counts are still served — they are
 * facts — but the derived rate is withheld, because a rate is an invitation to
 * compare and this one cannot survive the comparison.
 */
const MIN_ERA_SAMPLES = 30;

function eras(c: Ctx) {
  const rows = all<{ era: number; n: number; force: number; from_ms: number | null; to_ms: number | null }>(
    c.net,
    `SELECT ch.close_block / 1000000 AS era,
            COUNT(*) AS n,
            SUM(ch.close_kind = 'force_close') AS force,
            MIN(bt.timestamp_ms) AS from_ms,
            MAX(bt.timestamp_ms) AS to_ms
       FROM channel ch
       ${timeJoin('bt', 'ch.close_block')}
      WHERE ch.close_kind IS NOT NULL GROUP BY era ORDER BY era`,
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
    era_definition:
      'An era is a 1,000,000-block bucket of the channel CLOSE height — a unit of chain progress, not a calendar month. observed_from/observed_to are the real header timestamps of the earliest and latest close in the bucket, so bucket widths in wall-clock time are unequal.',
    min_samples_for_rate: MIN_ERA_SAMPLES,
    eras: rows.map((r) => ({
      block_era: `${r.era}M`,
      block_range: [r.era * 1_000_000, (r.era + 1) * 1_000_000 - 1],
      observed_from: r.from_ms ? new Date(r.from_ms).toISOString() : null,
      observed_to: r.to_ms ? new Date(r.to_ms).toISOString() : null,
      closes: r.n,
      force_closes: r.force,
      force_close_rate: r.n >= MIN_ERA_SAMPLES ? Number((r.force / r.n).toFixed(4)) : null,
      rate_suppressed_reason:
        r.n >= MIN_ERA_SAMPLES ? null : `only ${r.n} closes; below the ${MIN_ERA_SAMPLES}-sample floor`,
      penalties: pmap.get(r.era) ?? 0,
    })),
  };
}

/**
 * Nodes ranked as LSP candidates (SPEC-ATLAS §6).
 *
 * The spec ranks on four signals: auto-accept, capacity, liveness, and Faultline.
 * Three are served here. The fourth is not, and the omission is the point: across
 * all of testnet exactly one force-close and no penalties are attributable to a
 * node pair, so a Faultline component would be a reliability score computed from
 * essentially no evidence — precisely the false confidence this ranking would be
 * used to make a funding decision on. It is excluded rather than zero-filled, and
 * the response says so.
 *
 * This is a candidate list, not a recommendation: everything in it is self-reported
 * by the node in gossip.
 */
function lsps(c: Ctx) {
  const limit = intParam(c.url, 'limit', DEFAULT_LIMIT, MAX_LIMIT);
  const rows = all<{
    pubkey: string; node_name: string | null; version: string | null;
    auto_accept_min_ckb: string | null; last_seen: number; open_channels: number;
  }>(
    c.net,
    `SELECT n.pubkey, n.node_name, n.version, n.auto_accept_min_ckb, n.last_seen,
            (SELECT COUNT(*) FROM channel ch
              WHERE (ch.node1_pubkey = n.pubkey OR ch.node2_pubkey = n.pubkey)
                AND ch.close_kind IS NULL) AS open_channels
       FROM node n
      ORDER BY open_channels DESC, n.pubkey
      LIMIT ?`,
    limit,
  );

  // Summed here, not in SQL: capacity is stored as the hex string the chain uses
  // ("0x18ba036600"), and SUM(CAST(... AS INTEGER)) over that is 0 for every row.
  const cap = new Map<string, number>();
  for (const r of all<{ node1_pubkey: string | null; node2_pubkey: string | null; capacity: string | null }>(
    c.net,
    `SELECT node1_pubkey, node2_pubkey, capacity FROM channel
      WHERE close_kind IS NULL AND node1_pubkey IS NOT NULL`,
  )) {
    const v = hexToNumber(r.capacity);
    if (v === null) continue;
    for (const p of [r.node1_pubkey, r.node2_pubkey]) {
      if (p) cap.set(p, (cap.get(p) ?? 0) + v);
    }
  }
  return {
    total: one<{ n: number }>(c.net, 'SELECT COUNT(*) AS n FROM node')!.n,
    limit,
    excluded_signal: {
      signal: 'faultline',
      reason:
        'SPEC-ATLAS §6 lists Faultline as a ranking input. It is deliberately omitted: node-level attribution covers 1 force-close and 0 penalties across the entire archive, so any reliability term would rank on noise. See /v0/{network}/summary → attribution.',
    },
    candidates: rows.map((r) => ({
      pubkey: r.pubkey,
      node_name: r.node_name,
      version: r.version,
      auto_accept_min_ckb: r.auto_accept_min_ckb,
      auto_accepts: r.auto_accept_min_ckb !== null,
      open_channels: r.open_channels,
      announced_capacity_shannons: cap.get(r.pubkey) ?? null,
      last_seen_at: new Date(r.last_seen).toISOString(),
    })),
    capacity_is_not_balance:
      'announced_capacity_shannons is the sum of channel totals, an upper bound. It is not inbound liquidity and not a balance (A+04).',
    self_reported:
      'auto_accept_min_ckb, node_name and version are what the node announces about itself. Nothing here is verified against its behaviour.',
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
      // Renamed from `publicly_announced_share`, which read as a property of the
      // network but is a property of our archive: the denominator is "channels this
      // scan has seen open", so the figure moves while a backfill runs and is not
      // comparable across networks or across time. Numerator and denominator are
      // both published so the ratio cannot travel without them.
      public_share_of_known_open: {
        value: ch.open ? Number((gossip.live_public / ch.open).toFixed(4)) : null,
        numerator: gossip.live_public,
        denominator: ch.open,
        warning:
          'Ratio of two differently-scoped sets: gossip sees only live public channels now, while the denominator is every channel this archive has not seen close. It moves as the backfill progresses. Do not quote as "% of Fiber channels are public".',
      },
    },
    time_coverage: (() => {
      const t = c.net.store.blockTimeCoverage();
      return {
        ...t,
        complete: t.referenced === t.resolved,
        note:
          'Blocks whose header timestamp has been fetched. Timestamps are never interpolated: an unresolved block is served as null. Any date axis drawn while complete=false has gaps.',
      };
    })(),
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

export function createApi(
  networks: NetworkStore[],
  opts: { version?: string; pending?: string[] } = {},
) {
  const pending = new Set(opts.pending ?? []);
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

    // Percent-decoded per segment. A channel_outpoint contains a ':' — the separator
    // between tx hash and index — and any correct client encodes it as %3A, which
    // without this decode never matches a stored key and 404s on a channel that
    // exists.
    const seg = url.pathname
      .split('/')
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s; // malformed escape: leave as-is and let the lookup miss honestly
        }
      });

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
            '/v0/{network}/lsps',
            '/v0/{network}/liveness',
            '/v0/{network}/distribution',
            '/v0/{network}/geo',
            '/v0/{network}/activity',
            '/v0/{network}/concentration',
            '/v0/{network}/channels?status=open|closed',
            '/v0/{network}/channels/{outpoint}',
            '/v0/{network}/channels/{outpoint}/updates',
            '/v0/{network}/faultline/events?kind=penalty|force_close|cooperative_close&after={cursor}',
            '/v0/{network}/faultline/penalties',
            '/v0/{network}/faultline/timing',
            '/v0/{network}/faultline/unresolved',
            '/v0/{network}/faultline/nodes/{pubkey}',
          ],
          reading_the_data: {
            time:
              'Block timestamps come from chain headers and are never interpolated. A null *_at means the header has not been fetched, not that the event is undated. Check summary.time_coverage before drawing a date axis.',
            attribution:
              'An event names nodes only at attribution=node_pair. Node-level reliability is near-empty by construction; faultline responses carry observed=false rather than zero counts.',
            units:
              'capacity_shannons and fee_rate_shannons_per_kb are decimal numbers. 1 CKB = 100,000,000 shannons. Capacity is never a balance (A+04).',
          },
        });
      }

      if (seg.length === 1 && seg[0] === 'health') {
        const health = [...byName.values()].map((net) => {
          const sync = one<{ last_run_at: number | null; channels_seen: number | null }>(
            net,
            'SELECT last_run_at, channels_seen FROM gossip_sync WHERE id = 1',
          );
          const tip = one<{ hi: number | null }>(net, 'SELECT MAX(block_number) AS hi FROM event');

          // Scan-cursor state, exposed because "the database exists" and "the scan
          // has finished" are different facts, and only the second makes a count
          // safe to quote. A mid-backfill store answers every query successfully
          // with figures that are simply too low — indistinguishable, without this,
          // from a network that genuinely has fewer channels. A reviewer comparing
          // a partial testnet scan against the published totals reasonably concluded
          // the deployment contradicted its own specs.
          const cursors = all<{ scan_key: string; updated_at: number; started: number }>(
            net,
            `SELECT scan_key, updated_at, (last_cursor IS NOT NULL) AS started FROM scan_cursor`,
          );
          const counts = one<{ channels: number; events: number }>(
            net,
            'SELECT (SELECT COUNT(*) FROM channel) AS channels, (SELECT COUNT(*) FROM event) AS events',
          );

          const bt = net.store.blockTimeCoverage();

          return {
            network: net.name,
            l1_max_event_block: tip?.hi ?? null,
            gossip_last_run_at: sync?.last_run_at ?? null,
            gossip_channels_seen: sync?.channels_seen ?? null,
            // Surfaced next to the scan cursors because it lags them: every scan pass
            // discovers blocks the block-time pass has not fetched yet, so a dashboard
            // polling /health can tell "dates are incomplete" from "dates are missing".
            block_time: {
              ...bt,
              complete: bt.referenced === bt.resolved,
            },
            l1_scan: {
              channels_known: counts?.channels ?? 0,
              events_known: counts?.events ?? 0,
              cursors: cursors.map((c) => ({ scan: c.scan_key, last_advanced_at: c.updated_at })),
              // Deliberately not a boolean "complete". Completeness cannot be proven
              // from the cursor alone, and asserting it falsely is worse than saying
              // when the scan last moved and letting the consumer judge.
              note:
                'A scan still advancing means counts are lower bounds. Compare last_advanced_at across polls: if it keeps moving, the backfill is still running.',
            },
          };
        });
        return send(res, 200, {
          ok: true,
          networks: health,
          // Renamed from "backfilling", which claimed more than it checked: it only
          // ever listed networks with no database file at all, and read as "no scan
          // in progress" when a scan was in fact mid-flight.
          networks_without_data: [...pending],
        });
      }

      if (seg[0] !== 'v0') return send(res, 404, { error: 'not found' });

      const wanted = seg[1] ?? '';
      const net = byName.get(wanted);
      if (!net) {
        if (pending.has(wanted)) {
          return send(res, 503, {
            error: `network '${wanted}' is still backfilling and has no data yet`,
            network: wanted,
            retry: 'poll /health; this becomes available when the first scan completes',
          });
        }
        return send(res, 404, {
          error: `unknown network '${wanted}'`,
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
      if (rest.length === 1 && rest[0] === 'lsps') return wrap(lsps(c));
      if (rest.length === 1 && rest[0] === 'liveness') return wrap(liveness(c));
      if (rest.length === 1 && rest[0] === 'distribution') return wrap(distribution(c));
      if (rest.length === 1 && rest[0] === 'geo') return wrap(geo(c));
      if (rest.length === 1 && rest[0] === 'activity') return wrap(activity(c));
      if (rest.length === 1 && rest[0] === 'concentration') return wrap(concentration(c));
      if (rest.length === 1 && rest[0] === 'channels') return wrap(channels(c));
      if (rest.length === 2 && rest[0] === 'channels') {
        const ch = channel(c, rest[1] as string);
        return ch ? wrap(ch) : send(res, 404, { error: 'channel not found', network: net.name });
      }
      if (rest.length === 3 && rest[0] === 'channels' && rest[2] === 'updates') {
        const outpoint = rest[1] as string;
        const exists = one<{ n: number }>(
          c.net,
          'SELECT COUNT(*) AS n FROM channel WHERE channel_outpoint = ?',
          outpoint,
        )!.n;
        if (!exists) return send(res, 404, { error: 'channel not found', network: net.name });
        return wrap({ channel_outpoint: outpoint, ...channelUpdates(c, outpoint) });
      }
      if (rest.length === 2 && rest[0] === 'faultline' && (rest[1] === 'events' || rest[1] === 'penalties')) {
        if (rest[1] === 'penalties') url.searchParams.set('kind', 'penalty');
        const body = events(c);
        // A malformed cursor is the client's error and must not be answered 200 with
        // an `error` key that a happy path would parse straight past.
        if ('error' in body) return send(res, 400, { network: net.name, ...body });
        return wrap(body);
      }
      if (rest.length === 2 && rest[0] === 'faultline' && rest[1] === 'unresolved') {
        return wrap(unresolved(c));
      }
      if (rest.length === 2 && rest[0] === 'faultline' && rest[1] === 'timing') {
        return wrap(faultlineTiming(c));
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

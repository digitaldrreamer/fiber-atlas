/*
 * Fiber Atlas — read-only observatory for the Fiber Network on CKB.
 *
 * No framework, no build step, no dependencies: the rest of this project runs
 * TypeScript straight off disk under Node 24 with nothing installed, and the
 * frontend keeps that property. It is a hash-routed page over the same public
 * JSON the API serves to everyone else.
 *
 * The design constraints that shape almost every rendering decision below live in
 * specs/SPEC-FRONTEND.md §4. Four of them account for most of the odd-looking code:
 *
 *   §4.1  A figure never appears without its network. The network is in the URL,
 *         in the header, in the footer, and in every chart caption.
 *   §4.2  The lifetime force-close rate is rendered struck through, never as a
 *         usable number, and never hidden — hiding it just means someone divides
 *         the two counts themselves.
 *   §4.3  Where the API says observed:false, this renders the absence and its
 *         reason. Never a zero, never a tick, never an empty bar at 0%.
 *   §4.6  A rate the API suppressed for small n is never drawn as a bar.
 *
 * The one thing this file must never do is invent. Where a field is null, the
 * screen says so; there is no placeholder arithmetic anywhere in here.
 */
'use strict';

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const API = (() => {
  const q = new URLSearchParams(location.search).get('api');
  if (q) return q.replace(/\/$/, '');
  const meta = document.querySelector('meta[name="fiber-atlas-api"]');
  const m = meta && meta.getAttribute('content');
  return m ? m.replace(/\/$/, '') : '';
})();

/**
 * Which networks exist is the server's fact, not this file's.
 *
 * `/health` reports the networks actually being served plus, separately, the ones
 * configured but still backfilling. Both belong in the switch: a network that is
 * merely mid-scan should be reachable so its 503 can explain itself, rather than
 * vanishing from the UI with no account of where it went.
 *
 * The literal below is a fallback for one case only — `/health` unreachable — so
 * that a dead API still routes to a page capable of saying so, instead of a blank
 * one. It is never treated as the truth while the server can be asked.
 */
const FALLBACK_NETWORKS = ['mainnet', 'testnet'];
let NETWORKS = FALLBACK_NETWORKS.slice();
let PENDING = new Set();

async function loadNetworks() {
  try {
    const h = await get('/health');
    const live = (h.networks || []).map((n) => n.network).filter(Boolean);
    const pending = (h.networks_without_data || []).filter(Boolean);
    const all = [...live, ...pending];
    if (!all.length) return; // serving nothing yet: keep the fallback, not an empty switch
    // Mainnet leads when it is served. Config order is an implementation detail of
    // the scanner, and the switch is the most consequential control on the site —
    // its order should not shuffle because someone reordered a config object.
    NETWORKS = all.sort((a, b) => (a === 'mainnet' ? -1 : b === 'mainnet' ? 1 : all.indexOf(a) - all.indexOf(b)));
    PENDING = new Set(pending);
  } catch {
    /* keep the fallback */
  }
}

/** Testnet is the richer archive and the design's default; fall back if unserved. */
const defaultNet = () => (NETWORKS.includes('testnet') ? 'testnet' : NETWORKS[0] || 'testnet');

/** Responses are immutable snapshots for the life of a page view; cache by URL. */
const cache = new Map();

function apiUrl(path) {
  return API + path;
}

async function get(path) {
  if (cache.has(path)) return cache.get(path);
  const p = (async () => {
    const res = await fetch(apiUrl(path), { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((body && body.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  })();
  cache.set(path, p);
  p.catch(() => cache.delete(path)); // a failure must not be cached as an answer
  return p;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const SHANNONS = 100000000;

/**
 * The sample floor the API applies to era rates, mirrored here for the one figure
 * the API does not suppress: a node's windowed force-close ratio. It is not used
 * to withhold anything the API published — the counts and the rate both render —
 * only to say plainly when a ratio is built on too few closes to compare against
 * another node's. Read from /eras where that payload is in hand.
 */
const DEFAULT_SAMPLE_FLOOR = 30;

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

/** Shannons to CKB. Never called "balance", "available" or "liquidity" (§4.5). */
function ckb(shannons) {
  if (shannons == null) return '—';
  const c = Number(shannons) / SHANNONS;
  if (c >= 1e6) return (c / 1e6).toFixed(1) + 'M CKB';
  if (c >= 1e4) return Math.round(c / 1e3).toLocaleString('en-US') + 'k CKB';
  if (c >= 1) return Math.round(c).toLocaleString('en-US') + ' CKB';
  return c.toFixed(2) + ' CKB';
}

/** A rate the API published. A rate it suppressed never reaches this function. */
const pct = (v, dp = 1) => (v == null ? '—' : (v * 100).toFixed(dp) + '%');

/**
 * `auto_accept_min_ckb` is a hex u64 and, despite the field name, it is denominated
 * in shannons: fnn's default is 0x2540be400 = 10,000,000,000, which is 100 CKB, not
 * ten billion. Converting it as CKB puts a number larger than the total supply on
 * the page, so the name is ignored and the unit is taken from the value.
 */
function autoAcceptShannons(hex) {
  if (hex == null) return null;
  const n = typeof hex === 'string' ? parseInt(hex, 16) : Number(hex);
  return Number.isFinite(n) ? n : null;
}

const short = (hex, head = 6, tail = 4) =>
  !hex ? '—' : hex.length <= head + tail + 1 ? hex : hex.slice(0, head) + '…' + hex.slice(-tail);

/** Outpoints are "<64-hex tx>:<index>"; the index is meaning, the middle is not. */
function shortOutpoint(op) {
  if (!op) return '—';
  const i = op.lastIndexOf(':');
  if (i === -1) return short(op, 8, 4);
  return short(op.slice(0, i), 8, 4) + ':' + op.slice(i + 1);
}

const ms = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v) || null);

/** Dates degrade to "unknown", never to a guess: an unfetched header has no date. */
function date(v) {
  const t = ms(v);
  return t == null ? 'unknown' : new Date(t).toISOString().slice(0, 10);
}

function datetime(v) {
  const t = ms(v);
  return t == null ? 'unknown' : new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

function ago(v, now = Date.now()) {
  const t = ms(v);
  if (t == null) return 'unknown';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return Math.round(s) + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  if (s < 172800) return Math.round(s / 3600) + 'h';
  if (s < 5184000) return Math.round(s / 86400) + 'd';
  return Math.round(s / 2592000) + 'mo';
}

function hours(h) {
  if (h == null) return '—';
  if (h < 1) return Math.round(h * 60) + 'min';
  if (h < 72) return (h < 10 ? h.toFixed(1) : Math.round(h)) + 'h';
  return Math.round(h / 24) + 'd';
}

function days(d) {
  if (d == null) return '—';
  const h = d * 24;
  // A presence table that started this morning reports fractions of a day. "0.0h"
  // reads as "nothing"; the honest reading is "we have been watching 12 minutes".
  if (h < 1) return Math.max(1, Math.round(h * 60)) + 'min';
  if (d < 1) return h.toFixed(1) + 'h';
  return d.toFixed(d < 10 ? 1 : 0) + 'd';
}

const KIND = {
  cooperative_close: { label: 'agreed', cls: '', meaning: 'both sides signed off — funds moved at once' },
  force_close: { label: 'force', cls: 'bad', meaning: 'one side went alone — the chain timelocked the funds' },
  penalty: { label: 'penalty', cls: 'bad', meaning: 'an old balance was published, proved, and swept' },
  settlement: { label: 'settled', cls: '', meaning: 'the timelock elapsed and the funds were collected' },
};

const CLOSE_KIND = {
  cooperative: { label: 'agreed', cls: '' },
  force_close: { label: 'force', cls: 'bad' },
};

const ATTRIBUTION = {
  node_pair: { label: 'node pair', cls: '', tip: 'Both ends known: this channel was in gossip while it was open.' },
  channel: { label: 'channel', cls: 'unknown', tip: 'Real event on a known channel, but nothing ties it to a pubkey.' },
  unattributed: { label: 'no channel', cls: 'unknown', tip: 'No channel outpoint. Kept, never dropped, never counted as a node’s.' },
};

function chip(label, cls) {
  return `<span class="chip ${cls || ''}">${esc(label)}</span>`;
}

function attributionChip(a) {
  const m = ATTRIBUTION[a] || { label: a || 'unknown', cls: 'unknown', tip: '' };
  return `<span class="chip ${m.cls}" title="${esc(m.tip)}">${esc(m.label)}</span>`;
}

/** A pubkey cell: shortened, linked, copyable. 66 hex chars are not readable. */
function pkCell(pk, opts = {}) {
  if (!pk) return `<span class="unnamed">${esc(opts.absent || 'not recorded on chain')}</span>`;
  return (
    `<a class="pk" data-go="node/${esc(pk)}" title="${esc(pk)}">${esc(short(pk, 6, 4))}</a>` +
    `<button class="copy" data-copy="${esc(pk)}" data-copy-msg="PUBKEY COPIED" title="copy full pubkey" aria-label="copy full pubkey">⧉</button>`
  );
}

function nodeName(name) {
  return name ? esc(name) : '<span class="unnamed">no name announced</span>';
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const VIEWS = [
  ['overview', 'Overview'],
  ['nodes', 'Nodes'],
  ['channels', 'Channels'],
  ['events', 'Events'],
  ['eras', 'Eras'],
  ['frozen', 'Frozen'],
  ['api', 'API'],
];

const S = { net: 'testnet', view: 'overview', id: null, params: new URLSearchParams() };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const seg = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const net = NETWORKS.includes(seg[0]) ? seg[0] : defaultNet();
  let view = seg[1] || 'overview';
  let id = null;
  if (view === 'node' || view === 'channel') id = seg.slice(2).join('/') || null;
  const known = VIEWS.some(([k]) => k === view) || view === 'node' || view === 'channel';
  if (!known) view = 'overview';
  S.net = net;
  S.view = view;
  S.id = id;
  S.params = new URLSearchParams(queryPart || '');
}

function href(view, id, params) {
  let h = '#/' + S.net + '/' + view;
  if (id) h += '/' + encodeURIComponent(id);
  const p = params ? new URLSearchParams(params).toString() : '';
  return p ? h + '?' + p : h;
}

function go(target) {
  location.hash = target.startsWith('#') ? target : '#/' + S.net + '/' + target;
}

/**
 * Keep the address bar agreeing with the page.
 *
 * A hash naming a network this deployment does not serve resolves to the default,
 * and the URL has to follow it. A link that reads `#/devnet/nodes` while the page
 * renders testnet is precisely the mislabelled-figure failure the whole project is
 * shaped to avoid — and a URL is the most copied label of all.
 */
function normaliseHash() {
  const first = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean)[0];
  if (first !== S.net) history.replaceState(null, '', href(S.view, S.id, S.params));
}

/** Changing a filter must not push a history entry per keystroke. */
function setParam(key, value) {
  const p = new URLSearchParams(S.params);
  if (value == null || value === '' || value === 'all') p.delete(key);
  else p.set(key, value);
  const path = S.view === 'node' || S.view === 'channel' ? S.view + '/' + encodeURIComponent(S.id) : S.view;
  const q = p.toString();
  history.replaceState(null, '', '#/' + S.net + '/' + path + (q ? '?' + q : ''));
  parseHash();
  render();
}

const param = (k, dflt) => S.params.get(k) || dflt;

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const app = document.getElementById('app');
let renderToken = 0;

function netLabel() {
  return S.net.toUpperCase();
}

function shell(body) {
  const tabs = VIEWS.map(([k, label]) => {
    const on = k === S.view || (k === 'nodes' && S.view === 'node') || (k === 'channels' && S.view === 'channel');
    return `<a class="${on ? 'on' : ''}" href="${href(k)}">${label}</a>`;
  }).join('');

  // Switching network from a node or channel page returns to the overview: an
  // outpoint or pubkey from one network is meaningless on the other, and carrying
  // the id across would 404 at best and show the wrong entity at worst.
  const dest = S.view === 'node' || S.view === 'channel' ? 'overview' : S.view;
  const netSwitch = NETWORKS.map((n) => {
    const pending = PENDING.has(n);
    return `<a class="pill ${S.net === n ? 'on' : ''}${pending ? ' pending' : ''}" href="#/${esc(n)}/${esc(dest)}"${
      pending ? ' title="configured but still backfilling — no data served for it yet"' : ''
    }>${esc(n.toUpperCase())}</a>`;
  }).join('');

  return `
<header class="top">
  <div class="inner">
    <div style="display:flex;align-items:center;gap:26px;min-width:0">
      <a class="brand" href="${href('overview')}">FIBER·ATLAS</a>
      <nav class="tabs">${tabs}</nav>
    </div>
    <div style="display:flex;align-items:center;gap:16px">
      <span class="freshness" id="freshness"></span>
      <div class="netswitch" role="group" aria-label="network">${netSwitch}</div>
    </div>
  </div>
</header>
<main id="main">${body}</main>`;
}

function footer(extra) {
  return `
<footer class="bottom">
  <span id="foot-left">${esc(netLabel())} · ${extra || ''}</span>
  <span>TESTNET AND MAINNET FIGURES ARE NEVER COMPARABLE</span>
</footer>`;
}

function crumb(parent, parentView, self) {
  return `<div class="crumb"><a href="${href(parentView)}">${esc(parent)}</a><span class="sep">/</span><span class="self mono">${esc(self)}</span></div>`;
}

function skeletonRows(n, cols) {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += '<div class="row">';
    for (let c = 0; c < cols; c++) out += `<div><span class="skel" style="width:${40 + ((i * 13 + c * 29) % 55)}%"></span></div>`;
    out += '</div>';
  }
  return out;
}

function loading() {
  return `<div class="card pad" style="display:flex;flex-direction:column;gap:12px">
    <span class="skel" style="width:32%;height:16px"></span>
    <span class="skel" style="width:74%"></span>
    <span class="skel" style="width:60%"></span>
  </div>`;
}

function failure(err, path) {
  const backfilling = err && err.status === 503;
  return `<div class="failed">
    <div class="tag warn">${backfilling ? 'THIS NETWORK IS STILL BACKFILLING' : 'COULD NOT READ THE API'}</div>
    <p>${esc(err && err.message ? err.message : 'unknown error')}</p>
    <p style="color:var(--dim)">${backfilling
      ? 'The scan that produces this data has not finished. Nothing is shown rather than a partial count that would read as a complete one.'
      : `Tried <code class="mono">${esc(apiUrl(path || ''))}</code>. Nothing is rendered from cache or guessed.`}</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Header freshness (§4.9 — a stale observer and a stale network are different)
// ---------------------------------------------------------------------------

async function paintFreshness() {
  const el = document.getElementById('freshness');
  if (!el) return;
  try {
    const h = await get('/health');
    const n = (h.networks || []).find((x) => x.network === S.net);
    if (!n) {
      el.innerHTML = `<span class="stale">NO DATA FOR ${esc(netLabel())}</span>`;
      return;
    }
    const heard = n.gossip_last_run_at;
    const stale = heard == null || Date.now() - heard > 3600000;
    const cov = n.block_time;
    const covTxt = cov && cov.complete ? 'L1 DATES 100%' : `L1 DATES ${cov ? Math.round((cov.resolved / Math.max(1, cov.referenced)) * 100) : '?'}%`;
    el.innerHTML =
      `<span title="Blocks whose header timestamp has been fetched. Anything below 100% means some events are undated, never mis-dated.">${esc(covTxt)}</span> · ` +
      `<span class="${stale || !cov || !cov.complete ? 'stale' : ''}" title="How long ago THIS observer last completed a gossip pass. A node going quiet and our listener going quiet look identical from here — this is ours.">HEARD ${esc(ago(heard))} AGO</span>`;
  } catch {
    el.innerHTML = '<span class="stale">API UNREACHABLE</span>';
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** The most recent era the API was willing to publish a rate for (§4.6). */
function latestRatedEra(eras) {
  for (let i = eras.length - 1; i >= 0; i--) if (eras[i].force_close_rate != null) return eras[i];
  return null;
}

async function viewOverview() {
  const [summary, erasBody, timing, nodesBody, conc, events] = await Promise.all([
    get(`/v0/${S.net}/summary`),
    get(`/v0/${S.net}/eras`),
    get(`/v0/${S.net}/faultline/timing`),
    get(`/v0/${S.net}/nodes?limit=100`),
    get(`/v0/${S.net}/concentration`),
    get(`/v0/${S.net}/faultline/events?limit=9`),
  ]);
  const geo = await get(`/v0/${S.net}/geo`).catch(() => null);
  const lsps = await get(`/v0/${S.net}/lsps?limit=100`).catch(() => null);

  const eras = erasBody.eras || [];
  const now = latestRatedEra(eras);
  const settle = timing.resolution_hours && timing.resolution_hours.settlement;
  const floor = erasBody.min_samples_for_rate || 30;
  const settleUsable = settle && settle.n >= floor;
  const unres = timing.unresolved || {};

  // Where geo resolved nothing, the KPI says so instead of quietly dropping to a
  // count. "Location unresolved" is a fact about our lookups, not about the nodes.
  const geoSub = (() => {
    if (!geo || !geo.countries || geo.countries.length === 0) return 'LOCATION UNRESOLVED';
    const cov = geo.coverage || {};
    const parts = geo.countries.slice(0, 3).map((c) => `${c.nodes} ${c.code || c.name || '??'}`);
    // Two different shortfalls, and neither may pass silently: countries beyond the
    // third, and nodes whose address was never resolved. The breakdown counts
    // resolved nodes, so it must never be read against the node count beside it.
    const rest = geo.countries.slice(3).reduce((s, c) => s + c.nodes, 0);
    if (rest) parts.push(`+${rest}`);
    if (cov.resolved_nodes != null && cov.resolved_nodes < cov.nodes) parts.push(`OF ${cov.resolved_nodes} PLACED`);
    return parts.join(' · ');
  })();

  const kpis = [
    {
      src: 'chain',
      label: 'Channels ending badly, now',
      value: now ? pct(now.force_close_rate) : '—',
      sub: now ? `${fmt(now.force_closes)} OF ${fmt(now.closes)} CLOSES · ${esc(now.block_era)}` : `NO WINDOW HAS ${floor} CLOSES YET`,
      to: 'eras',
      muted: !now,
    },
    {
      src: 'chain',
      label: 'Typical freeze, if it does',
      value: settleUsable ? hours(settle.median) : '—',
      sub: settleUsable
        ? `1 IN 20 WAITS ${esc(hours(settle.p95))}+`
        : `ONLY ${settle ? fmt(settle.n) : '0'} EVER — WE NEED ${floor}`,
      to: 'events',
      muted: !settleUsable,
    },
    {
      src: 'chain',
      label: 'Times someone cheated',
      value: fmt(summary.penalties_all_time),
      sub: summary.penalties_all_time ? 'EVERY ONE WAS PUNISHED' : 'NONE IN THE WHOLE ARCHIVE',
      to: 'events',
    },
    {
      src: 'chain',
      label: 'Money still frozen',
      value: fmt(unres.commitment_cells),
      sub: unres.commitment_cells ? `OLDEST ${esc(date(unres.oldest_created_at))}` : 'NOTHING UNCLAIMED',
      to: 'frozen',
      bad: unres.commitment_cells > 0,
    },
    {
      src: 'gossip',
      label: 'Nodes heard announcing',
      value: fmt(summary.gossip && summary.gossip.nodes),
      sub: geoSub,
      to: 'nodes',
    },
    {
      src: 'void',
      label: 'All-time average rate',
      value: pct(summary.channels.force_close_rate_lifetime),
      sub: `${fmt(summary.channels.force_close)} / ${fmt(summary.channels.closed)} · DO NOT USE`,
      to: 'eras',
    },
  ];

  const kpiHtml = kpis
    .map(
      (k) => `<a class="kpi" href="${href(k.to)}">
      <div class="head"><span class="dot ${k.src === 'void' ? 'absent' : k.src}"></span><span>${esc(k.label)}</span></div>
      <div class="val ${k.src === 'void' ? 'void' : k.bad ? 'bad' : k.muted ? 'muted' : ''}">${esc(k.value)}</div>
      <div class="sub ${k.src === 'void' ? 'warn' : ''}">${k.sub}</div>
    </a>`,
    )
    .join('');

  const attrLine = attributionSentence(summary);
  const attr = attributionState(summary);

  return {
    html: `
<div class="intro">
  <div>
    <h1>What happened to money on the Fiber Network, and who is carrying it now</h1>
    <p>Fiber lets two parties lock funds into a <strong>channel</strong> on CKB and pay each other off-chain, settling
      only when they are done. Settle cooperatively and the funds move immediately. Fail to — a
      <strong>force-close</strong> — and the chain freezes the money behind a timelock before anyone can touch it.
      This page measures how often that happens, how long the money stays frozen, and which nodes are currently
      announcing themselves. It is a read-only observatory: no wallet, nothing to sign, nothing held.</p>
  </div>
  <div class="card pad">
    <div class="tag" style="margin-bottom:10px">TWO SOURCES, NEVER MIXED</div>
    <div class="legend"><span class="dot chain"></span><p><strong>Square — the chain.</strong> Every event ever, unforgeable. Past tense.</p></div>
    <div class="legend"><span class="dot gossip"></span><p><strong>Circle — node chatter.</strong> What nodes say about themselves, heard by one listener. Incomplete, and current.</p></div>
  </div>
</div>

<div class="kpis">${kpiHtml}</div>
<div class="sourcekey">
  <span><span class="dot chain"></span>FROM THE CHAIN — EVERY EVENT</span>
  <span><span class="dot gossip"></span>FROM NODE CHATTER — ONLY WHAT WE HEARD</span>
  <span><span style="color:var(--warn)">✕</span>MISLEADING — SHOWN ONLY SO NOBODY RECOMPUTES IT</span>
  <span class="net">ALL FIGURES ${esc(netLabel())}</span>
</div>

<section class="sec">
  <div class="sechead">
    <div class="left">
      <h2>Who you could open a channel with</h2>
      <span class="count">${fmt(nodesBody.total)} nodes have announced themselves</span>
    </div>
    <div class="controls">${sortPills()}</div>
  </div>
  ${nodeTable(mergeNodes(nodesBody, lsps).slice(0, 8), {
    attr,
    footer: `<span>${Math.min(8, nodesBody.total)} OF ${fmt(nodesBody.total)} SHOWN</span><a href="${href('nodes')}">ALL ${fmt(nodesBody.total)} NODES →</a>`,
  })}
  <div style="display:flex;gap:10px;margin-top:9px">
    <span class="tag ${attr.none ? 'warn' : ''}" style="flex:none;padding-top:2px">RECORD ${attr.none ? '✕' : ''}</span>
    <p class="note" style="margin:0;max-width:100ch">${attr.none
      ? `You want a column saying whether a node has ever burned anyone. On this network it cannot exist.
         The chain records that <em>a channel</em> force-closed, not who was on either end — ${attrLine}
         <strong style="color:var(--muted);font-weight:600">Last heard is the closest honest substitute:</strong> it means the node was
         reachable, not that it treated anyone well. Do not read it as a grade.`
      : `${attrLine} Those events carry a windowed record on the node's own page, with the counts and their
         denominator. It is still not a score: a force-close is evidence, not proof, and the rest of the archive
         names no node at all — so a node with nothing against it has an empty record, not a clean one.`}</p>
  </div>
</section>

<div class="split" style="margin-top:34px">
  <section>
    <div class="sechead">
      <h2>If it goes wrong, how long is your money frozen?</h2>
      <a class="tag" href="${href('frozen')}">METHOD →</a>
    </div>
    ${timingCard(timing, floor)}

    <div class="sechead" style="margin:26px 0 10px">
      <h2>How often it goes wrong — and when</h2>
      <a class="tag" href="${href('eras')}">ALL ERAS →</a>
    </div>
    <div class="card pad">${eraChart(eras, floor)}<p class="note">${esc(eraStory(eras, summary, floor))}</p></div>
  </section>

  <section>
    <div class="sechead">
      <h2>Latest events</h2>
      <a class="tag" href="${href('events')}">FULL FEED →</a>
    </div>
    <div class="card feed" style="overflow:hidden">
      ${(events.events || [])
        .map((e) => {
          const k = KIND[e.kind] || { label: e.kind, cls: '' };
          return `<a class="item" href="${e.channel_outpoint ? href('channel', e.channel_outpoint) : href('events')}">
            <span class="ago" title="${esc(datetime(e.block_at))}">${esc(e.block_at ? ago(e.block_at) : 'undated')}</span>
            ${chip(k.label, k.cls)}
            <span class="ch">${esc(shortOutpoint(e.channel_outpoint))}</span>
            ${attributionChip(e.attribution)}
          </a>`;
        })
        .join('')}
      <div class="tfoot"><span>${fmt(events.total)} EVENTS INDEXED · COVERAGE COMPLETE</span><a href="${href('events')}">FULL FEED →</a></div>
    </div>

    <div class="sechead" style="margin:26px 0 10px">
      <h2>Concentration</h2>
      <span class="tag"><span class="dot gossip"></span> FROM NODE CHATTER</span>
    </div>
    ${concentrationCard(conc)}
  </section>
</div>

<section class="sec card sunk pad">
  <div class="tag warn" style="margin-bottom:12px">NOT ON THIS SITE, BY CONSTRUCTION</div>
  <div class="refusals cols">
    <div class="refusal"><span class="x">✕</span><p><strong>Whether a node has burned anyone before.</strong>
      ${attrLine} ${attr.none
        ? 'No such record exists on this network, so none is shown.'
        : 'What record exists is windowed, partial, and on each node’s own page — it is never totalled into a score or a ranking.'}</p></div>
    <div class="refusal"><span class="x">✕</span><p><strong>How much a channel can actually move.</strong>
      Balances are never broadcast by Fiber for third-party channels. Capacity is the ceiling a channel was funded to,
      not money available today.</p></div>
    <div class="refusal"><span class="x">✕</span><p><strong>Whether payments through a node succeed.</strong>
      Only that node’s own operator can see this, and even they cannot tell which hop failed.</p></div>
  </div>
</section>`,
    foot: `CHAIN COVERAGE ${summary.time_coverage && summary.time_coverage.complete ? '100%' : 'PARTIAL'} · ${fmt(summary.attribution.events)} EVENTS · ${fmt(summary.gossip.nodes)} NODES IN GOSSIP`,
  };
}

/**
 * How much of a network's on-chain record can be pinned to nodes at all.
 *
 * Every refusal to show a per-node record keys off this one number, so they lift
 * together the moment coverage stops being zero — and never before. The spec is
 * explicit that coverage "grows with observation time, not with backfill size",
 * so a UI that hardcodes the refusal eventually renders presence as absence,
 * which is §4.3 running backwards.
 */
function attributionState(summary) {
  const a = (summary && summary.attribution) || {};
  const attributed = a.node_attributed || 0;
  return { events: a.events || 0, attributed, coverage: a.coverage, none: attributed === 0 };
}

function attributionSentence(summary) {
  const a = summary.attribution || {};
  if (!a.events) return 'nothing in this archive ties an event to a pubkey.';
  if (!a.node_attributed) return `${esc(fmt(a.events))} of ${esc(fmt(a.events))} ${esc(S.net)} events name no node pair at all — not one.`;
  return `only ${esc(fmt(a.node_attributed))} of ${esc(fmt(a.events))} ${esc(S.net)} events (${esc(pct(a.coverage, 2))}) name a node pair.`;
}

function timingCard(timing, floor) {
  const rh = timing.resolution_hours || {};
  const rows = [
    ['penalty', 'Cheating punished', 'one side published an old balance and lost the lot', rh.penalty],
    ['settlement', 'Ordinary force-close', 'one side simply walked away — the common case', rh.settlement],
  ].filter(([, , , d]) => d && d.n > 0);

  const unres = timing.unresolved || {};
  const usable = rows.filter(([, , , d]) => d.n >= floor);

  // Under the sample floor the distribution is withheld and the raw n is shown
  // instead. Six durations are six anecdotes, and a "median" over them invites a
  // comparison against testnet's 50,610 that is not a comparison at all.
  if (usable.length === 0) {
    return `<div class="card pad">
      <div class="tag warn" style="margin-bottom:9px">NO TYPICAL FIGURE · ${rows.length ? esc(fmt(rows[0][3].n)) : '0'} EVER, WE NEED ${floor}</div>
      <p class="note" style="margin:0 0 14px;color:var(--muted);font-size:12.5px">
        ${rows.length
          ? `${esc(fmt(rows.reduce((s, r) => s + r[3].n, 0)))} resolved force-closes in ${esc(S.net)}’s whole history. That is a handful of anecdotes,
             not a distribution — so no typical, worst or 1-in-20 figure is published. The counts stand on their own.`
          : `No force-close on ${esc(S.net)} has ever resolved in this archive, so there is no wait to measure.`}
      </p>
      ${rows
        .map(
          ([, label, gloss, d]) => `<div class="kv"><span class="k">${esc(label)} <span style="color:var(--faint)">— ${esc(gloss)}</span></span><span class="v">n = ${esc(fmt(d.n))} · min ${esc(hours(d.min))} · max ${esc(hours(d.max))}</span></div>`,
        )
        .join('')}
      ${frozenRow(unres)}
    </div>`;
  }

  return `<div class="card timing" style="overflow:hidden">
    <div class="hrow">
      <div>HOW IT ENDED</div><div style="text-align:right">n</div>
      <div style="text-align:right">TYPICAL</div><div style="text-align:right">1 IN 20</div><div style="text-align:right">WORST</div>
    </div>
    ${rows
      .map(([, label, gloss, d]) => {
        if (d.n < floor) {
          return `<div class="row"><div><div class="lbl">${esc(label)}</div><div class="gloss">${esc(gloss)}</div></div>
            <div class="r n">${esc(fmt(d.n))}</div>
            <div class="r" style="grid-column:span 3;color:var(--warn);font-size:11.5px">below the ${floor}-sample floor — counts only</div></div>`;
        }
        return `<div class="row">
          <div><div class="lbl">${esc(label)}</div><div class="gloss">${esc(gloss)}</div></div>
          <div class="r n">${esc(fmt(d.n))}</div>
          <div class="r"><span class="big">${esc(hours(d.median))}</span></div>
          <div class="r">${esc(hours(d.p95))}</div>
          <div class="r ${d.max >= 240 ? 'bad' : ''}">${esc(hours(d.max))}</div>
        </div>`;
      })
      .join('')}
    ${frozenRow(unres)}
  </div>`;
}

function frozenRow(unres) {
  const n = unres.commitment_cells || 0;
  return `<a class="frozenrow" href="${href('frozen')}">
    <div><div class="lbl" style="font-size:12.5px;color:var(--ink)">Still frozen</div>
      <div class="gloss" style="font-size:11px;color:var(--dim);margin-top:2px">never seen spent by this archive</div></div>
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
      <span class="big">${esc(fmt(n))}</span>
      <span style="font-size:12px;color:var(--dim)">${n ? `commitment cells never collected · oldest ${esc(date(unres.oldest_created_at))}` : 'every force-close in this archive has been collected'}</span>
    </div>
  </a>`;
}

function eraChart(eras, floor) {
  const shown = eras.slice(-8);
  const maxRate = Math.max(...shown.map((e) => e.force_close_rate || 0), 0.01);
  const bars = shown
    .map((e) => {
      const none = e.force_close_rate == null;
      const h = none ? 22 : Math.max(5, Math.round((e.force_close_rate / maxRate) * 88));
      return `<div class="era" title="${esc(e.block_era)} · ${esc(date(e.observed_from))} → ${esc(date(e.observed_to))} · ${esc(fmt(e.force_closes))} of ${esc(fmt(e.closes))} closes${none ? ' · ' + esc(e.rate_suppressed_reason || 'no rate') : ''}">
        <span class="lab ${none ? 'none' : ''}">${none ? 'n=' + esc(fmt(e.closes)) : esc(pct(e.force_close_rate))}</span>
        <div class="bar ${none ? 'none' : e.force_close_rate > 0.3 ? 'hot' : ''}" ${none ? '' : `style="height:${h}px"`}></div>
      </div>`;
    })
    .join('');
  const axis = shown
    .map(
      (e) => `<div><div class="d">${esc(date(e.observed_to).slice(0, 7))}</div>
      <div class="f">${e.force_close_rate == null ? 'NO RATE' : esc(fmt(e.force_closes)) + '/' + esc(fmt(e.closes))}</div></div>`,
    )
    .join('');
  return `<div class="eras">${bars}</div><div class="eraaxis">${axis}</div>`;
}

function eraStory(eras, summary, floor) {
  const rated = eras.filter((e) => e.force_close_rate != null);
  const suppressed = eras.length - rated.length;
  if (!rated.length) {
    return `No window on ${S.net} holds ${floor} closes, so no rate is published anywhere on this page — only counts.`;
  }
  const worst = rated.reduce((a, b) => (b.force_close_rate > a.force_close_rate ? b : a));
  const last = rated[rated.length - 1];
  const life = summary.channels.force_close_rate_lifetime;
  const parts = [];

  // "A failure period" is a strong claim and is only made when the data supports
  // one: a peak above 30% — the same threshold that colours a bar as bad — that
  // the network has since left. Testnet has that story; mainnet does not, and
  // asserting it there would be the same class of error as quoting one network's
  // rate as the other's.
  const collapsed = worst !== last && worst.force_close_rate > 0.3 && worst.force_close_rate > last.force_close_rate * 2;
  if (collapsed) {
    parts.push(
      `A failure period peaking at ${pct(worst.force_close_rate)} between ${date(worst.observed_from)} and ${date(worst.observed_to)}, ` +
        `down to ${pct(last.force_close_rate)} in the newest rated window.`,
    );
    parts.push(`The all-time average of ${pct(life)} describes neither state, which is why it is struck through above.`);
  } else if (worst !== last && worst.force_close_rate > last.force_close_rate * 3) {
    parts.push(
      `Rates move but stay low: the worst published window ran at ${pct(worst.force_close_rate)} ` +
        `(${date(worst.observed_from)} → ${date(worst.observed_to)}), the newest at ${pct(last.force_close_rate)}.`,
    );
  } else {
    parts.push(
      `Every published rate sits at or below ${pct(worst.force_close_rate)}. The newest rated window covers ` +
        `${fmt(last.closes)} closes ending ${date(last.observed_to)}, at ${pct(last.force_close_rate)}.`,
    );
  }
  if (suppressed) {
    const one = suppressed === 1;
    parts.push(
      `${suppressed} of ${eras.length} ${one ? 'window falls' : 'windows fall'} under the ` +
        `${floor}-close floor and ${one ? 'shows' : 'show'} counts only.`,
    );
  }
  return parts.join(' ');
}

function concentrationCard(conc) {
  const byCap = conc.by_capacity_shannons || {};
  const byCh = conc.by_channel_count || {};
  const rows = [
    ['Top 1 node, share of channels', byCh.top1_share],
    ['Top 3 nodes, share of channels', byCh.top3_share],
    ['Top 3 nodes, share of capacity', byCap.top3_share],
  ];
  const bars = rows
    .map(([label, v]) =>
      v == null
        ? ''
        : `<div class="barrow"><div class="lab"><span class="l">${esc(label)}</span><span class="v">${esc(pct(v, 0))}</span></div>
        <div class="track"><div class="fill ${v > 0.6 ? 'hot' : ''}" style="width:${Math.round(v * 100)}%"></div></div></div>`,
    )
    .join('');
  const lead = (byCh.top || [])[0];
  return `<div class="card pad bars">
    ${bars}
    ${lead ? `<p class="note">Leading by channel count: <a href="${href('node', lead.pubkey)}" class="mono">${esc(short(lead.pubkey))}</a>
      ${lead.node_name ? esc(lead.node_name) : '<span class="unnamed">no name announced</span>'} — ${esc(fmt(lead.value))} announced channels.</p>` : ''}
    <p class="note">${esc((conc.caveats || [])[0] || '')}</p>
    <p class="note" style="color:var(--faint)">${esc(conc.scope ? conc.scope.note : '')}</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * /nodes carries identity and presence; /lsps carries announced capacity and the
 * auto-accept threshold. They are the same 67 rows from the same gossip snapshot,
 * so the merge is a join, not an estimate. If /lsps is unreachable the capacity
 * column reads "—" rather than being computed from something else.
 */
function mergeNodes(nodesBody, lsps) {
  const extra = new Map();
  if (lsps && lsps.candidates) for (const c of lsps.candidates) extra.set(c.pubkey, c);
  return (nodesBody.nodes || []).map((n) => {
    const e = extra.get(n.pubkey) || {};
    return {
      pubkey: n.pubkey,
      node_name: n.node_name,
      version: n.version,
      first_seen: n.first_seen,
      last_seen: n.last_seen,
      open_channels: n.open_channels,
      capacity: e.announced_capacity_shannons != null ? e.announced_capacity_shannons : null,
      auto_accepts: e.auto_accepts,
      auto_accept_min_ckb: e.auto_accept_min_ckb,
    };
  });
}

const NODE_COLS = '150px minmax(120px,1.2fr) 88px 116px 108px 104px 118px 120px';

function sortPills() {
  const cur = param('sort', 'channels');
  return [
    ['channels', 'CHANNELS'],
    ['capacity', 'CAPACITY'],
    ['seen', 'LAST HEARD'],
    ['age', 'FIRST SEEN'],
  ]
    .map(([k, l]) => `<button class="pill ${cur === k ? 'on' : ''}" data-act="sort" data-arg="${k}">${l}</button>`)
    .join('');
}

function sortNodes(rows) {
  const s = param('sort', 'channels');
  const by = {
    channels: (a, b) => (b.open_channels || 0) - (a.open_channels || 0),
    capacity: (a, b) => Number(b.capacity || 0) - Number(a.capacity || 0),
    seen: (a, b) => (b.last_seen || 0) - (a.last_seen || 0),
    age: (a, b) => (a.first_seen || 0) - (b.first_seen || 0),
  };
  return rows.slice().sort(by[s] || by.channels);
}

function nodeTable(rows, opts = {}) {
  // With zero coverage, "not attributable" is a true statement about every node and
  // the blanket column is the honest headline. With any coverage at all it stops
  // being true, and the list endpoint cannot say which nodes are affected without
  // one request each — so the cell asserts nothing and defers to the node page.
  const attr = opts.attr || { none: true, attributed: 0 };
  const heads = [
    ['PUBKEY', 'gossip', '', 'Announced in node chatter. 66 hex characters — click to copy the whole thing.'],
    ['NAME', 'gossip', '', 'Self-reported and usually empty.'],
    ['CHANNELS', 'gossip', 'r', 'Channels this node currently announces. Not every channel it has.'],
    ['CAPACITY', 'gossip', 'r', 'Sum of announced channel totals. A funding ceiling, never a balance.'],
    ['VERSION', 'gossip', 'r', 'Self-reported fnn version.'],
    ['LAST HEARD', 'gossip', 'r', 'Since this listener last heard the node announce itself. A quiet node and a quiet listener look identical from here.'],
    ['AUTO-ACCEPT', 'gossip', 'r', 'The minimum inbound this node says it will accept without asking. Self-reported.'],
    attr.none
      ? ['RECORD ✕', 'absent', 'r', 'No on-chain event on this network can be attributed to any node — see the note below the table.']
      : ['RECORD', 'chain', 'r', `${fmt(attr.attributed)} events on this network name a node pair. Which nodes they name is on each node's own page — this list cannot say without a request per row.`],
  ];
  const record = attr.none
    ? '<div class="r num" style="color:var(--warn);white-space:nowrap" title="No on-chain event on this network is attributable to a specific node.">not attributable</div>'
    : '<div class="r num unnamed" style="white-space:nowrap" title="Attribution exists on this network but is per-node. Open the node to see its windowed record.">on node page →</div>';
  const now = Date.now();
  const body = rows
    .map((n) => {
      const stale = n.last_seen == null || now - n.last_seen > 3600000;
      const auto = n.auto_accepts
        ? ckb(autoAcceptShannons(n.auto_accept_min_ckb))
        : n.auto_accepts === false
          ? '<span class="unnamed">not offered</span>'
          : '<span class="unnamed">unknown</span>';
      return `<div class="row">
      <div>${pkCell(n.pubkey)}</div>
      <div><span class="clip">${nodeName(n.node_name)}</span></div>
      <div class="r num">${esc(fmt(n.open_channels))}</div>
      <div class="r num">${esc(ckb(n.capacity))}</div>
      <div class="r num">${esc(n.version || '—')}</div>
      <div class="r num" style="${stale ? 'color:var(--warn)' : ''}" title="${esc(datetime(n.last_seen))}">${esc(ago(n.last_seen, now))} ago</div>
      <div class="r num">${auto}</div>
      ${record}
    </div>`;
    })
    .join('');
  return `<div class="scroll"><div class="grid" style="grid-template-columns:${NODE_COLS};min-width:1080px">
    ${heads.map(([l, d, r, tip]) => `<div class="h ${r}" title="${esc(tip)}"><span class="dot ${d}"></span>${l}</div>`).join('')}
    ${body || ''}
  </div>${opts.footer ? `<div class="tfoot" style="min-width:1080px">${opts.footer}</div>` : ''}</div>`;
}

async function viewNodes() {
  const [nodesBody, lsps, summary] = await Promise.all([
    get(`/v0/${S.net}/nodes?limit=500`),
    get(`/v0/${S.net}/lsps?limit=500`).catch(() => null),
    // Only for the RECORD column: whether a per-node record can exist on this
    // network at all is a property of the network, not of any row.
    get(`/v0/${S.net}/summary`).catch(() => null),
  ]);
  const attr = attributionState(summary);
  let rows = mergeNodes(nodesBody, lsps);
  const q = param('q', '').trim().toLowerCase();
  const f = param('f', 'all');
  const now = Date.now();
  if (f === 'fresh') rows = rows.filter((n) => n.last_seen != null && now - n.last_seen <= 3600000);
  if (f === 'stale') rows = rows.filter((n) => n.last_seen == null || now - n.last_seen > 3600000);
  if (f === 'named') rows = rows.filter((n) => !!n.node_name);
  if (f === 'auto') rows = rows.filter((n) => n.auto_accepts);
  if (q) rows = rows.filter((n) => (n.pubkey + ' ' + (n.node_name || '') + ' ' + (n.version || '')).toLowerCase().includes(q));
  rows = sortNodes(rows);

  const filters = [
    ['all', 'ALL'],
    ['fresh', 'HEARD < 1h'],
    ['stale', 'STALE'],
    ['named', 'NAMED'],
    ['auto', 'AUTO-ACCEPTS'],
  ]
    .map(([k, l]) => `<button class="pill ${f === k ? 'on' : ''}" data-act="filter" data-arg="${k}">${l}</button>`)
    .join('');

  const named = rows.filter((n) => n.node_name).length;
  // Only said when there is something to say it about: "0 of 0 announce a name"
  // is noise, and a filtered view's ratio is about the filter, not the network.
  const naming =
    rows.length === 0
      ? ''
      : ` ${named} of the ${rows.length} shown announce a name; the rest are a 66-character pubkey and nothing else.`;

  return {
    html: `
<h1>Nodes</h1>
<p class="lede">Every node this listener has heard announce itself on ${esc(S.net)}. A node that never announced is not
  here at all — this is a record of what reached one observer, not a census of the network.${naming}</p>
<div class="filters">
  <input class="search" id="q" value="${esc(param('q', ''))}" placeholder="filter by pubkey, name or version…" autocomplete="off" spellcheck="false">
  <div style="display:flex;gap:6px;flex-wrap:wrap">${filters}</div>
  <div style="display:flex;gap:6px;flex-wrap:wrap">${sortPills()}</div>
</div>
${rows.length
  ? nodeTable(rows, { attr, footer: `<span>${fmt(rows.length)} OF ${fmt(nodesBody.total)} NODES</span><span>ALL FIGURES ${esc(netLabel())}</span>` })
  : `<div class="empty"><p>Nothing matches that filter. <a data-act="clear">Clear it</a>.</p></div>`}
<div class="card sunk pad" style="margin-top:18px">
  <div class="tag warn" style="margin-bottom:12px">WHAT THIS TABLE DELIBERATELY LACKS</div>
  <div class="refusals cols">
    <div class="refusal"><span class="x">✕</span><p><strong>A reliability ranking.</strong> ${attr.none
      ? 'On-chain failures cannot be attributed to any node on this network, so there is no per-node record to rank on — and a green tick would be worse than an empty column.'
      : `${esc(fmt(attr.attributed))} events name a node pair, so a partial record exists on each node’s page. It is still not sortable here: ranking on a record covering ${esc(pct(attr.coverage, 2))} of events would rank observation luck, not behaviour.`}</p></div>
    <div class="refusal"><span class="x">✕</span><p><strong>An uptime score.</strong> Continuous-presence tracking cannot be backfilled; it starts
      when the table does. Per-node presence is on each node’s page with the date we started watching attached.</p></div>
    <div class="refusal"><span class="x">✕</span><p><strong>A location.</strong> Nodes broadcast addresses, not locations, and most of these
      addresses have not been resolved. Where a lookup succeeded it is on the node page, marked self-announced.</p></div>
  </div>
</div>`,
    foot: `${fmt(nodesBody.total)} NODES IN GOSSIP · PRESENCE IS NOT RELIABILITY`,
  };
}

// ---------------------------------------------------------------------------
// Node detail
// ---------------------------------------------------------------------------

async function viewNode() {
  const body = await get(`/v0/${S.net}/nodes/${encodeURIComponent(S.id)}`);
  const n = body.node;

  /**
   * Announced capacity, without lying and without paying for it every time.
   *
   * Summing the channels on this page is exact whenever the page holds all of
   * them, which is true for all but a handful of nodes — and free, since they are
   * already in hand. It is only wrong when the node has more channels than one
   * page, and the busiest testnet node has 544. That case falls back to the
   * server-side total from /lsps, which is a ~2s query and so is not paid for the
   * other ninety-odd percent of node pages.
   */
  const chans = (body.channels && body.channels.items) || [];
  const channelTotal = body.channels ? body.channels.total : 0;
  let capacity = chans.length === channelTotal ? chans.reduce((s, c) => s + Number(c.capacity_shannons || 0), 0) : null;
  if (capacity === null) {
    const lsps = await get(`/v0/${S.net}/lsps?limit=500`).catch(() => null);
    const listed = lsps && (lsps.candidates || []).find((c) => c.pubkey === n.pubkey);
    capacity = listed ? listed.announced_capacity_shannons : null;
  }

  const up = body.uptime || {};
  const pol = body.live_policy || {};
  const fl = body.faultline || {};
  const loc = body.location || {};
  const now = Date.now();
  const stale = n.last_seen == null || now - n.last_seen > 3600000;

  let addresses = [];
  try {
    addresses = JSON.parse(n.addresses_json || '[]');
  } catch {
    addresses = [];
  }
  let features = [];
  try {
    features = JSON.parse(n.features_json || '[]');
  } catch {
    features = [];
  }

  const stats = [
    { src: 'gossip', label: 'Announced channels', value: fmt(channelTotal), sub: 'IN NODE CHATTER' },
    {
      src: 'gossip',
      label: 'Capacity ceiling',
      value: capacity == null ? '—' : ckb(capacity),
      sub: capacity == null ? 'NOT ANNOUNCED' : 'NOT AVAILABLE FUNDS',
    },
    {
      src: 'gossip',
      label: 'Continuously present',
      value: up.observed && up.current_run ? days(up.current_run.days) : '—',
      sub: up.observed ? `SINCE ${esc(date(up.observed_since))}` : 'NOT YET OBSERVED',
    },
    { src: 'gossip', label: 'Last heard', value: ago(n.last_seen, now) + ' ago', sub: 'BY THIS LISTENER' },
    { src: 'gossip', label: 'First heard', value: date(n.first_seen), sub: 'BY THIS LISTENER' },
    // The one stat that must never be filled in from nothing. observed:false is not
    // a zero — the API returns null counts precisely so this cannot render one.
    fl.observed && fl.counts
      ? {
          src: 'chain',
          label: 'Force-closes, in window',
          value: fmt(fl.counts.force_close),
          sub: `OF ${esc(fmt(fl.counts.closes))} ATTRIBUTED CLOSES`,
        }
      : { src: 'void', label: 'Force-close record', value: '—', sub: 'NO ATTRIBUTABLE EVENT' },
  ];

  return {
    html: `
${crumb('NODES', 'nodes', short(S.id, 10, 6))}
<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-bottom:20px">
  <div style="min-width:0">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
      <h1 class="mono" style="font-size:15px;font-weight:500;margin:0;word-break:break-all;line-height:1.5">${esc(n.pubkey)}</h1>
      <button class="pill" data-copy="${esc(n.pubkey)}" data-copy-msg="PUBKEY COPIED">⧉ COPY</button>
    </div>
    <div style="font-size:14px">${nodeName(n.node_name)}</div>
  </div>
  <div style="display:flex;gap:8px;align-items:center">
    <span class="chip ${stale ? 'bad' : 'open'}" style="min-width:0;padding:4px 9px">${stale ? 'NOT HEARD LATELY' : 'HEARD RECENTLY'}</span>
    <span class="chip" style="min-width:0;padding:4px 9px">${esc(netLabel())}</span>
  </div>
</div>

<div class="kpis" style="margin-bottom:22px">
  ${stats
    .map(
      (s) => `<div class="kpi">
    <div class="head"><span class="dot ${s.src === 'void' ? 'absent' : s.src}"></span><span>${esc(s.label)}</span></div>
    <div class="val" style="font-size:19px">${esc(s.value)}</div>
    <div class="sub ${s.src === 'void' ? 'warn' : ''}">${s.sub}</div>
  </div>`,
    )
    .join('')}
</div>

<div class="split wide">
  <div>
    <h2>Presence</h2>
    <p class="lede" style="margin:4px 0 10px">Continuous stretches during which this node kept announcing itself.
      This is reachability, not conduct — and it cannot be backfilled, so the window below starts the day this
      archive started listening, not the day the node did.</p>
    ${presenceCard(up)}

    <h2 style="margin-top:26px">Announced channels</h2>
    <p class="lede" style="margin:4px 0 10px">Channels this node announces in gossip. Capacity is the ceiling each was
      funded to, never money available now.</p>
    ${chans.length
      ? `<div class="scroll"><div class="grid" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1.3fr) 110px 104px 92px;min-width:760px">
        <div class="h"><span class="dot chain"></span>CHANNEL</div>
        <div class="h"><span class="dot gossip"></span>OTHER END</div>
        <div class="h r"><span class="dot chain"></span>CAPACITY</div>
        <div class="h r"><span class="dot chain"></span>OPENED</div>
        <div class="h r"><span class="dot chain"></span>STATE</div>
        ${chans
          .map((c) => {
            const other = c.node1_pubkey === n.pubkey ? c.node2_pubkey : c.node1_pubkey;
            const ck = c.close_kind ? CLOSE_KIND[c.close_kind] || { label: c.close_kind, cls: 'bad' } : { label: 'open', cls: 'open' };
            return `<div class="row link" data-go="channel/${esc(c.channel_outpoint)}">
            <div><span class="clip mono" style="font-size:11.5px;color:var(--chain)">${esc(shortOutpoint(c.channel_outpoint))}</span></div>
            <div>${other ? `<span class="clip mono" style="font-size:11.5px;color:var(--chain)">${esc(short(other))}</span>` : '<span class="unnamed">unknown</span>'}</div>
            <div class="r num">${esc(ckb(c.capacity_shannons))}</div>
            <div class="r num">${esc(date(c.open_block_at))}</div>
            <div class="r">${chip(ck.label, ck.cls)}</div>
          </div>`;
          })
          .join('')}
      </div><div class="tfoot" style="min-width:760px"><span>${fmt(chans.length)} OF ${fmt(body.channels.total)} ANNOUNCED</span></div></div>`
      : `<div class="empty">
          <div class="tag warn" style="margin-bottom:10px">NOTHING TO LIST</div>
          <p>This node announces no channel that this archive can also see on the chain. Showing a channel we cannot
             tie to this node would be inventing exactly the link the rest of this site refuses to invent.</p>
        </div>`}

    <h2 style="margin-top:26px">Routing policy, as announced</h2>
    <p class="lede" style="margin:4px 0 10px">Per-direction state across this node’s announced channels. A direction with
      no gossip row is <strong>unknown</strong>, which is a different thing from <strong>disabled</strong>.</p>
    ${policyCard(pol)}

    ${fl.observed && fl.counts ? faultlineCard(fl) : ''}
  </div>

  <div>
    <div class="card sunk pad">
      <div class="tag warn" style="margin-bottom:12px">WHAT WE CANNOT TELL YOU ABOUT THIS NODE</div>
      <div class="refusals">
        ${fl.observed && fl.counts
          ? `<div class="refusal"><span class="x">✕</span><p><strong>Its full history.</strong>
              The record below covers one window and only the events that name this node. Everything outside it is
              unobserved, not clean — so the counts are a floor, never a total.</p></div>`
          : `<div class="refusal"><span class="x">✕</span><p><strong>Has it ever force-closed on someone?</strong>
              Unknown, and unknowable from here. ${esc(fl.no_data_reason || 'No on-chain event is attributable to this node.')}
              A green tick in this spot would be a lie, so there is not one.</p></div>`}
        <div class="refusal"><span class="x">✕</span><p><strong>Can it route my payment?</strong>
          Only its operator can see that, and even they cannot tell which hop failed. The capacity above is a ceiling,
          not liquidity.</p></div>
        <div class="refusal"><span class="x">✕</span><p><strong>Is the name real?</strong>
          ${n.node_name ? `“${esc(n.node_name)}” is what this node broadcasts about itself. Nothing verifies it.` : 'This node broadcasts no name at all, which is the usual case.'}</p></div>
      </div>
      ${(fl.caveats || []).length ? `<p class="note" style="color:var(--faint)">${esc(fl.caveats[0])}</p>` : ''}
    </div>

    <div class="card pad" style="margin-top:18px">
      <div class="tag" style="margin-bottom:12px"><span class="dot gossip"></span> AS ANNOUNCED — SELF-REPORTED</div>
      ${addresses.map((a) => `<div class="kv"><span class="k">Address</span><span class="v">${esc(a)}</span></div>`).join('') || '<div class="kv"><span class="k">Address</span><span class="v unnamed">none announced</span></div>'}
      <div class="kv"><span class="k">Version</span><span class="v">${esc(n.version || 'not announced')}</span></div>
      <div class="kv"><span class="k">Auto-accept minimum</span><span class="v">${n.auto_accept_min_ckb ? esc(ckb(autoAcceptShannons(n.auto_accept_min_ckb))) : '<span class="unnamed">not offered</span>'}</span></div>
      <div class="kv"><span class="k">Features</span><span class="v">${features.length ? esc(features.join(', ')) : '<span class="unnamed">none announced</span>'}</span></div>
      <div class="kv"><span class="k">Location</span><span class="v ${locationText(loc).startsWith('not') ? 'unnamed' : ''}">${esc(locationText(loc))}</span></div>
      <div class="kv"><span class="k">Last announcement</span><span class="v">${esc(datetime(n.last_announced))}</span></div>
      <div class="kv"><span class="k">Balances</span><span class="v warn">never broadcast</span></div>
      <a class="jsonlink" style="margin-top:12px" href="${esc(apiUrl(`/v0/${S.net}/nodes/${encodeURIComponent(S.id)}`))}" target="_blank" rel="noopener">THIS NODE AS JSON →</a>
    </div>
  </div>
</div>`,
    foot: `NODE ON ${esc(netLabel())} · PRESENCE TRACKED SINCE ${esc(up.observed_since ? date(up.observed_since) : 'unknown')}`,
  };
}

function locationText(loc) {
  const addrs = (loc && loc.addresses) || [];
  const resolved = addrs.filter((a) => a.resolved);
  if (!addrs.length) return 'no routable address announced';
  if (!resolved.length) return 'not resolved — only the announced address is known';
  return resolved.map((a) => [a.country_name || a.country_code, a.asn_org].filter(Boolean).join(' · ')).join(', ');
}

/**
 * Presence, drawn honestly.
 *
 * The number that matters is not "99.8% up" — it is "we have only been watching
 * since X". A bar drawn to scale against the node's own first_seen makes the blind
 * period visible instead of leaving the reader to assume we saw it all.
 */
function presenceCard(up) {
  if (!up || !up.observed) {
    return `<div class="empty">
      <div class="tag warn" style="margin-bottom:10px">NOT YET OBSERVED</div>
      <p>${esc((up && up.no_data_reason) || 'Presence tracking has not recorded this node yet. That is a fact about how long this archive has been listening, not about the node.')}</p>
    </div>`;
  }
  const since = ms(up.observed_since);
  const now = Date.now();
  const watched = Math.max(1, now - since);
  const run = up.current_run || {};
  const runStart = ms(run.started_at);
  const seenPct = runStart != null ? Math.min(100, Math.max(2, ((now - runStart) / watched) * 100)) : 0;

  return `<div class="card pad">
    <div class="runs">
      <div><div class="k">Current run</div><div class="v">${esc(days(run.days))}</div></div>
      <div><div class="k">Longest run</div><div class="v">${esc(days(up.longest_run_days))}</div></div>
      <div><div class="k">Separate runs</div><div class="v ${up.runs > 3 ? 'warn' : ''}">${esc(fmt(up.runs))}</div></div>
    </div>
    <div class="window">
      <div class="track"><div class="seen" style="width:${seenPct.toFixed(1)}%"></div><div class="blind"></div></div>
      <div class="ends"><span>WATCHING SINCE ${esc(date(up.observed_since))}</span><span>NOW</span></div>
    </div>
    <p class="note">${esc((up.caveats || [])[0] || 'Measured only from the moment this archive started listening.')}</p>
  </div>`;
}

/** §4.4: enabled / disabled / unknown are three states, and unknown is not zero. */
function policyCard(pol) {
  const d = pol.directions || {};
  const total = d.total || 0;
  if (!total) {
    return `<div class="empty"><p>This node announces no channel direction we can read, so there is no policy to show —
      not a policy of zero.</p></div>`;
  }
  const seg = [
    ['enabled', d.enabled || 0, 'var(--chain)'],
    ['disabled', d.disabled || 0, 'var(--warn)'],
    ['unknown', d.unknown || 0, 'var(--ghost)'],
  ];
  return `<div class="card pad bars">
    <div class="track" style="height:10px;display:flex">
      ${seg.map(([, v, c]) => (v ? `<div style="width:${((v / total) * 100).toFixed(1)}%;background:${c}"></div>` : '')).join('')}
    </div>
    <div style="display:flex;gap:18px;margin-top:9px;flex-wrap:wrap">
      ${seg
        .map(
          ([l, v, c]) =>
            `<span class="tag"><span style="display:inline-block;width:8px;height:8px;background:${c};border-radius:2px;margin-right:5px"></span>${l.toUpperCase()} ${fmt(v)}</span>`,
        )
        .join('')}
    </div>
    <div class="kv" style="margin-top:12px"><span class="k">Announced fee rate</span><span class="v">${
      pol.fee_rate_shannons_per_kb
        ? pol.fee_rate_shannons_per_kb.min === pol.fee_rate_shannons_per_kb.max
          ? esc(fmt(pol.fee_rate_shannons_per_kb.min)) + ' shannons/kB'
          : esc(fmt(pol.fee_rate_shannons_per_kb.min)) + '–' + esc(fmt(pol.fee_rate_shannons_per_kb.max)) + ' shannons/kB'
        : '<span class="unnamed">not announced</span>'
    }</span></div>
    <div class="kv"><span class="k">Newest update</span><span class="v">${esc(datetime(pol.newest_update_at))}</span></div>
    <p class="note">${esc(pol.note || '')}</p>
  </div>`;
}

/**
 * The per-node on-chain record — rendered only when the API says observed:true.
 *
 * This is the panel §3.2 said could not exist, and it appears the moment the data
 * makes it possible. Three constraints hold it in shape:
 *
 *   §4.7  Every ratio ships its numerator and denominator, side by side, because a
 *         bare percentage is what gets quoted.
 *   §4.8  No grade, no score, no badge. Counts and their window, nothing derived
 *         into a judgement.
 *   §4.1  The window is stated in blocks and shown, so the figure cannot travel
 *         without the exposure it was measured over.
 *
 * The caveats are rendered in full rather than summarised: the fourth one — that
 * observed=false is not a clean record — is the whole reason this gate exists.
 */
function faultlineCard(fl) {
  const c = fl.counts;
  const r = fl.rates || {};
  const w = fl.window || {};

  const ratio = (label, rate, numerator) =>
    `<div class="kv"><span class="k">${esc(label)}</span><span class="v">${
      rate == null
        ? '<span class="unnamed">no closes in window — no rate</span>'
        : `${esc(pct(rate, 2))} <span style="color:var(--faint)">= ${esc(fmt(numerator))} / ${esc(fmt(c.closes))}</span>`
    }</span></div>`;

  return `
<h2 style="margin-top:26px">On-chain record, in this window</h2>
<p class="lede" style="margin:4px 0 10px">Events that name this node as one of the two parties. This is a floor, not a
  total: everything the archive could not attribute is missing from it, and a force-close is evidence rather than proof
  — a peer going offline forces one too.</p>
<div class="card pad">
  <div class="runs">
    <div><div class="k">Attributed closes</div><div class="v">${esc(fmt(c.closes))}</div></div>
    <div><div class="k">Agreed</div><div class="v">${esc(fmt(c.cooperative))}</div></div>
    <div><div class="k">Force-closed</div><div class="v ${c.force_close ? 'warn' : ''}">${esc(fmt(c.force_close))}</div></div>
    <div><div class="k">Penalties</div><div class="v ${c.penalty ? 'warn' : ''}">${esc(fmt(c.penalty))}</div></div>
  </div>
  <div style="margin-top:14px">
    ${ratio('Force-closes per close', r.force_close_per_close, c.force_close)}
    ${ratio('Penalties per close', r.penalty_per_close, c.penalty)}
    <div class="kv"><span class="k">Window</span><span class="v">${esc(fmt(w.blocks))} blocks · ${esc(fmt(w.from_block))} → ${esc(fmt(w.to_block))}</span></div>
    <div class="kv"><span class="k">Events naming this node</span><span class="v">${esc(fmt(fl.node_attributed_events))}</span></div>
  </div>
  ${c.closes < DEFAULT_SAMPLE_FLOOR
    ? `<p class="note" style="color:var(--warn)">${esc(fmt(c.closes))} attributed ${c.closes === 1 ? 'close is' : 'closes are'} below the
       ${DEFAULT_SAMPLE_FLOOR}-sample floor this archive uses for era rates. The counts above are real; the ratios beside them are not
       stable enough to set against another node’s. ${c.force_close === 0 ? 'Zero force-closes here means none were seen among those few, not that there were none.' : ''}</p>`
    : ''}
  <ul style="margin:14px 0 0;padding-left:18px;font-size:12px;line-height:1.65;color:var(--dim)">
    ${(fl.caveats || []).map((x) => `<li>${esc(x)}</li>`).join('')}
  </ul>
</div>`;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const PAGE = 100;

async function viewChannels() {
  const status = param('status', 'all');
  const page = Math.max(0, parseInt(param('p', '0'), 10) || 0);
  const qs = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
  if (status === 'open' || status === 'closed') qs.set('status', status);
  const body = await get(`/v0/${S.net}/channels?${qs}`);

  const q = param('q', '').trim().toLowerCase();
  let rows = body.channels || [];
  if (q) rows = rows.filter((c) => c.channel_outpoint.toLowerCase().includes(q));

  // Only the filters the API actually applies across the whole set. A by-kind pill
  // here could filter no further than the hundred rows already fetched, so on a
  // page that happens to hold no force-close it would render an empty table and
  // read as "there are none" — the exact confusion this project exists to avoid.
  // Filtering by kind is a server-side operation on the event feed, so that is
  // where the link goes.
  const filters = [
    ['all', 'ALL'],
    ['open', 'OPEN'],
    ['closed', 'CLOSED'],
  ]
    .map(([k, l]) => `<button class="pill ${status === k ? 'on' : ''}" data-act="status" data-arg="${k}">${l}</button>`)
    .join('');

  return {
    html: `
<h1>Channels</h1>
<p class="lede">Every channel the chain has ever seen opened on ${esc(S.net)} — this list is complete, because a funding
  cell cannot be hidden. The two nodes on either end usually are <em>not</em> known: the chain records the channel,
  not who was in it.</p>
<div class="filters">
  <input class="search" id="q" value="${esc(param('q', ''))}" placeholder="filter this page by channel outpoint…" autocomplete="off" spellcheck="false">
  <div style="display:flex;gap:6px;flex-wrap:wrap">${filters}</div>
  <span class="tag">HOW A CHANNEL ENDED IS FILTERABLE ACROSS THE WHOLE ARCHIVE ON THE <a href="${href('events')}">EVENT FEED →</a></span>
</div>
${q && rows.length === 0
  ? `<div class="empty"><p>No channel on this page of ${PAGE} matches “<strong>${esc(param('q', ''))}</strong>”.
      This box filters the rows already fetched, not the ${esc(fmt(body.total))} in the archive —
      <a data-act="clear">clear it</a> and page through, or paste a full outpoint to open it directly.</p></div>`
  : ''}
<div class="scroll"><div class="grid" style="grid-template-columns:minmax(0,1.2fr) 116px minmax(0,1.4fr) 104px 104px 96px;min-width:900px">
  <div class="h"><span class="dot chain"></span>CHANNEL</div>
  <div class="h r"><span class="dot chain"></span>CAPACITY</div>
  <div class="h"><span class="dot gossip"></span>PARTICIPANTS</div>
  <div class="h r"><span class="dot chain"></span>OPENED</div>
  <div class="h r"><span class="dot chain"></span>CLOSED</div>
  <div class="h r"><span class="dot chain"></span>HOW IT ENDED</div>
  ${rows
    .map((c) => {
      const ck = c.close_kind ? CLOSE_KIND[c.close_kind] || { label: c.close_kind, cls: 'bad' } : { label: 'open', cls: 'open' };
      const known = c.node1_pubkey && c.node2_pubkey;
      return `<div class="row link" data-go="channel/${esc(c.channel_outpoint)}">
      <div><span class="clip mono" style="font-size:11.5px;color:var(--chain)">${esc(shortOutpoint(c.channel_outpoint))}</span></div>
      <div class="r num">${esc(ckb(c.capacity_shannons))}</div>
      <div>${known
        ? `<span class="clip mono" style="font-size:11px;color:var(--chain)">${esc(short(c.node1_pubkey, 6, 4))} ↔ ${esc(short(c.node2_pubkey, 6, 4))}</span>`
        : '<span class="unnamed clip">not recorded on chain</span>'}</div>
      <div class="r num">${esc(date(c.open_block_at))}</div>
      <div class="r num">${c.close_block ? esc(date(c.close_block_at)) : '—'}</div>
      <div class="r">${chip(ck.label, ck.cls)}</div>
    </div>`;
    })
    .join('')}
</div>
<div class="tfoot" style="min-width:900px">
  <span>${fmt(rows.length)} SHOWN · ${fmt(body.total)} ${status === 'open' ? 'OPEN' : status === 'closed' ? 'CLOSED' : 'TOTAL'} ON ${esc(netLabel())}</span>
  <span class="more">
    <button class="pill" data-act="page" data-arg="${page - 1}" ${page === 0 ? 'disabled' : ''}>← PREV</button>
    <span style="padding:4px 6px">PAGE ${page + 1} OF ${fmt(Math.max(1, Math.ceil(body.total / PAGE)))}</span>
    <button class="pill" data-act="page" data-arg="${page + 1}" ${(page + 1) * PAGE >= body.total ? 'disabled' : ''}>NEXT →</button>
  </span>
</div></div>
<p class="note">${esc(body.capacity_is_not_balance || '')}</p>`,
    foot: `${fmt(body.total)} CHANNELS · CAPACITY IS A CEILING, NOT A BALANCE`,
  };
}

// ---------------------------------------------------------------------------
// Channel detail
// ---------------------------------------------------------------------------

async function viewChannel() {
  const body = await get(`/v0/${S.net}/channels/${encodeURIComponent(S.id)}`);
  const c = body.channel;
  const events = body.events || [];
  const upd = body.updates || {};
  const known = c.node1_pubkey && c.node2_pubkey;
  const ck = c.close_kind ? CLOSE_KIND[c.close_kind] || { label: c.close_kind, cls: 'bad' } : { label: 'open', cls: 'open' };

  // "Time frozen" only exists for a force-close, and only once the commitment cell
  // has been seen spent. Absent, it stays absent — never rendered as zero.
  const closeEvent = events.find((e) => e.kind === 'force_close' || e.kind === 'cooperative_close');
  const resolveEvent = events.find((e) => e.kind === 'settlement' || e.kind === 'penalty');
  const frozenH =
    c.close_kind === 'force_close' && closeEvent && resolveEvent && closeEvent.block_at && resolveEvent.block_at
      ? (Date.parse(resolveEvent.block_at) - Date.parse(closeEvent.block_at)) / 3600000
      : null;

  const stats = [
    { label: 'Capacity ceiling', value: ckb(c.capacity_shannons), sub: 'NOT A BALANCE' },
    { label: 'Opened', value: date(c.open_block_at), sub: 'BLOCK ' + fmt(c.open_block) },
    { label: 'Closed', value: c.close_block ? date(c.close_block_at) : '—', sub: c.close_block ? 'BLOCK ' + fmt(c.close_block) : 'STILL OPEN' },
    {
      label: 'Time frozen',
      value:
        c.close_kind == null ? '—' : c.close_kind === 'cooperative' ? 'none' : frozenH != null ? hours(frozenH) : 'never seen claimed',
      sub:
        c.close_kind == null
          ? 'NOT CLOSED YET'
          : c.close_kind === 'cooperative'
            ? 'AGREED CLOSE — NO TIMELOCK'
            : frozenH != null
              ? 'CLOSE → CLAIM'
              : 'NO SPEND OBSERVED',
      bad: c.close_kind === 'force_close' && frozenH == null,
    },
  ];

  // Timeline: the open is chain-attested, then every event the scan recorded, in
  // block order. Nothing is interpolated between them.
  const steps = [
    {
      kind: 'open',
      title: 'Channel opened',
      when: date(c.open_block_at),
      body: `Both parties funded a channel with ${ckb(c.capacity_shannons)}. From here on, payments between them left no trace on chain.`,
      tx: c.open_tx_hash,
    },
  ];
  for (const e of events) {
    const k = KIND[e.kind] || { label: e.kind, meaning: '' };
    steps.push({
      kind: e.kind,
      title: { cooperative_close: 'Closed by agreement', force_close: 'Force-closed', penalty: 'Cheat caught and punished', settlement: 'Funds collected' }[e.kind] || k.label,
      when: e.block_at ? date(e.block_at) : 'undated block ' + fmt(e.block_number),
      body: k.meaning,
      tx: e.tx_hash,
      attribution: e.attribution,
    });
  }
  if (!c.close_block) {
    steps.push({
      kind: 'live',
      title: 'Still open',
      when: 'as of ' + date(Date.now()),
      body: 'The chain has recorded no close. How much either side holds right now is private to them and was never broadcast.',
    });
  } else if (c.close_kind === 'force_close' && !resolveEvent) {
    steps.push({
      kind: 'frozen',
      title: 'Never seen collected',
      when: 'still frozen',
      body: 'This archive has never seen the commitment cell spent. Either nobody claimed it, or it happened outside what this scan covers. We do not guess which.',
    });
  }

  const knob = (k) =>
    k === 'force_close' || k === 'penalty' || k === 'frozen' ? 'bad' : k === 'live' ? 'gossip' : k === 'cooperative_close' ? 'plain' : '';

  return {
    html: `
${crumb('CHANNELS', 'channels', shortOutpoint(S.id))}
<div style="display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:18px">
  <div style="display:flex;align-items:center;gap:10px;min-width:0;flex-wrap:wrap">
    <h1 class="mono" style="font-size:15px;font-weight:500;margin:0;word-break:break-all">${esc(c.channel_outpoint)}</h1>
    <button class="pill" data-copy="${esc(c.channel_outpoint)}" data-copy-msg="OUTPOINT COPIED">⧉ COPY</button>
  </div>
  <div style="display:flex;gap:8px;align-items:center">
    ${chip(ck.label, ck.cls)}
    <span class="chip" style="min-width:0;padding:4px 9px">${esc(netLabel())}</span>
  </div>
</div>

<div class="kpis" style="margin-bottom:24px">
  ${stats
    .map(
      (s) => `<div class="kpi">
    <div class="head"><span class="dot chain"></span><span>${esc(s.label)}</span></div>
    <div class="val ${s.bad ? 'bad' : ''}" style="font-size:19px">${esc(s.value)}</div>
    <div class="sub">${esc(s.sub)}</div>
  </div>`,
    )
    .join('')}
</div>

<div class="split">
  <div>
    <h2>Life of this channel</h2>
    <div class="card pad tl" style="padding:20px 22px;margin-top:10px">
      ${steps
        .map(
          (s) => `<div class="step">
        <div class="gutter"><span class="knob ${knob(s.kind)}"></span><span class="line"></span></div>
        <div class="body">
          <div class="t"><span class="title">${esc(s.title)}</span><span class="when">${esc(s.when)}</span>
            ${s.attribution ? attributionChip(s.attribution) : ''}</div>
          <div class="txt">${esc(s.body)}</div>
          ${s.tx ? `<div class="tx">tx ${esc(s.tx)}</div>` : ''}
        </div>
      </div>`,
        )
        .join('')}
    </div>

    <h2 style="margin-top:26px">Routing policy, per direction</h2>
    ${directionsCard(upd)}
  </div>

  <div>
    <h2>Who was in it</h2>
    <div class="card pad" style="margin-top:10px">
      ${known
        ? `${[c.node1_pubkey, c.node2_pubkey]
            .map(
              (pk) =>
                `<a class="kv" style="text-decoration:none;color:inherit" href="${href('node', pk)}">
              <span class="k mono" style="color:var(--chain)">${esc(short(pk, 10, 6))}</span>
              <span class="v">node ${pk === c.node1_pubkey ? '1' : '2'}</span></a>`,
            )
            .join('')}
        <p class="note">Known only because this channel was also announced in node chatter while it was open. Most channels never were.</p>`
        : `<div class="tag warn" style="margin-bottom:10px">UNKNOWN — AND THIS IS THE NORMAL CASE</div>
        <p class="note" style="margin:0;color:var(--muted);font-size:12.5px">The chain proves this channel existed, was funded, and ended the way the timeline says.
          It does not record who the two parties were. This channel was never announced in gossip while it was open, so nothing ties it to a pubkey.</p>
        <p class="note" style="color:var(--muted);font-size:12.5px">That is why no node on this site carries a force-close record.</p>`}
    </div>

    <div class="card sunk pad" style="margin-top:18px">
      <div class="tag warn" style="margin-bottom:10px">CAPACITY IS NOT BALANCE</div>
      <p class="note" style="margin:0;color:var(--muted);font-size:12.5px">This channel was funded to ${esc(ckb(c.capacity_shannons))}.
        How that was split between the two sides at any moment is private to them and was never broadcast. Nothing here
        should be read as available funds.</p>
      <a class="jsonlink" style="margin-top:14px" href="${esc(apiUrl(`/v0/${S.net}/channels/${encodeURIComponent(S.id)}`))}" target="_blank" rel="noopener">THIS CHANNEL AS JSON →</a>
    </div>
  </div>
</div>`,
    foot: `CHANNEL ON ${esc(netLabel())} · ${events.length} ON-CHAIN EVENT${events.length === 1 ? '' : 'S'}`,
  };
}

function directionsCard(upd) {
  const dirs = upd.directions || [];
  const missing = upd.missing_directions || [];
  if (!dirs.length && !missing.length) {
    return `<div class="empty" style="margin-top:10px"><p>No gossip row for either direction. Both are
      <strong>unknown</strong> — which is not the same as disabled, and definitely not the same as enabled.</p></div>`;
  }
  return `<div class="card" style="margin-top:10px;overflow:hidden">
    <div class="grid" style="grid-template-columns:92px 108px 132px 116px minmax(0,1fr)">
      <div class="h"><span class="dot gossip"></span>DIRECTION</div>
      <div class="h"><span class="dot gossip"></span>STATE</div>
      <div class="h r"><span class="dot gossip"></span>FEE RATE</div>
      <div class="h r"><span class="dot gossip"></span>TLC MINIMUM</div>
      <div class="h r"><span class="dot gossip"></span>ANNOUNCED</div>
      ${dirs
        .map(
          (d) => `<div class="row">
        <div class="num">${esc(d.direction)}</div>
        <div>${chip(d.enabled ? 'enabled' : 'disabled', d.enabled ? 'open' : 'bad')}</div>
        <div class="r num">${esc(fmt(d.fee_rate_shannons_per_kb))} /kB</div>
        <div class="r num">${esc(ckb(d.tlc_minimum_value_shannons))}</div>
        <div class="r num" title="${esc(datetime(d.last_seen_at))}">${esc(date(d.announced_at))}</div>
      </div>`,
        )
        .join('')}
      ${missing
        .map(
          (d) => `<div class="row">
        <div class="num">${esc(d)}</div>
        <div>${chip('unknown', 'unknown')}</div>
        <div class="r num unnamed" style="grid-column:span 3">never announced in gossip — not disabled</div>
      </div>`,
        )
        .join('')}
    </div>
    <div class="tfoot"><span>${esc(upd.note || '')}</span></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

async function viewEvents() {
  const kind = param('kind', 'all');
  const after = param('after', '');
  const qs = new URLSearchParams({ limit: String(PAGE) });
  if (kind !== 'all') qs.set('kind', kind);
  if (after) qs.set('after', after);
  const body = await get(`/v0/${S.net}/faultline/events?${qs}`);

  const filters = [
    ['all', 'ALL'],
    ['cooperative_close', 'AGREED CLOSE'],
    ['force_close', 'FORCE'],
    ['penalty', 'PENALTY'],
    ['settlement', 'SETTLEMENT'],
  ]
    .map(([k, l]) => `<button class="pill ${kind === k ? 'on' : ''}" data-act="kind" data-arg="${k}">${l}</button>`)
    .join('');

  const rows = body.events || [];

  return {
    html: `
<h1>Events</h1>
<p class="lede">Every channel event the chain has recorded on ${esc(S.net)}, newest first. ${fmt(body.total)} indexed,
  coverage complete — nothing here is sampled, inferred, or reconstructed. The
  <strong>attribution</strong> column travels with every row: it is the difference between an event we can pin to two
  nodes and one we can only pin to a channel.</p>
<div class="filters"><div style="display:flex;gap:6px;flex-wrap:wrap">${filters}</div></div>
${rows.length
  ? `<div class="scroll"><div class="grid" style="grid-template-columns:106px 104px minmax(0,1.2fr) 118px minmax(0,1.6fr) 108px;min-width:940px">
  <div class="h"><span class="dot chain"></span>WHEN</div>
  <div class="h"><span class="dot chain"></span>WHAT</div>
  <div class="h"><span class="dot chain"></span>CHANNEL</div>
  <div class="h r"><span class="dot chain"></span>ATTRIBUTION</div>
  <div class="h"><span class="dot chain"></span>MEANING</div>
  <div class="h r"><span class="dot chain"></span>BLOCK</div>
  ${rows
    .map((e) => {
      const k = KIND[e.kind] || { label: e.kind, cls: '', meaning: '' };
      return `<div class="row ${e.channel_outpoint ? 'link' : ''}" ${e.channel_outpoint ? `data-go="channel/${esc(e.channel_outpoint)}"` : ''}>
      <div class="num" title="${esc(datetime(e.block_at))}">${esc(e.block_at ? date(e.block_at) : 'undated')}</div>
      <div>${chip(k.label, k.cls)}</div>
      <div>${e.channel_outpoint
        ? `<span class="clip mono" style="font-size:11.5px;color:var(--chain)">${esc(shortOutpoint(e.channel_outpoint))}</span>`
        : '<span class="unnamed">no channel</span>'}</div>
      <div class="r">${attributionChip(e.attribution)}</div>
      <div><span class="clip" style="color:var(--dim);font-size:12px">${esc(k.meaning)}</span></div>
      <div class="r num">${esc(fmt(e.block_number))}</div>
    </div>`;
    })
    .join('')}
</div>
<div class="tfoot" style="min-width:940px">
  <span>${fmt(rows.length)} SHOWN · ${fmt(body.total)} MATCHING ON ${esc(netLabel())}</span>
  <span class="more">
    ${after ? `<button class="pill" data-act="cursor" data-arg="">← NEWEST</button>` : ''}
    <button class="pill" data-act="cursor" data-arg="${esc(body.next_cursor || '')}" ${body.next_cursor ? '' : 'disabled'}>OLDER →</button>
  </span>
</div></div>`
  : `<div class="empty">
      <div class="tag warn" style="margin-bottom:10px">NONE — AND THAT IS THE FINDING</div>
      <p>${kind === 'penalty'
        ? `Not one penalty has ever been recorded on ${esc(S.net)}. A penalty is provable misbehaviour: a party published a revoked state and got swept for it. Zero of them, across the complete chain history, is the strongest positive claim this archive can make about this network.`
        : `No event of this kind exists in ${esc(S.net)}’s complete history.`}</p>
    </div>`}
<div class="card sunk pad" style="margin-top:18px">
  <div class="tag" style="margin-bottom:12px">WHAT ATTRIBUTION MEANS</div>
  <div class="refusals cols">
    ${Object.entries(body.attribution_levels || {})
      .map(([k, v]) => `<div class="refusal"><span class="x" style="color:var(--dim)">·</span><p><strong>${esc(ATTRIBUTION[k] ? ATTRIBUTION[k].label : k)}</strong> ${esc(v)}</p></div>`)
      .join('')}
  </div>
</div>`,
    foot: `${fmt(body.total)} EVENTS · COVERAGE COMPLETE ON ${esc(netLabel())}`,
  };
}

// ---------------------------------------------------------------------------
// Eras
// ---------------------------------------------------------------------------

async function viewEras() {
  const [body, summary] = await Promise.all([get(`/v0/${S.net}/eras`), get(`/v0/${S.net}/summary`)]);
  const eras = body.eras || [];
  const floor = body.min_samples_for_rate || 30;

  return {
    html: `
<h1>Eras</h1>
<p class="lede">The network was not one thing over time. Closes are bucketed into windows of a million blocks, and a
  failure rate is published only where a bucket holds at least ${floor} closes. Below that you get the counts and
  nothing else — a rate over a dozen closes is noise wearing a percentage sign.</p>
<p class="lede" style="color:var(--faint)">${esc(body.era_definition || '')}</p>

<div class="split wide">
  <div class="card" style="overflow:hidden">
    <div class="grid" style="grid-template-columns:minmax(0,1fr) 92px 92px 88px 92px minmax(0,1.2fr)">
      <div class="h"><span class="dot chain"></span>WINDOW</div>
      <div class="h r"><span class="dot chain"></span>CLOSES</div>
      <div class="h r"><span class="dot chain"></span>FORCED</div>
      <div class="h r"><span class="dot chain"></span>PENALTY</div>
      <div class="h r"><span class="dot chain"></span>RATE</div>
      <div class="h"><span class="dot chain"></span>READING</div>
      ${eras
        .map((e) => {
          const none = e.force_close_rate == null;
          return `<div class="row">
        <div><div><div class="mono" style="font-size:11.5px">${esc(e.block_era)}</div>
          <div class="mono" style="font-size:9.5px;color:var(--faint)">${esc(date(e.observed_from))} → ${esc(date(e.observed_to))}</div></div></div>
        <div class="r num">${esc(fmt(e.closes))}</div>
        <div class="r num">${esc(fmt(e.force_closes))}</div>
        <div class="r num" style="${e.penalties ? 'color:var(--warn)' : ''}">${esc(fmt(e.penalties))}</div>
        <div class="r mono" style="font-size:13px;${none ? 'color:var(--warn)' : e.force_close_rate > 0.3 ? 'color:var(--warn)' : ''}">${none ? '—' : esc(pct(e.force_close_rate))}</div>
        <div title="${esc(
          none ? e.rate_suppressed_reason || `under the ${floor}-close floor — counts only` : '',
        )}"><span class="clip" style="font-size:11.5px;color:var(--dim)">${esc(
          none ? e.rate_suppressed_reason || `under the ${floor}-close floor — counts only` : e.force_close_rate > 0.3 ? 'failure period' : 'normal operation',
        )}</span></div>
      </div>`;
        })
        .join('')}
    </div>
    <div class="tfoot"><span>${eras.length} WINDOWS ON ${esc(netLabel())} · ${eras.filter((e) => e.force_close_rate == null).length} WITHHELD FOR SMALL n</span></div>
  </div>

  <div>
    <div class="card pad">${eraChart(eras, floor)}<p class="note">${esc(eraStory(eras, summary, floor))}</p></div>

    <div class="card sunk pad" style="margin-top:18px">
      <div class="tag warn" style="margin-bottom:12px">DO NOT USE THIS NUMBER</div>
      <div class="voidnum">${esc(pct(summary.channels.force_close_rate_lifetime))}</div>
      <div class="mono" style="font-size:11px;color:var(--warn);margin-top:6px">${esc(fmt(summary.channels.force_close))} / ${esc(fmt(summary.channels.closed))} CLOSES · ALL TIME · ${esc(netLabel())}</div>
      <p class="note" style="color:var(--muted);font-size:12.5px">The all-time average force-close rate. It flattens every window above into one number, including
        the windows the sample floor says are not comparable, so it describes no period the network was actually in.
        The API serves it flagged unusable; it is printed here, struck through, only so nobody derives it from the two
        counts beside it and quotes it as a headline.</p>
      <p class="note" style="color:var(--faint)">${esc(summary.channels.lifetime_rate_warning || '')}</p>
    </div>

    <div class="card pad" style="margin-top:18px">
      <div class="tag" style="margin-bottom:10px">WHY BLOCKS, NOT MONTHS</div>
      <p class="note" style="margin:0;color:var(--muted);font-size:12.5px">${esc(body.note || '')} Buckets are chain progress, so their
        wall-clock widths are unequal — the dates on each row are the real header timestamps of the first and last
        close in the bucket, not a calendar range.</p>
      <a class="jsonlink" style="margin-top:14px" href="${esc(apiUrl(`/v0/${S.net}/eras`))}" target="_blank" rel="noopener">ERAS AS JSON →</a>
    </div>
  </div>
</div>`,
    foot: `${eras.length} ERAS · RATES SUPPRESSED UNDER ${floor} CLOSES`,
  };
}

// ---------------------------------------------------------------------------
// Frozen funds
// ---------------------------------------------------------------------------

async function viewFrozen() {
  const page = Math.max(0, parseInt(param('p', '0'), 10) || 0);
  const [body, timing] = await Promise.all([
    get(`/v0/${S.net}/faultline/unresolved?limit=${PAGE}&offset=${page * PAGE}`),
    get(`/v0/${S.net}/faultline/timing`),
  ]);
  const cells = body.commitment_cells || [];
  const rh = timing.resolution_hours || {};
  const total = Number(cells.reduce((s, c) => s + Number(c.capacity_shannons || 0), 0));

  return {
    html: `
<h1>Money still frozen</h1>
<p class="lede">When a Fiber channel force-closes, the chain locks the funds behind a timelock. Someone then has to
  spend the commitment cell to collect them. These are the cells this archive has <strong>never seen spent</strong> —
  which is a statement about what this scan has observed, not a claim that the money is permanently lost.</p>

<div class="kpis" style="margin-bottom:22px">
  <div class="kpi"><div class="head"><span class="dot chain"></span><span>Cells never seen spent</span></div>
    <div class="val ${body.total ? 'bad' : ''}">${esc(fmt(body.total))}</div><div class="sub">ON ${esc(netLabel())}</div></div>
  <div class="kpi"><div class="head"><span class="dot chain"></span><span>Oldest</span></div>
    <div class="val">${esc(date(body.oldest_created_at))}</div><div class="sub">${body.oldest_created_at ? esc(ago(body.oldest_created_at)) + ' AGO' : 'NONE'}</div></div>
  <div class="kpi"><div class="head"><span class="dot chain"></span><span>Capacity on this page</span></div>
    <div class="val">${esc(ckb(total))}</div><div class="sub">CEILING, NOT A BALANCE</div></div>
  <div class="kpi"><div class="head"><span class="dot chain"></span><span>Typical wait when collected</span></div>
    <div class="val">${rh.settlement && rh.settlement.n >= 30 ? esc(hours(rh.settlement.median)) : '—'}</div>
    <div class="sub">${rh.settlement && rh.settlement.n >= 30 ? 'MEDIAN OF ' + esc(fmt(rh.settlement.n)) : 'TOO FEW TO SAY'}</div></div>
</div>

${cells.length
  ? `<div class="scroll"><div class="grid" style="grid-template-columns:minmax(0,1.2fr) minmax(0,1.2fr) 116px 108px 92px minmax(0,1fr);min-width:960px">
  <div class="h"><span class="dot chain"></span>COMMITMENT CELL</div>
  <div class="h"><span class="dot chain"></span>CHANNEL</div>
  <div class="h r"><span class="dot chain"></span>CAPACITY</div>
  <div class="h r"><span class="dot chain"></span>CREATED</div>
  <div class="h r"><span class="dot chain"></span>AGE</div>
  <div class="h"><span class="dot gossip"></span>PARTICIPANTS</div>
  ${cells
    .map(
      (c) => `<div class="row ${c.channel_outpoint ? 'link' : ''}" ${c.channel_outpoint ? `data-go="channel/${esc(c.channel_outpoint)}"` : ''}>
    <div><span class="clip mono" style="font-size:11.5px">${esc(shortOutpoint(c.commitment_outpoint))}</span></div>
    <div>${c.channel_outpoint
      ? `<span class="clip mono" style="font-size:11.5px;color:var(--chain)">${esc(shortOutpoint(c.channel_outpoint))}</span>`
      : '<span class="unnamed clip" title="The commitment cell is on chain, but this scan never matched it back to a funding outpoint.">not tied to a channel</span>'}</div>
    <div class="r num">${esc(ckb(c.capacity_shannons))}</div>
    <div class="r num">${esc(date(c.created_block_at))}</div>
    <div class="r num" style="${c.age_days > 180 ? 'color:var(--warn)' : ''}">${esc(c.age_days != null ? Math.round(c.age_days) + 'd' : '—')}</div>
    <div>${c.node1_pubkey && c.node2_pubkey
      ? `<span class="clip mono" style="font-size:11px;color:var(--chain)">${esc(short(c.node1_pubkey, 6, 4))} ↔ ${esc(short(c.node2_pubkey, 6, 4))}</span>`
      : '<span class="unnamed clip">not recorded on chain</span>'}</div>
  </div>`,
    )
    .join('')}
</div>
<div class="tfoot" style="min-width:960px">
  <span>${fmt(cells.length)} SHOWN OF ${fmt(body.total)}</span>
  <span class="more">
    <button class="pill" data-act="page" data-arg="${page - 1}" ${page === 0 ? 'disabled' : ''}>← PREV</button>
    <span style="padding:4px 6px">PAGE ${page + 1} OF ${fmt(Math.max(1, Math.ceil(body.total / PAGE)))}</span>
    <button class="pill" data-act="page" data-arg="${page + 1}" ${(page + 1) * PAGE >= body.total ? 'disabled' : ''}>NEXT →</button>
  </span>
</div></div>`
  : `<div class="empty">
      <div class="tag" style="margin-bottom:10px;color:var(--chain)">NOTHING FROZEN</div>
      <p>Every force-close in ${esc(S.net)}’s complete on-chain history has had its commitment cell spent. There is
        nothing outstanding. On a network this size that is a fact worth stating plainly rather than an empty table.</p>
    </div>`}

<div class="card sunk pad" style="margin-top:18px">
  <div class="tag warn" style="margin-bottom:12px">HOW TO READ THIS</div>
  <div class="refusals cols">
    <div class="refusal"><span class="x">✕</span><p><strong>“Never seen spent” is not “permanently stuck.”</strong>
      ${esc((body.what_this_is || '').slice(0, 200))}</p></div>
    <div class="refusal"><span class="x">✕</span><p><strong>Capacity is the channel ceiling, not the amount owed to anyone.</strong>
      How the funds were split between the two sides was never broadcast, so no figure here is a claim about whose money it is.</p></div>
    <div class="refusal"><span class="x">✕</span><p><strong>Most participants are unknown.</strong>
      A commitment cell names its channel, and a channel names its nodes only if it was in gossip while open. Most were not.</p></div>
  </div>
  <p class="note" style="color:var(--faint)">${esc((timing.unresolved && timing.unresolved.note) || '')}</p>
</div>`,
    foot: `${fmt(body.total)} UNRESOLVED COMMITMENT CELLS ON ${esc(netLabel())}`,
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  ['/v0/{network}/summary', 'Headline counts, attribution coverage, and the lifetime rate — flagged unusable.'],
  ['/v0/{network}/eras', 'Million-block windows with counts; the rate is null wherever n is under the floor.'],
  ['/v0/{network}/faultline/timing', 'How long funds stay frozen after a force-close. Derived from L1 alone, so complete.'],
  ['/v0/{network}/faultline/unresolved', 'Commitment cells never observed spent — money still frozen.'],
  ['/v0/{network}/faultline/events', 'Complete event log, newest first, keyset-paginated on next_cursor.'],
  ['/v0/{network}/nodes', 'Nodes heard in gossip, with first and last seen.'],
  ['/v0/{network}/lsps', 'Ranked inbound-liquidity candidates. States in the payload which signal it omits.'],
  ['/v0/{network}/channels', 'Every channel the chain has seen, with lifecycle state.'],
  ['/v0/{network}/concentration', 'Top-N share and HHI, by capacity and by channel count.'],
  ['/v0/{network}/activity', 'Channels opened and closed per calendar month across the archive.'],
  ['/v0/{network}/distribution', 'Percentiles for capacity, announced fee rate, and closed-channel lifetime.'],
  ['/v0/{network}/liveness', 'Announcement staleness in age buckets — enabled, disabled and unknown kept apart.'],
  ['/v0/{network}/geo', 'Country and hosting provider, from addresses nodes broadcast themselves.'],
  ['/health', 'Scan cursors, gossip freshness, block-time coverage. Check before quoting anything.'],
];

function highlight(json) {
  return esc(json).replace(
    /(&quot;(?:\\.|[^&])*?&quot;)(\s*:)?|\b(true|false|null)\b|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g,
    (m, str, colon, lit, num) => {
      if (str) return `<span class="${colon ? 'k' : 's'}">${str}</span>${colon || ''}`;
      if (lit) return `<span class="${lit === 'null' ? 'null' : 'n'}">${lit}</span>`;
      return `<span class="n">${num}</span>`;
    },
  );
}

async function viewApi() {
  const i = Math.min(ENDPOINTS.length - 1, Math.max(0, parseInt(param('e', '0'), 10) || 0));
  const path = ENDPOINTS[i][0].replace('{network}', S.net);
  let sample;
  try {
    const body = await get(path + (path.includes('?') ? '&' : '?') + 'limit=3');
    sample = JSON.stringify(body, null, 2);
    if (sample.length > 6000) sample = sample.slice(0, 6000) + '\n…truncated for display; the endpoint returns more.';
  } catch (err) {
    sample = `// ${path}\n// ${err.message}`;
  }

  return {
    html: `
<h1>API</h1>
<p class="lede">Read-only JSON, no key, no rate limit worth mentioning, CORS open. Every response carries its network,
  and where a figure is suppressed or unusable it says so <em>in the payload</em> rather than omitting the field.
  Absence is never encoded as zero. The samples below are fetched live from
  <code class="mono">${esc(API || location.origin)}</code> right now — this page is its own reference client.</p>

<div class="split even">
  <div class="card" style="overflow:hidden">
    <div class="tfoot" style="border-bottom:1px solid var(--rule)"><span>ENDPOINTS · ${esc(netLabel())}</span></div>
    ${ENDPOINTS.map(
      ([p, desc], n) => `<div class="endpoint ${n === i ? 'on' : ''}" data-act="ep" data-arg="${n}">
      <div style="display:flex;align-items:center;gap:10px"><span class="verb">GET</span><span class="path">${esc(p)}</span></div>
      <div class="desc">${esc(desc)}</div>
    </div>`,
    ).join('')}
  </div>
  <div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:10px;flex-wrap:wrap">
      <span class="tag">LIVE RESPONSE · ${esc(path)}</span>
      <span style="display:flex;gap:6px">
        <button class="pill" data-copy-sample="1">⧉ COPY</button>
        <a class="pill" href="${esc(apiUrl(path))}" target="_blank" rel="noopener">OPEN ↗</a>
      </span>
    </div>
    <pre class="json" id="sample">${highlight(sample)}</pre>
    <div class="card sunk pad" style="margin-top:18px">
      <div class="tag warn" style="margin-bottom:10px">CONTRACT</div>
      <ul style="margin:0;padding-left:18px;font-size:12.5px;line-height:1.7;color:var(--muted)">
        <li>Every payload names its network. Testnet and mainnet figures are never comparable.</li>
        <li>A rate computed over fewer than 30 samples is <code class="mono" style="color:var(--warn)">null</code> with a
          <code class="mono" style="color:var(--warn)">rate_suppressed_reason</code>, never a number.</li>
        <li>Ratios ship their numerator and denominator alongside the rate.</li>
        <li>Unknown is never <code class="mono" style="color:var(--warn)">0</code> and never
          <code class="mono" style="color:var(--warn)">false</code>. It is
          <code class="mono" style="color:var(--warn)">null</code> with a reason.</li>
        <li><code class="mono" style="color:var(--warn)">capacity_shannons</code> is a funding ceiling. There is no
          balance field, and there never will be.</li>
        <li>Timestamps come from chain headers and are never interpolated. An unfetched header serves
          <code class="mono" style="color:var(--warn)">null</code>, not a guess.</li>
      </ul>
    </div>
  </div>
</div>`,
    foot: `API ROOT ${esc(apiUrl('/v0'))} · READ-ONLY`,
  };
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

const RENDERERS = {
  overview: viewOverview,
  nodes: viewNodes,
  node: viewNode,
  channels: viewChannels,
  channel: viewChannel,
  events: viewEvents,
  eras: viewEras,
  frozen: viewFrozen,
  api: viewApi,
};

async function render() {
  const token = ++renderToken;
  const fn = RENDERERS[S.view] || viewOverview;

  app.innerHTML = shell(loading()) + footer('');
  paintFreshness();

  let out;
  try {
    out = await fn();
  } catch (err) {
    if (token !== renderToken) return;
    app.innerHTML = shell(failure(err, S.view)) + footer('');
    paintFreshness();
    return;
  }
  if (token !== renderToken) return;

  app.innerHTML = shell(out.html) + footer(out.foot || '');
  paintFreshness();

  const q = document.getElementById('q');
  if (q) {
    q.addEventListener('input', debounce(() => setParam('q', q.value), 220));
    if (S.params.get('q')) {
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
  }
}

function debounce(fn, wait) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), wait);
  };
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

let toastTimer;
function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  el.setAttribute('role', 'status');
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 1600);
}

document.addEventListener('click', (ev) => {
  const copy = ev.target.closest('[data-copy]');
  if (copy) {
    ev.preventDefault();
    ev.stopPropagation();
    navigator.clipboard?.writeText(copy.getAttribute('data-copy')).catch(() => {});
    toast(copy.getAttribute('data-copy-msg') || 'COPIED');
    return;
  }

  if (ev.target.closest('[data-copy-sample]')) {
    const pre = document.getElementById('sample');
    if (pre) {
      navigator.clipboard?.writeText(pre.textContent).catch(() => {});
      toast('JSON COPIED');
    }
    return;
  }

  const act = ev.target.closest('[data-act]');
  if (act && !act.hasAttribute('disabled')) {
    const arg = act.getAttribute('data-arg');
    switch (act.getAttribute('data-act')) {
      case 'sort':
        return setParam('sort', arg);
      case 'filter':
        return setParam('f', arg);
      case 'status':
        setParam('p', null);
        return setParam('status', arg);
      case 'kind':
        setParam('after', null);
        return setParam('kind', arg);
      case 'cursor':
        return setParam('after', arg);
      case 'page':
        return setParam('p', arg);
      case 'ep':
        return setParam('e', arg);
      case 'clear':
        return setParam('q', null);
    }
  }

  // Row-level navigation. Anchors inside a row keep working: they are handled by
  // the browser before this ever sees the click.
  if (ev.target.closest('a')) return;
  const row = ev.target.closest('[data-go]');
  if (row) go(row.getAttribute('data-go'));
});

window.addEventListener('hashchange', () => {
  parseHash();
  normaliseHash();
  render();
});

/**
 * Paint from the fallback list first, then reconcile against /health.
 *
 * /health costs about a second — it counts rows across every archive — and
 * blocking on it would mean a second of blank document before even the header
 * appears. So the first frame is drawn from the fallback, and the route is
 * re-resolved once the real list lands. Nothing is re-rendered unless the answer
 * actually differs, which on a two-network deployment it never does.
 */
(async function boot() {
  if (!location.hash) history.replaceState(null, '', `#/${defaultNet()}/overview`);
  parseHash();
  normaliseHash();
  render();

  const snapshot = () => `${NETWORKS.join(',')}|${[...PENDING].join(',')}|${S.net}`;
  const before = snapshot();
  await loadNetworks();
  parseHash();
  normaliseHash();
  if (snapshot() !== before) render();
})();

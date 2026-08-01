# Fiber Atlas

**Network visibility and on-chain reliability for the [Fiber Network](https://github.com/nervosnetwork/fiber) on CKB.**

### Live at **[fiber-atlas.drreamer.digital](https://fiber-atlas.drreamer.digital/#/mainnet/overview)**: both networks, read-only, no wallet, nothing to sign.

Fiber Atlas turns the network's raw gossip and its on-chain footprint into the decision signal that wallets, routers, merchants, and node operators need but the protocol does not give them: who is out there, what do they offer, and can they be trusted to still be working tomorrow?

It has two halves:

- **Atlas** covers every node and channel in the *public* graph: capacity, fee policy, liveness. One observing node sees them all. This is not a dashboard for the single node you operate.
- **Faultline** is an on-chain reliability feed. It watches CKB L1 for channel closes and penalty spends, attributes them back to nodes via the gossip graph, and produces a verifiable record of who force-closed, who got penalised, and how long the money stayed locked.

A node cockpit answers "is my node healthy?" Fiber Atlas answers "which of the other nodes can I trust?", and grounds the answer in CKB L1 events rather than self-reported metrics.

> Built for the **[Gone in 60ms: Fiber Network Infrastructure Hackathon](https://talk.nervos.org/t/gone-in-60ms-fiber-network-infrastructure-hackathon-announcement/10418)** (July 1–15, 2026). Category 3 (Merchant, Liquidity, LSP, Multi-Asset Infrastructure), overlapping Category 2 (Node, Routing, Diagnostics).

---

## Where to look

The UI is hash-routed and network-scoped in the URL, so any link you copy carries the network it describes. Opening the site with no hash lands on testnet; the mainnet links below are explicit.

| Page | mainnet | testnet | What it answers |
|---|---|---|---|
| Overview | [#/mainnet/overview](https://fiber-atlas.drreamer.digital/#/mainnet/overview) | [#/testnet/overview](https://fiber-atlas.drreamer.digital/#/testnet/overview) | How often channels fail, how long money stays locked, who is announcing |
| Eras | [#/mainnet/eras](https://fiber-atlas.drreamer.digital/#/mainnet/eras) | [#/testnet/eras](https://fiber-atlas.drreamer.digital/#/testnet/eras) | Force-close rate per era, which is the only stable way to read it |
| Nodes | [#/mainnet/nodes](https://fiber-atlas.drreamer.digital/#/mainnet/nodes) | [#/testnet/nodes](https://fiber-atlas.drreamer.digital/#/testnet/nodes) | Who is announcing, capacity, auto-accept, last heard |
| Channels | [#/mainnet/channels](https://fiber-atlas.drreamer.digital/#/mainnet/channels) | [#/testnet/channels](https://fiber-atlas.drreamer.digital/#/testnet/channels) | Every funding cell the scan has seen, open or closed |
| Events | [#/mainnet/events](https://fiber-atlas.drreamer.digital/#/mainnet/events) | [#/testnet/events](https://fiber-atlas.drreamer.digital/#/testnet/events) | The raw L1 feed: cooperative, force-close, penalty |
| Frozen | [#/mainnet/frozen](https://fiber-atlas.drreamer.digital/#/mainnet/frozen) | [#/testnet/frozen](https://fiber-atlas.drreamer.digital/#/testnet/frozen) | Commitment cells this scan has never seen spent |
| API | [#/mainnet/api](https://fiber-atlas.drreamer.digital/#/mainnet/api) | [#/testnet/api](https://fiber-atlas.drreamer.digital/#/testnet/api) | Every endpoint, live, with its response next to it |

Straight to the JSON, same origin:
[`/v0`](https://fiber-atlas.drreamer.digital/v0) (service index) ·
[`/health`](https://fiber-atlas.drreamer.digital/health) (scan cursors) ·
[`/v0/mainnet/summary`](https://fiber-atlas.drreamer.digital/v0/mainnet/summary) ·
[`/v0/testnet/eras`](https://fiber-atlas.drreamer.digital/v0/testnet/eras) ·
[`/v0/testnet/faultline/timing`](https://fiber-atlas.drreamer.digital/v0/testnet/faultline/timing)

---

## What it has found

The figures below were read from the live API on 2026-08-01, and each links to the endpoint that produced it. The full L1 history of both networks has been scanned, and producing all of it cost zero CKB, because Faultline is read-only.

### Mainnet has never had a penalty

[`/v0/mainnet/summary`](https://fiber-atlas.drreamer.digital/v0/mainnet/summary), entire history, first close 2025-02-28, latest event block 20,016,810:

| | |
|---|---|
| Channels ever seen | **249** (37 still open) |
| Closed cooperatively | 206, or **97.2%** of closes |
| Force-closed | 6, or **2.8%** |
| **Penalties, ever** | **0** |

In seventeen months, no party on Fiber mainnet has broadcast a revoked commitment and been swept for it. Only a complete on-chain scan can establish that, and the result is verifiable against L1 by anyone. The six force-closes are not evenly spread: three fall in the very first era, which held only four closes, three more in 18M, and none since. See [`/v0/mainnet/eras`](https://fiber-atlas.drreamer.digital/v0/mainnet/eras).

### Testnet went through a failure period, and then left it

[`/v0/testnet/summary`](https://fiber-atlas.drreamer.digital/v0/testnet/summary): 44,158 channels, 39,126 closed, 16,483 force-closed, 3,595 penalties. That is a lifetime force-close rate of **42.1%**, a figure that describes no period the network was actually in.

Every close block carries a chain-header timestamp, so the eras can be dated rather than estimated. See [`/v0/testnet/eras`](https://fiber-atlas.drreamer.digital/v0/testnet/eras) and the [chart](https://fiber-atlas.drreamer.digital/#/testnet/eras):

| Era (close block) | Closes | Force-close rate | Penalties | Dated from headers |
|---|---|---|---|---|
| 13M | 24 | not published, below the 30-close floor | 0 | 2024-05-20 → 2024-06-19 |
| 14M | 83 | 16.9% | 0 | 2024-08-26 → 2024-10-23 |
| 15M | 271 | 8.1% | 0 | 2024-10-28 → 2025-01-24 |
| 16M | 679 | 6.5% | 0 | 2025-02-03 → 2025-04-27 |
| 17M | 703 | 14.9% | 1 | 2025-04-27 → 2025-07-28 |
| **18M** | 11,372 | **33.0%** | **2,825** | 2025-07-29 → 2025-10-30 |
| **19M** | 19,539 | **63.9%** | 769 | 2025-10-31 → 2026-02-02 |
| 20M | 4,797 | 0.5% | 0 | 2026-02-02 → 2026-05-06 |
| 21M | 1,658 | 2.1% | 0 | 2026-05-06 → 2026-07-31 |

The failures are concentrated in 2025-07 through 2026-02 and fall by two orders of magnitude afterwards. Penalties follow the same curve and stop with it. Quoting the lifetime 42% would attribute that period's behaviour to every node that happened to be online during it.

### How long the money stays locked

A force-close does not lose funds; it locks them behind a timelock. [`/v0/testnet/faultline/timing`](https://fiber-atlas.drreamer.digital/v0/testnet/faultline/timing) measures the wait in hours, derived from chain headers:

| | n | median | p75 | p95 | max |
|---|---|---|---|---|---|
| Settlement after force-close (testnet) | 50,610 | 4.0h | 18.2h | 95.8h | 470h |
| Penalty sweep (testnet) | 3,595 | 2.6h | 2.9h | 16.3h | 110h |
| Settlement after force-close (mainnet) | 8 | 4.0h | 23.8h | not published | 24.4h |

A long settlement is usually a contract delay period elapsing rather than a participant failing. Cells never seen spent are counted separately and never averaged in, because an unresolved close is a different outcome rather than a fast one: **4,982** on testnet, oldest 2024-10-12, and **2** on mainnet. See [`/faultline/unresolved`](https://fiber-atlas.drreamer.digital/v0/testnet/faultline/unresolved) and the [Frozen page](https://fiber-atlas.drreamer.digital/#/testnet/frozen).

### Most channels are invisible to gossip

Fiber channels can be opened private (`is_public()` is false when `public_channel_info` is unset). Those are never announced and never carry a `ChannelUpdate`. Comparing live announced channels against open funding cells on L1:

| Network | Open funding cells | Announced in gossip | |
|---|---|---|---|
| mainnet | 37 | 19 | **51.4%** |
| testnet | 5,032 | 722 | **14.4%** |

The API serves this ratio with its own warning attached, and the warning should travel with it: it divides two differently-scoped sets, since gossip sees only live public channels now while the denominator is every channel the archive has not seen close. It is a coverage indicator, not a measure of what share of Fiber channels are public.

Atlas therefore describes the public graph. Faultline, scanning L1, sees every channel. That is why the two halves have very different coverage, and why node-level attribution is thin by construction: 252 of 93,331 testnet events (0.27%) and 0 of 220 mainnet events name a node pair. `/faultline/nodes/{pubkey}` returns `observed: false` with null counts rather than a zero that would read as a clean record.

---

## Three rules, enforced in the response shape

Documentation is easy for a client author to skip, so the specs' normative rules are enforced by what the API will and will not emit:

1. **Capacity is never presented as spendable.** The field is `capacity_shannons`, and channel payloads carry an explicit `capacity_is_not_balance` note (**A+04**). Fiber does not gossip balances for third-party channels at all.
2. **Attribution never travels without its label.** Every event embeds `attribution` as one of `node_pair`, `channel` or `unattributed`, and unattributed events are served rather than hidden (**F-02**, **F+04**).
3. **Counts are never served alone, and there is no lifetime reliability figure.** `/faultline/nodes/{pubkey}` requires a window and returns exposure-normalised rates beside the counts (**F+05**). Rates over fewer than 30 samples are withheld with a stated reason rather than rounded into a number.

One further rule applies to everything on screen or in print: every published figure names its network. Testnet's force-close rate is 42% and mainnet's is 2.8%, so a figure that travels without its label is misleading by an order of magnitude.

---

## Why this is infrastructure, not an app

A payment-channel network forces every actor to choose: which peer to open a channel with, which route to attempt, which LSP to trust for inbound liquidity. Fiber's protocol gives them almost nothing to choose on. It broadcasts topology and capacity, withholds live balances for privacy, and provides no reliability signal at all.

Today each actor answers "will this actually work?" privately: hardcoded LSP defaults, trial-and-error retries, and word of mouth about which node to trust. The last of those puts reliability back into the category of social fact rather than something anyone can check.

| Consumer | Uses Fiber Atlas to… |
|----------|----------------------|
| **Wallets** | Pick default LSPs; pre-filter dead or stale channels before path-finding |
| **Routing nodes** | Skip disabled and stale channels, for fewer failed payments and lower latency |
| **Merchants and payment services** | Decide which LSP to rely on for inbound capacity |
| **Node operators** | Benchmark their own channels against the network's |
| **Downstream builders** | Dashboards, alerting, SLA products, and bonded-LSP layers over the API |

Every one of them is asking about other nodes, not itself, which is why Atlas is network-scoped rather than a per-node operability tool. It never holds funds, never moves value, and never acts on the network. It observes and serves derived signal, which is the shape block explorers, graph indexers and liveness feeds all share.

---

## Prior art, and what is different here

**A network-wide Fiber explorer already exists.** CKB Explorer has a Fiber section at `explorer.nervos.org/fiber/graph`, built by Magickbase, with node lists, channel lists, capacity and fee-rate statistics, and a node world map. Anyone evaluating this project will find it, so it is named here rather than left to be discovered. It covers roughly the same ground as the Atlas half. Three things separate them.

**1. Faultline has no counterpart.** Neither the CKB Explorer Fiber routes nor Magickbase's standalone `fiber-explorer` has any concept of close classification, force-close, penalty, freeze duration, or reliability. The idea is not novel: mempool.space has classified Lightning closes as mutual, force, and force-with-penalty for years, and it is standard for a mature payment-channel explorer. It is simply absent from Fiber. The gap is the contribution, not the idea.

**2. The incumbent's mainnet instance is empty.** Re-checked 2026-08-01:

| | CKB Explorer API | Fiber Atlas |
|---|---|---|
| mainnet nodes | **0** | 6 |
| mainnet channels | **0** | 249 ever, 37 open |
| testnet channels | 12 | 44,158 ever, 5,032 open, 722 announced |

`mainnet-api.explorer.nervos.org/api/v2/fiber/graph_nodes` returns `{"fiber_graph_nodes":[],"meta":{"total":0}}`. The mainnet channels this project found on L1 do exist. Verify with that URL before relying on this comparison: if the indexer is repaired, this row stops being true and the argument rests on Faultline alone.

**3. It does not display what it cannot know.** The CKB Explorer channel page advertises `Balance (Local/Remote)` and `TLC Balance (Offered/Received)`. Fiber does not gossip those for third-party channels: `ChannelUpdateInfo.outbound_liquidity` is populated only for channels the querying node is itself a party to, and is `None` for every channel reconstructed from gossip. This project forbids such fields by spec ([SPEC-ATLAS §5.1](./specs/SPEC-ATLAS.md), A+04).

---

## What it does not claim

These are limits of the available data, not TODOs:

- **No live routable liquidity.** Balances are not broadcast, for privacy. Atlas shows capacity, which is an upper bound, not what a channel can carry right now. It improves route selection probabilistically. It is a prior, not an oracle.
- **No payment success rate.** Payment failures are visible only to your own node and carry no per-hop attribution. Faultline is therefore built from on-chain failures, which are hard evidence but sparse, plus liveness and staleness, which are soft but plentiful. There is no network-wide success ledger.
- **A force-close is not proof of misbehaviour.** A peer going offline forces one too. Faultline serves weighted evidence rather than verdicts, and its penalty, force-close and cooperative gradient is a signal hierarchy rather than a judgment.
- **Node attribution is bounded by the announced ratio, not by effort.** A private channel's events are permanently attributable to the channel and never to its nodes. Waiting longer does not fix this; it is structural. The published join rate makes the bound explicit rather than hiding it.
- **Staleness is measured against this observer.** It degrades if the observing node loses peers, so cross-check `/health.gossip_last_run_at`.
- **Value is contingent on Fiber's growth.** This is infrastructure for a network that must grow to matter.

---

## Architecture

```
        ┌─────────────────────┐         ┌──────────────────────┐
        │  Fiber node (RPC)   │         │   CKB L1 (indexer)   │
        │  graph_nodes        │         │  spends of:          │
        │  graph_channels     │         │   funding-lock       │
        │  (gossip sync)      │         │   commitment-lock    │
        └──────────┬──────────┘         └──────────┬───────────┘
                   │ topology, policy,             │ closes, force-closes,
                   │ liveness                      │ penalties, freeze times
                   ▼                               ▼
          ┌────────────────────────────────────────────────┐
          │              Fiber Atlas indexer               │
          │   join on channel_outpoint  ->  attributed     │
          │   node + channel reliability records           │
          └───────────────────────┬────────────────────────┘
                                  │  REST / JSON API  (/v0)
                                  ▼
                 ┌───────────────────────────────────┐
                 │  web UI  +  API for wallets,      │
                 │  routers, merchants, operators    │
                 └───────────────────────────────────┘
```

The join on `channel_outpoint` is the core idea. The gossip graph knows which two nodes a channel belongs to; CKB L1 knows what happened to it. Neither alone is enough; together they produce attributed reliability records that can be checked against the chain.

The two ingest paths are independent rather than a pipeline. L1 scanning finds closes and penalties network-wide on its own, and gossip is only what attributes them to nodes. Faultline therefore degrades gracefully: an event whose channel is unknown to the graph is quarantined and reported as unattributed, never dropped.

The UI is drawn as a peer of the other consumers rather than above them. It reads the same public endpoints on the same origin, with no privileged access to the store.

### Running it requires your own Fiber node

Fiber's RPC binds to `127.0.0.1:8227` and refuses to start on a public interface without authentication configured, so there is no public gossip endpoint to point at. That is by design, since the RPC controls funds. Anyone self-hosting Fiber Atlas runs an `fnn` instance alongside it.

This is cheaper than it sounds. The Fiber node needs no local CKB chain sync, since it uses a remote CKB RPC, and prebuilt binaries are published. The CKB L1 side needs no node at all: the public CKB RPC exposes the indexer Faultline scans.

---

## The API

Read-only, zero dependencies, `node:http`. Every route is network-scoped and every response carries its `network` back. Browse it live at [#/mainnet/api](https://fiber-atlas.drreamer.digital/#/mainnet/api), which renders each endpoint next to its actual response.

```
GET /                                          the web UI
GET /v0                                        service index: version, networks, routes
GET /health                                    per-network scan cursors and coverage

GET /v0/{network}/summary                      channel counts, penalties, attribution coverage
GET /v0/{network}/eras                         force-close rate per block era
GET /v0/{network}/activity                     opens, closes and force-closes per month
GET /v0/{network}/distribution                 capacity, fee-rate and channel-lifetime percentiles
GET /v0/{network}/concentration                capacity and channel share, top-N and HHI
GET /v0/{network}/liveness                     enabled, disabled, unknown; announcement freshness
GET /v0/{network}/geo                          country and hosting-provider spread, with coverage
GET /v0/{network}/lsps                         LSP candidates: auto-accept, capacity, last seen

GET /v0/{network}/nodes                        ranked by open channels
GET /v0/{network}/nodes/{pubkey}               detail, channels, windowed reliability
GET /v0/{network}/channels?status=open|closed
GET /v0/{network}/channels/{outpoint}          detail and its on-chain events
GET /v0/{network}/channels/{outpoint}/updates  per-direction ChannelUpdate history

GET /v0/{network}/faultline/events?kind=penalty|force_close|cooperative_close&after={cursor}
GET /v0/{network}/faultline/penalties
GET /v0/{network}/faultline/timing             freeze duration percentiles
GET /v0/{network}/faultline/unresolved         commitment cells never seen spent
GET /v0/{network}/faultline/nodes/{pubkey}?window_blocks=200000
```

`/v0` also returns a `reading_the_data` block covering time, attribution and units. Read it before drawing an axis. The API opens the SQLite files with SQLite's read-only flag, so a serving process cannot corrupt the archive it shares with the scanner.

> The service index lives at `/v0` as well as `/`, because with the UI mounted the root returns HTML. `/health` and every `/v0/{network}/…` route are unaffected.

---

## The web UI

`web/` is a hash-routed page over the public API: three files, no framework, no build step, no dependencies, served by the same process on the same origin. `npm run serve` mounts it at `/`; set `FIBER_ATLAS_WEB_DIR=""` to serve the API alone, or open `web/index.html` with `?api=https://fiber-atlas.drreamer.digital` to point a local page at the deployed API.

It is a reader of the API, not a privileged client. Every figure on screen comes from a documented endpoint, each page links to the JSON behind it, and every spec citation in the copy links to the file it names.

The design brief is [`specs/SPEC-FRONTEND.md`](./specs/SPEC-FRONTEND.md). Its §4 rules constrain what the UI is allowed to imply, and they are why several things on screen look like omissions:

- **Two sources are never mixed.** A square marks the chain: every event, complete and verifiable, describing the past. A circle marks node chatter: self-reported, heard by one listener, incomplete, describing now.
- **The lifetime rate is rendered struck through**, next to its numerator and denominator, and routes to the per-era view. Hiding it would leave a reader to divide the two counts and quote the result without the caveat.
- **There is no per-node reliability column**, because there is no per-node reliability. Where the API answers `observed: false`, the page prints the absence and the reason rather than a zero or a pass mark.
- **A rate withheld for small n is never drawn as a bar.** The era chart renders those windows as a hatched placeholder carrying the raw count.
- **Enabled, disabled and unknown are three states**, kept apart on both the node and channel pages.
- **Empty states are written, not defaulted.** Mainnet's zero penalties render as a stated result rather than an empty table.

---

## Running it yourself

Requires **Node 24+**, for native TypeScript execution and the built-in `node:sqlite`. There are no runtime dependencies.

```bash
npm install                   # dev-only: typescript + @types/node
```

### Faultline, the L1 scanner

No Fiber node is required for this. Detection is independent of the gossip graph, per [SPEC-FAULTLINE §2.3](./specs/SPEC-FAULTLINE.md).

```bash
npm run scan -- --pages 4     # scan 4 pages per pass; omit --pages for a full backfill
npm run stats                 # classification breakdown
npm run replay                # re-derive every event from the local archive, offline
```

Mainnet is far smaller and costs almost nothing to scan: 459 funding-lock and 15 commitment-lock transactions for its entire history, well under a minute.

```bash
FIBER_NETWORK=mainnet CKB_RPC_URL=https://mainnet.ckbapp.dev/ \
  FIBER_ATLAS_DB=./data/fiber-atlas.mainnet.db npm run scan
```

The scan is resumable. An indexer cursor is persisted per pass after each page and all writes are idempotent, so an interrupted run re-does at most one page.

The crawl is paid once. A full testnet backfill is roughly 190,000 RPC round-trips. Both the raw transactions and the indexer's grouping are archived, so any later change to a classification rule, or any field a future phase needs that this one did not extract, is a local `npm run replay` rather than another crawl. `replay` is wired to an unreachable RPC so it cannot silently fall back to the network.

> An empty scan is a configuration failure, not a quiet network. Lock code hashes differ between testnet and mainnet, and a scanner pointed at the wrong set returns zero results indistinguishably from "nothing happened". The scanner preflights both hashes and refuses to start if either indexes nothing.

### Atlas, the gossip ingest

Requires a local `fnn` node synced to gossip, since there is no public Fiber RPC to point at.

```bash
npm run ingest                # one pass
npm run ingest -- --watch     # poll continuously (default every 60s)
```

Each pass reports the join rate against L1: what fraction of gossip channels have a funding cell the scanner has seen. That is acceptance test A+05, and it is reported every run rather than assumed, because the two sources encode `channel_outpoint` differently. Fiber packs it as 36 bytes (`tx_hash ‖ index-LE`) and CKB returns `{tx_hash, index}`. Comparing them naively yields a 0% join that looks like "gossip has never heard of these channels" rather than a formatting bug. Normalisation lives in `src/ckb/outpoint.ts`.

### Enrichment passes

```bash
node --experimental-sqlite src/bin/blocktime.ts --watch   # header timestamps for referenced blocks
node --experimental-sqlite src/bin/geo.ts --watch         # node location, needs CLOUDFLARE_API_TOKEN
```

Timestamps are never interpolated. A block whose header has not been fetched is served as `null`, and `summary.time_coverage` reports how many are outstanding.

Geo looks up only the IP addresses nodes broadcast about themselves. Nothing is probed or scanned, private and loopback ranges are never sent anywhere, and results are cached per IP. Without a token the pass exits 0 having done nothing, and the API reports coverage either way, so an unresolved node is visibly unresolved rather than dropped from a map. The token is a Cloudflare **Custom Token** with **Account → Radar → Read**; nothing else is needed, and no zone scope is involved. See [Cloudflare's Radar API guide](https://developers.cloudflare.com/radar/get-started/first-request/).

### The server

```bash
npm run serve                 # http://0.0.0.0:8080, UI at /, API under /v0
```

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `FIBER_NETWORK` | `testnet` | `testnet` or `mainnet`; selects the lock code hashes |
| `CKB_RPC_URL` | `https://testnet.ckbapp.dev/` | must have the indexer enabled |
| `FIBER_ATLAS_DB` | `./data/fiber-atlas.<network>.db` | single-network tools |
| `FIBER_ATLAS_DB_DIR` | not set | server: serve every network database found here |
| `FIBER_ATLAS_WEB_DIR` | `./web` | set to `""` to serve the API alone |
| `FIBER_RPC_URL` | `http://127.0.0.1:8227` | the local `fnn` node, for ingest |
| `CLOUDFLARE_API_TOKEN` | not set | optional; without it geo enrichment is skipped |
| `SCAN_CONCURRENCY` | `8` | |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | |

### The whole thing, with Docker

Both networks run side by side. Per network there is an `fnn` gossip node, an ingest loop, an L1 scan loop, a block-time pass and a geo pass, plus one shared API.

This is deliberately not a network toggle. Testnet and mainnet tell opposite stories, so infrastructure that had to be configured to one network would eventually serve it labelled as the other. Each network gets its own node, its own SQLite file, and its own loops; nothing is shared.

```bash
cp docker/.env.example docker/.env
# set FIBER_SECRET_KEY_PASSWORD (openssl rand -hex 32)
# optionally set CLOUDFLARE_API_TOKEN for geo enrichment

docker compose -f docker/compose.yml up -d
docker compose -f docker/compose.yml --profile tools run --rm stats-mainnet
```

The API container publishes no host port. Publishing one would expose the origin directly and let traffic bypass the reverse proxy in front of it.

#### It holds no funds, on either network

Gossip is a broadcast protocol, so a node with zero channels and zero CKB sees the entire public graph. Fiber Atlas never sends a payment, so it never needs a channel. Three properties are enforced in `docker/fnn-entrypoint.sh` rather than left to a config file:

1. **It never announces itself.** An announced observer injects a non-routable phantom node into the graph it is measuring. Mainnet's upstream config ships `announce_listening_addr: true`, so this must be actively flipped.
2. **It never auto-accepts channels.** `auto_accept_channel_ckb_funding_amount` belongs to `fnn`, not to this project, and its default is on at 99 CKB. Upstream's config omits the key entirely, so absence means enabled, and the entrypoint inserts `0`. Deleting that line re-enables it.
3. **The wallet key is random and unfunded.** This is the actual guarantee. A key holding nothing cannot spend regardless of how any flag is set; configuration is the second line of defence, not the first.

The `fnn` version is pinned via `FNN_VERSION` and must track what the network runs rather than `releases/latest`: the 0.9.x line ships as pre-releases while `latest` still resolves to 0.8.1. A node on the wrong version does not error. It peers with nobody and keeps serving a frozen graph. Check the `version` distribution in `graph_nodes` before bumping it, per [`plan.md`](./plan.md) §1.2.

---

## Documents

- [`specs/SPEC-ATLAS.md`](./specs/SPEC-ATLAS.md), the visibility layer: data model, gossip RPC sources, derived liveness metrics, API surface.
- [`specs/SPEC-FAULTLINE.md`](./specs/SPEC-FAULTLINE.md), the reliability feed: on-chain event model, `channel_outpoint` attribution, the penalty and force-close gradient, credibility weighting, caveats.
- [`specs/SPEC-FRONTEND.md`](./specs/SPEC-FRONTEND.md), the design brief and the rules that constrain what the UI is allowed to imply.
- [`plan.md`](./plan.md), verified prerequisites, architecture consequences, and the phased build.

## Status

Ongoing. Working and deployed today at **[fiber-atlas.drreamer.digital](https://fiber-atlas.drreamer.digital/#/mainnet/overview)**: the L1 scanner and classifier for both networks with full history backfilled, the gossip ingest, the join between them, block-time and geo enrichment, the read-only HTTP API, and the web UI over it.

> Counts served by a network still backfilling are lower bounds, not final figures. [`/health`](https://fiber-atlas.drreamer.digital/health) reports each network's scan-cursor state so you can tell the difference. A cursor whose `last_advanced_at` keeps moving between polls means the scan is still running.

## License

TBD before first release.

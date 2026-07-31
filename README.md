# Fiber Atlas

**Network visibility and on-chain reliability for the [Fiber Network](https://github.com/nervosnetwork/fiber) on CKB.**

Fiber Atlas is a read-layer for Fiber. It turns the network's raw gossip and its on-chain footprint into the decision signal that wallets, routers, merchants, and node operators need but the protocol does not give them: *who is out there, what do they offer, and can they be trusted to still be working tomorrow?*

It has two parts:

- **Atlas** — a network-wide view of *every* node and channel — capacity, fee policy, and liveness — built from the gossip graph. You run one node to observe them all; it is **not** a dashboard for the single node you operate.
- **Faultline** — an on-chain reliability feed. It watches CKB L1 for channel closes and penalty spends, attributes them back to nodes via the gossip graph, and surfaces an **unforgeable** record of who force-closed and who got penalized.

**Two things set Fiber Atlas apart from single-node operability tools:** it is *network-wide* — every node from the gossip graph, not a cockpit for the one node you run — and it is *on-chain* — reliability grounded in verifiable CKB L1 events, not self-reported metrics. A node cockpit answers *"is my node healthy?"*; Fiber Atlas answers *"which of the other nodes can I trust?"*

> Built for the **[Gone in 60ms — Fiber Network Infrastructure Hackathon](https://talk.nervos.org/t/gone-in-60ms-fiber-network-infrastructure-hackathon-announcement/10418)** (July 1–15, 2026). Category 3 (Merchant, Liquidity, LSP, Multi-Asset Infrastructure) with strong overlap into Category 2 (Node, Routing, Diagnostics Infrastructure).

---

## Why this is infrastructure, not an app

A payment-channel network forces every actor to *choose* — which peer to open a channel with, which route to attempt, which LSP to trust for inbound liquidity. Fiber's protocol deliberately gives them almost nothing to choose on: it broadcasts topology and capacity, **withholds live balances** (privacy), and provides **no reliability signal at all**.

Today each actor answers "will this actually work?" privately and badly — hardcoded LSP defaults, trial-and-error payment retries, and Discord word-of-mouth about which node to trust. That last one is the custodial-trust problem reappearing at the routing layer: reliability becomes a *social* fact instead of a verifiable one.

Fiber Atlas fills that gap as a **shared, verifiable data plane** that many roles depend on rather than consume as an end product:

| Consumer | Uses Fiber Atlas to… |
|----------|----------------------|
| **Wallets** | Pick default LSPs; pre-filter dead/stale channels before path-finding |
| **Routing nodes** | Skip disabled/stale channels → fewer failed payments, lower latency |
| **Merchants / payment services** | Decide which LSP to rely on for inbound capacity |
| **Node operators** | Monitor, benchmark, and spot degradation in their own and peers' channels |
| **Downstream builders** | Build dashboards, alerting, SLA products, and bonded-LSP layers on the API |

Crucially, every one of these consumers is asking about *other* nodes, not itself — which is why Atlas is network-scoped rather than a per-node operability tool. It never holds user funds or moves value, and it never acts on the network (no rebalancing, no payments). It observes and serves derived signal — the canonical infrastructure shape (block explorers, graph indexers, liveness feeds all live here).

---

## What it actually surfaces

Grounded in what Fiber's RPC and CKB L1 genuinely expose (see [`specs/`](./specs) for the verified sourcing):

### Atlas (visibility)
- **Topology** — every node and channel in the network, from `graph_nodes` / `graph_channels` gossip RPC.
- **Capacity & policy** — per-channel capacity, fee rates, minimum TLC value, TLC expiry delta, and `enabled`/`disabled` state, per direction, from `ChannelUpdateInfo`.
- **Liveness / staleness** — how fresh each channel's last update is, as a soft "is this path plausibly alive" signal.

### Faultline (on-chain reliability)
- **Channel closes** — detected as spends of the funding cell (`channel_outpoint`) on CKB L1, attributed to the channel's two nodes.
- **Force-closes** — closes whose outputs carry the `commitment-lock` (unilateral close), a mild negative signal.
- **Penalties** — subsequent revocation-branch spends of a `commitment-lock` cell, i.e. a party broadcast a revoked state and got swept. This is **provable misbehavior** and the strongest negative signal.

---

## What it does NOT claim (honest boundaries)

These are hard limits of the available data, not TODOs:

- **No live routable liquidity.** Channel *balances* are not broadcast by Fiber (privacy). Atlas shows capacity — an upper bound — not what a channel can carry right now. It improves route selection *probabilistically*; it is a prior, not an oracle.
- **No payment success rate.** Payment failures are visible only to your own node and carry no per-hop attribution. Faultline is therefore built from **on-chain failures (hard, sparse) + liveness/staleness (soft, plentiful)** — not from a network-wide success/failure ledger.
- **Force-close ≠ guilt.** Not every force-close is misbehavior (a peer going offline forces one too). Faultline serves *weighted evidence*, not verdicts, and its penalty→force-close→cooperative gradient is a signal hierarchy, not a judgment.
- **Most channels are invisible to gossip.** Fiber channels can be opened as **private** (`is_public()` is false when `public_channel_info` is unset); private channels are never announced and never carry a `ChannelUpdate`. Measured on CKB testnet 2026-07-31: **925 channels in the gossip graph against 5,017 live funding cells on L1 — only ~18% of currently-open channels are publicly announced.** Atlas therefore describes the *public* graph, not every channel that exists. Faultline, scanning L1, sees all of them — which is why the two halves have very different coverage (see below).
- **Node-level attribution is bounded by that ratio, not by effort.** Faultline detects every close and penalty on L1, public or private. But attributing one to a *node pair* requires the gossip graph, so a private channel's events are permanently attributable only to the channel, never to its nodes. Waiting longer does not fix this; it is structural. The published join rate makes the bound explicit rather than hiding it.
- **Value is contingent on Fiber's growth.** This is infrastructure for a network that must grow to matter. That is the honest bet.

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
                   │ liveness                      │ penalties
                   ▼                               ▼
          ┌────────────────────────────────────────────────┐
          │              Fiber Atlas indexer               │
          │   join on channel_outpoint  →  attributed      │
          │   node + channel reliability records           │
          └───────────────────────┬────────────────────────┘
                                   │  REST / JSON API
                                   ▼
                 ┌───────────────────────────────────┐
                 │  Dashboard  +  API for wallets,    │
                 │  routers, merchants, operators     │
                 └───────────────────────────────────┘
```

The **join on `channel_outpoint`** is the core idea: the gossip graph knows *which two nodes* a channel belongs to; CKB L1 knows *what happened to it*. Neither alone is enough; together they produce attributed, unforgeable reliability records.

The two ingest paths are **independent**, not a pipeline. L1 scanning finds closes and penalties network-wide on its own; the gossip graph is what attributes them to nodes. Faultline therefore degrades gracefully — an event whose channel is unknown to the graph is quarantined and reported as unattributed, never dropped.

### Running it requires your own Fiber node

Fiber's RPC binds to `127.0.0.1:8227` by default and **refuses to start on a public interface** without authentication configured, so there is no public gossip endpoint to point at — by design, since that RPC controls funds. Anyone self-hosting Fiber Atlas runs an `fnn` instance alongside it.

This is cheaper than it sounds: the Fiber node needs **no local CKB chain sync** (it uses a remote CKB RPC), and prebuilt binaries are published. The CKB L1 side needs no node at all — the public CKB RPC exposes the indexer that Faultline scans.

---

## Specifications

- [`specs/SPEC-ATLAS.md`](./specs/SPEC-ATLAS.md) — the visibility layer: data model, gossip RPC sources, derived liveness metrics, API surface.
- [`specs/SPEC-FAULTLINE.md`](./specs/SPEC-FAULTLINE.md) — the reliability feed: on-chain event model, `channel_outpoint` attribution, the penalty/force-close/cooperative gradient, credibility weighting, and caveats.

## Build plan

- [`plan.md`](./plan.md) — the scoped ~2.5-day hackathon build: core vs stretch vs dropped, stack, day-by-day milestones, and the demo script.

---

## Status

Early — hackathon build in progress. Specs first; implementation tracked in [`plan.md`](./plan.md).

## License

TBD before first release.

---

## Running the Atlas gossip ingest

Requires a local `fnn` node synced to gossip (see above — there is no public Fiber RPC to point at).

```bash
npm run ingest              # one pass
npm run ingest -- --watch   # poll continuously (default every 60s)
```

`FIBER_RPC_URL` defaults to `http://127.0.0.1:8227`.

Each pass reports the **join rate** against L1: what fraction of gossip channels have a funding cell the Faultline scanner has seen. That is acceptance test A+05, and it is reported every run rather than assumed, because the two sources spell `channel_outpoint` differently — Fiber packs it as 36 bytes (`tx_hash ‖ index-LE`), CKB returns `{tx_hash, index}`. Comparing them naively yields a 0% join that looks like "gossip has never heard of these channels" rather than a formatting bug. Normalisation lives in `src/ckb/outpoint.ts`.

## Running the Faultline scanner

Phase 1 is implemented: the L1 scanner detects and classifies channel closes, force-closes, and penalties directly from CKB L1. **No Fiber node is required for this** — detection is independent of the gossip graph (see [`SPEC-FAULTLINE.md`](./specs/SPEC-FAULTLINE.md) §2.3).

Requires **Node 24+** (uses native TypeScript execution and the built-in `node:sqlite`). There are no runtime dependencies.

```bash
npm install                 # dev-only: typescript + @types/node
npm run scan -- --pages 4   # scan 4 pages per pass; omit --pages for a full backfill
npm run stats               # classification breakdown
npm run replay              # re-derive every event from the local archive, offline
```

Configuration is via environment variables:

| Variable | Default | Notes |
|---|---|---|
| `FIBER_NETWORK` | `testnet` | `testnet` or `mainnet` — selects the lock code hashes |
| `CKB_RPC_URL` | `https://testnet.ckbapp.dev/` | must have the indexer enabled |
| `FIBER_ATLAS_DB` | `./data/fiber-atlas.<network>.db` | |

The scan is resumable: an indexer cursor is persisted per pass after each page, and all writes are idempotent, so an interrupted run re-does at most one page.

**The crawl is paid once, ever.** A full history backfill is ~190,000 RPC round-trips (83,249 funding-lock + 106,841 commitment-lock transactions on testnet as of 2026-07-31). Both the raw transactions *and* the indexer's grouping are archived, so any later change to a classification rule — or any field a future phase needs that this one did not extract — is a local `npm run replay`, never another crawl. `replay` is wired to an unreachable RPC so it cannot silently fall back to the network.

> **An empty scan is a configuration failure, not a quiet network.** Lock code hashes differ between testnet and mainnet, and a scanner pointed at the wrong set returns zero results indistinguishably from "nothing happened". The scanner preflights both hashes and refuses to start if either indexes nothing.

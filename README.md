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
- **Capacity & policy** — per-channel capacity, fee rates, min/max HTLC, and `enabled`/`disabled` state from `ChannelUpdate` info.
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

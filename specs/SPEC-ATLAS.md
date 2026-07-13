# SPEC-ATLAS: Network Visibility Layer

Status: **Draft**
Version: **0.1.0**
Part of: [Fiber Atlas](../README.md)
Companion: [`SPEC-FAULTLINE.md`](./SPEC-FAULTLINE.md)

Atlas is the visibility half of Fiber Atlas: a normalized, queryable, historical view of the Fiber network's nodes and channels, derived from a single Fiber node's gossip graph. It answers *who is on the network, what do they offer, and is it plausibly alive.*

---

## 1. Scope

### 1.1 In scope
- Ingesting the Fiber gossip graph (`graph_nodes`, `graph_channels`) into a queryable store.
- Deriving per-channel and per-node liveness/staleness signals.
- Serving topology, capacity, policy, and liveness via a stable API.

### 1.2 Out of scope
- Live channel balances (not broadcast by Fiber — see §5).
- Payment success/failure data (see [`SPEC-FAULTLINE.md`](./SPEC-FAULTLINE.md) §5 for why the reliable signal is on-chain).
- Path-finding or route recommendation (Atlas is a data plane; routing is a consumer).

---

## 2. Data Sources

All sourced from a Fiber node's JSON-RPC `Graph` module (verified against Fiber `v0.6.1`). Atlas requires **one** Fiber node synced to the gossip network; it does not need to operate channels itself.

### 2.1 `graph_nodes`
Returns network-wide node announcements. Fields consumed:

| Field | Use |
|-------|-----|
| `node_id` | Primary key. A public key; also the join key for Faultline attribution. |
| `node_name` | Display. |
| `addresses` | Connectivity display; reachability probing (optional, stretch). |
| `features` | Capability display. |
| `timestamp` | Announcement freshness. |
| `chain_hash` | Network guard (mainnet vs testnet). |
| `auto_accept_min_ckb_funding_amount` | LSP-style signal: will this node auto-accept channels, and at what floor. |
| `udt_cfg_infos` | Which UDTs the node supports (multi-asset visibility). |

### 2.2 `graph_channels`
Returns network-wide channel announcements. Fields consumed:

| Field | Use |
|-------|-----|
| `channel_outpoint` | Primary key. **The join key to CKB L1** (funding cell outpoint) used by Faultline. |
| `node1`, `node2` | The channel's two endpoints (`node_id`s). |
| `capacity` | Total channel capacity (upper bound on throughput; **not** live balance). |
| `created_timestamp` | Channel age. |
| `update_info_of_node1`, `update_info_of_node2` | Per-direction `ChannelUpdate`: fee rate, min/max HTLC, `enabled` flag, update `timestamp`. |
| `udt_type_script` | Asset the channel carries (null = native CKB). |
| `chain_hash` | Network guard. |

Both endpoints support pagination via `limit` + `after` cursor.

---

## 3. Data Model

```
Node
  node_id            (pk)
  name, version, features, addresses[]
  udt_support[]
  auto_accept_min_ckb
  first_seen, last_announced   (from timestamp)

Channel
  channel_outpoint   (pk)          ← join key to L1 / Faultline
  node1_id, node2_id (fk -> Node)
  capacity
  udt_type_script    (nullable)
  created_timestamp
  dir[node1] : { fee_rate, htlc_min, htlc_max, enabled, updated_at }
  dir[node2] : { fee_rate, htlc_min, htlc_max, enabled, updated_at }
  first_seen, last_seen
  status             : LIVE | STALE | CLOSED   (CLOSED set by Faultline)
```

Records are **append-aware**: Atlas keeps `first_seen` / `last_seen` so history and disappearance are observable, not just the latest snapshot.

---

## 4. Derived Signals

Atlas computes soft, plentiful signals. Hard signals come from Faultline.

| Signal | Definition | Meaning |
|--------|------------|---------|
| **Channel liveness** | `now - max(dir.updated_at)` bucketed (e.g. fresh < 1h, aging < 24h, stale ≥ 24h) | A stale `ChannelUpdate` suggests a node that stopped gossiping — a soft "may be down" flag. |
| **Channel enabled** | `dir.enabled` per direction | A disabled direction should be excluded from route candidates. |
| **Node liveness** | freshness of `graph_nodes.timestamp` + fraction of the node's channels that are LIVE | Aggregate "is this node participating right now." |
| **Node reach / centrality** | channel count, summed capacity, distinct peers | LSP-scale and connectivity indicator. |
| **Multi-asset coverage** | distinct `udt_type_script` across a node's channels | Which assets a node can actually route. |

> Liveness is a **prior**, not a guarantee. A fresh update means the node was gossiping recently; it does not prove a payment will route. Consumers should treat it as one input, weighted alongside Faultline's hard signals.

---

## 5. The Balance Limitation (normative)

Fiber does **not** broadcast live channel balances (a deliberate privacy tradeoff; see fiber issue #138). Therefore:

- Atlas MUST present `capacity` as an **upper bound**, never as available liquidity.
- Atlas MUST NOT imply that a channel can carry a given payment amount.
- Any "can this route X" feature is out of scope and MUST NOT be faked from capacity.

Honest capacity/topology/policy/liveness is the product. Routable-liquidity guarantees are not achievable from public data and are explicitly disclaimed.

---

## 6. API Surface (v0)

REST/JSON, read-only, cache-friendly. Illustrative shapes:

```
GET /nodes                     → [Node + derived node signals], paginated, sortable
GET /nodes/:node_id            → Node detail + its channels + Faultline summary
GET /channels                  → [Channel + liveness], filterable by node, asset, status
GET /channels/:outpoint        → Channel detail + Faultline events (join)
GET /lsps                      → nodes ranked as LSP candidates (auto-accept, capacity, liveness, Faultline)
GET /health                    → indexer sync state (gossip cursor, L1 tip, last refresh)
```

Every node/channel response embeds a Faultline summary (`force_closes`, `penalties`, `last_event_at`) so a single call answers "who and how trustworthy" together.

---

## 7. Refresh Model

- **Gossip ingest:** poll `graph_nodes` / `graph_channels` on an interval (e.g. 30–60s), upserting by primary key and advancing `last_seen`.
- **Disappearance:** records not seen for N intervals are marked stale (not deleted — disappearance is signal).
- **L1 correlation:** Faultline (see companion spec) updates `Channel.status = CLOSED` and attaches events keyed by `channel_outpoint`.

---

## 8. Test / Acceptance

- **A+01** Ingest a testnet gossip graph; node and channel counts match the source node's own graph RPC.
- **A+02** Channel `enabled=false` in a `ChannelUpdate` is reflected within one refresh interval.
- **A+03** A channel whose updates stop advancing is bucketed STALE after the staleness threshold.
- **A+04** Capacity is never presented as spendable/available balance (UI + API copy audit).
- **A+05** `channel_outpoint` in Atlas matches the funding outpoint Faultline watches on L1 (join integrity).

# SPEC-ATLAS: Network Visibility Layer

Status: **Draft**
Version: **0.2.0**
Verified against: **fnn v0.8.1** (2026-07-31)
Part of: [Fiber Atlas](../README.md)
Companion: [`SPEC-FAULTLINE.md`](./SPEC-FAULTLINE.md)

> **v0.2.0 changed field names.** This spec was originally written against fnn v0.6.1. v0.8.0 renamed `PeerId` → `Pubkey` across all RPC interfaces ([PR #1154](https://github.com/nervosnetwork/fiber/pull/1154)), and the per-direction update fields differ from what v0.1.0 assumed. Anything written against v0.1.0 of this spec needs updating — see §2 and §3.

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

All sourced from a Fiber node's JSON-RPC `Graph` module, verified against [`crates/fiber-lib/src/rpc/graph.rs` @ v0.8.1](https://github.com/nervosnetwork/fiber/blob/v0.8.1/crates/fiber-lib/src/rpc/graph.rs) and [`crates/fiber-json-types/src/graph.rs` @ v0.8.1](https://github.com/nervosnetwork/fiber/blob/v0.8.1/crates/fiber-json-types/src/graph.rs).

Atlas requires **one** Fiber node synced to the gossip network; it does not need to operate channels itself. That node is **operational infrastructure, not a dev prerequisite** — Fiber's RPC binds to `127.0.0.1:8227` by default and refuses to start on a public interface without `rpc.biscuit_public_key`, so no public gossip RPC exists to borrow. Anyone running Atlas runs an `fnn`.

### 2.1 `graph_nodes`
Returns network-wide node announcements. Fields consumed:

| Field | Use |
|-------|-----|
| `pubkey` | Primary key. The node's identity public key (secp256k1 compressed, hex); also the join key for Faultline attribution. |
| `node_name` | Display. |
| `version` | Node software version; useful for spotting unupgraded nodes. |
| `addresses` | Connectivity display; reachability probing (optional, stretch). |
| `features` | Capability display. Array of enabled feature names. |
| `timestamp` | Announcement freshness. |
| `chain_hash` | Network guard (mainnet vs testnet). |
| `auto_accept_min_ckb_funding_amount` | LSP-style signal: will this node auto-accept channels, and at what floor. |
| `udt_cfg_infos` | Which UDTs the node supports (multi-asset visibility). |

> **Naming:** this field was `node_id` prior to fnn v0.8.0. Atlas uses `pubkey` throughout — in the store, the API, and the docs — to match upstream exactly. Introducing a local alias would reintroduce precisely the drift that made v0.1.0 of this spec wrong.

### 2.2 `graph_channels`
Returns network-wide channel announcements. Fields consumed:

| Field | Use |
|-------|-----|
| `channel_outpoint` | Primary key. **The join key to CKB L1** (funding cell outpoint) used by Faultline. |
| `node1`, `node2` | The channel's two endpoints (`pubkey`s). |
| `capacity` | Total channel capacity (upper bound on throughput; **not** live balance — see §5). |
| `created_timestamp` | Channel age. |
| `update_info_of_node1`, `update_info_of_node2` | Per-direction `ChannelUpdateInfo`. **Nullable** — a direction that has never announced an update is `null`, which is distinct from a disabled one. |
| `udt_type_script` | Asset the channel carries (null = native CKB). |
| `chain_hash` | Network guard. |

#### `ChannelUpdateInfo` (per direction)

| Field | Use |
|-------|-----|
| `timestamp` | When this direction's update was received. Drives the liveness signal in §4. |
| `enabled` | Whether this direction can currently be used for payments. |
| `fee_rate` | Forwarding fee rate for the channel. |
| `tlc_minimum_value` | Minimum value relayable to the next hop via this channel. |
| `tlc_expiry_delta` | Required difference in TLC expiry when routing through this channel (milliseconds). |
| `outbound_liquidity` | **Do not consume.** Nullable, and populated only for channels our own node is a party to — see §5. |

> **There is no maximum-HTLC field.** v0.1.0 of this spec claimed "min/max HTLC"; only a minimum exists (`tlc_minimum_value`). Fiber names these `tlc_*` (its HTLC analogue), not `htlc_*`. `tlc_expiry_delta` was omitted entirely from v0.1.0 despite mattering to routing consumers.

Both endpoints paginate via `limit` + `after`. Responses are **envelopes**, not bare arrays: `{ nodes | channels: [...], last_cursor }`. Feed `last_cursor` back as `after` to advance.

---

## 3. Data Model

```
Node
  pubkey             (pk)
  name, version, features[], addresses[]
  udt_support[]
  auto_accept_min_ckb
  first_seen, last_announced   (from timestamp)

Channel
  channel_outpoint   (pk)          ← join key to L1 / Faultline
  node1_pubkey, node2_pubkey (fk -> Node)
  capacity
  udt_type_script    (nullable)
  created_timestamp
  dir[node1] : { fee_rate, tlc_minimum_value, tlc_expiry_delta, enabled, updated_at } | null
  dir[node2] : { fee_rate, tlc_minimum_value, tlc_expiry_delta, enabled, updated_at } | null
  first_seen, last_seen
  status             : LIVE | STALE | CLOSED   (CLOSED set by Faultline)
```

A direction may be `null` (never announced). Consumers MUST distinguish *unknown* from *disabled*: a `null` direction is an absence of information, while `enabled: false` is a positive statement that the direction is unusable. Collapsing the two would misreport a silent channel as a deliberately closed one.

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

### 5.1 The `outbound_liquidity` field does not change this

`ChannelUpdateInfo` exposes `outbound_liquidity: Option<u128>`, documented upstream as *"the exact amount of balance that we can send to the other party via the channel."* The name invites the assumption that Fiber now publishes routable balances. **It does not.**

Traced through fnn v0.8.1: the field is populated only from a channel the querying node is itself a party to — `get_local_channel_update_info` / `get_remote_channel_update_info` set it from `get_local_balance()` / `get_remote_balance()` in `crates/fiber-lib/src/fiber/channel.rs`. The constructors used for channels reconstructed from gossip default it to `None` (`crates/fiber-types/src/channel.rs`). For every third-party channel — which is all of them, for an observing node — it is `null`.

Normative:

- Atlas MUST NOT treat `outbound_liquidity: null` as zero, as low liquidity, or as any liquidity claim. It means *not disclosed*.
- Atlas MUST NOT serve `outbound_liquidity` in its public API, even when non-null.
- If Atlas's Fiber node ever opens its own channels, those channels alone would carry real values here. Serving that would present a **privileged view of our own peers as though it were network-wide data**, making them look better-characterized than every other node. Atlas MUST NOT do this. The asymmetry is a reason to keep the observing node channel-less (see `plan.md` §5).

Honest capacity/topology/policy/liveness is the product. Routable-liquidity guarantees are not achievable from public data and are explicitly disclaimed.

---

## 6. API Surface (v0)

REST/JSON, read-only, cache-friendly. Illustrative shapes:

```
GET /nodes                     → [Node + derived node signals], paginated, sortable
GET /nodes/:pubkey             → Node detail + its channels + Faultline summary
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

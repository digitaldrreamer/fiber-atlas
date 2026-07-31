# Build Plan — Fiber Atlas

Status: **active project, no external deadline.**
Rewritten 2026-07-31, replacing the ~2.5-day plan written for the *Gone in 60ms* hackathon (deadline 2026-07-15, passed). Scope is now set by correctness, not by a clock.

---

## What changed from the hackathon plan

The old plan's shape was dictated by a 60-hour window: Atlas first because it was guaranteed shippable, Faultline as a day-2 stretch, everything else dropped. A prereq spike on 2026-07-31 (findings in §1) invalidated that ordering. Three things are now true that were assumed otherwise:

- Faultline **does not depend on the Fiber node** for its data source, only for attribution. It can be built first and in parallel.
- Standing up a Fiber node is **cheap** (no local CKB chain sync, prebuilt binary), not the day-0 risk it was treated as.
- The specs are pinned to a Fiber version that has since had a **breaking RPC rename**.

Accordingly: no "core vs stretch" split, both halves are in scope, and the previously-dropped structural-authorization bond returns as a real (late) phase rather than a roadmap paragraph.

---

## 1. Verified prerequisites (2026-07-31)

Everything below was checked against primary sources, not assumed. Sources are cited so they can be re-verified when versions move.

### 1.1 There is no public Fiber RPC — we run our own node

This was the open question gating everything, and the answer is that a public gossip-graph RPC **cannot** exist as a matter of design:

- The shipped testnet config sets `rpc.listening_addr: "127.0.0.1:8227"` and comments: *"Allowing arbitrary machines to access the JSON-RPC port is dangerous and strongly discouraged."* — [`config/testnet/config.yml` @ v0.8.1](https://github.com/nervosnetwork/fiber/blob/v0.8.1/config/testnet/config.yml)
- The node **refuses to start** bound to a public IP unless `rpc.biscuit_public_key` is set — [RPC overview](https://www.fiber.world/docs/api-reference) (accessed 2026-07-31).
- The advertised "public testnet nodes" are **P2P relay peers identified by pubkey**, for opening channels — not RPC endpoints. Testnet node1 `02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71`, node2 `0291a6576bd5a94bd74b27080a48340875338fff9f6d6361fe6b8db8d0d1912fcc` — [`docs/public-nodes.md` @ v0.8.1](https://github.com/nervosnetwork/fiber/blob/v0.8.1/docs/public-nodes.md)

**Consequence:** running an `fnn` instance is a permanent, non-negotiable component of Fiber Atlas — for us and for anyone self-hosting it. That belongs in the README as an operational fact, not a dev-setup footnote.

### 1.2 Pin the version the NETWORK runs, not the latest stable release

**`releases/latest` is misleading for Fiber, and following it silently isolates the node.**

The v0.9.0 line ships as GitHub *pre-releases*, so `releases/latest` still reports **v0.8.1** (2026-04-15). The testnet network has moved on: of the 64 nodes in a gossip snapshot on 2026-07-31, **46 ran `0.9.0-rc7`** and only 8 ran `0.8.1`.

An `fnn v0.8.1` node on that network establishes P2P connections and then has them dropped. Observed symptoms, in the order they appear:

- `list_peers` returns `[]`
- `graph_channels` still answers, with a **stale, partial graph** frozen at whatever arrived before the peers went away (197 channels against ≥1000 live funding cells on L1)
- no error anywhere, and the node log is silent by default

Upgrading to `v0.9.0-rc7` fixed it outright: bootnodes auto-connect and peers hold. The graph RPC types are **byte-identical** between v0.8.1 and v0.9.0-rc7 (`crates/fiber-json-types/src/graph.rs`), so nothing in SPEC-ATLAS or the ingest changed — this is purely P2P protocol compatibility.

Two normative consequences:

- **Pin to the version the network runs**, checked against the `version` distribution in `graph_nodes`, not against `releases/latest`. That distribution is itself the check, and it is free.
- **Zero peers must be a hard health failure.** This is the most dangerous failure mode found so far: it is indistinguishable from a quiet network at every layer above it. Every downstream metric computes cleanly over the stale subgraph, and the join rate in particular is measured *against gossip*, so a truncated graph silently flatters it. `/health` MUST expose peer count, and the ingest MUST refuse to report a join rate when peers are zero.

### 1.3 Running the node is cheap

- **No local CKB chain sync.** `ckb.rpc_url: "https://testnet.ckbapp.dev/"` ships in the default testnet config; the Fiber node uses a remote CKB RPC.
- **No Rust build.** Prebuilt `fnn_v0.8.1-x86_64-linux.tar.gz` on the [releases page](https://github.com/nervosnetwork/fiber/releases).
- Gossip graph syncs automatically via the two configured `bootnode_addrs` on `/tcp/8228`.

### 1.4 CKB L1 is fully open, and Faultline's data is already there

Verified live against `https://testnet.ckbapp.dev/` on 2026-07-31:

- `get_blockchain_info` → `chain: "ckb_testnet"`, syncing normally.
- **The indexer is enabled on the public endpoint** — `get_cells` / `get_transactions` work without auth.
- Querying by the two Fiber lock code hashes returns **>1000 results in every category** (all four queries hit the 1000-row page cap):

| Query | Meaning | Result |
|---|---|---|
| `get_cells` on FundingLock | currently open channels | ≥1000 |
| `get_cells` on CommitmentLock | in-flight force-close outputs | ≥1000 |
| `get_transactions` on FundingLock | all-time opens + closes | ≥1000 |
| `get_transactions` on CommitmentLock | force-closes + sweeps/penalties | ≥1000 |

The code hashes come from the shipped testnet config (§1.1 source):

- **FundingLock** `0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c`
- **CommitmentLock** `0x740dee83f87c6f309824d8fd3fbdd3c8380ee6fc9acc90b1a748438afcdf81d8`

**This is the plan's biggest structural finding.** The old plan sequenced Faultline last because it was assumed to depend on the gossip graph. It does not. Scanning L1 by `CommitmentLock` code hash discovers force-closes **network-wide, independently of Atlas** — the gossip graph is needed only to *attribute* an event to `{node1, node2}`, not to *find* it. Faultline detection can start on day one with no Fiber node running, against abundant real testnet data. The old plan's headline risk ("sparse on-chain events on testnet, may need to seed a scripted force-close") is dead: there is more than enough real data.

### 1.5 The specs are pinned to a stale Fiber version — must be corrected

`SPEC-ATLAS.md` §2 says "verified against Fiber `v0.6.1`". Current release is **v0.8.1** (2026-04-15); the repo is actively pushed (2026-07-30). Two concrete drifts found:

- **Breaking rename.** v0.8.0 replaced `PeerId` with `Pubkey` across all RPC interfaces ([PR #1154](https://github.com/nervosnetwork/fiber/pull/1154), noted in `docs/public-nodes.md`). In `graph_nodes` the node identity field is now **`pubkey`**, not `node_id` — verified in [`crates/fiber-lib/src/rpc/graph.rs` @ v0.8.1](https://github.com/nervosnetwork/fiber/blob/v0.8.1/crates/fiber-lib/src/rpc/graph.rs) (`internal_node_info_to_json`). SPEC-ATLAS §2.1 and §3 name the wrong field.
- **`ChannelUpdateInfo` now carries `outbound_liquidity: Option<u128>`** — see §1.5.

`ChannelInfo`'s field set otherwise matches SPEC-ATLAS §2.2 exactly (`channel_outpoint`, `node1`, `node2`, `created_timestamp`, `update_info_of_node1/2`, `capacity`, `chain_hash`, `udt_type_script`), with the two `update_info_of_*` being **nullable** — a detail the spec should state.

### 1.6 The balance limitation survives, but needs sharpening

`ChannelUpdateInfo` gained a field whose name looks like it refutes SPEC-ATLAS §5 and the README's "no live routable liquidity" claim:

```rust
/// The exact amount of balance that we can send to the other party via the channel.
pub outbound_liquidity: Option<u128>,
```

It does not. Traced through the source: it is populated **only** from a channel our own node is a party to — `get_local_channel_update_info` / `get_remote_channel_update_info` set it from `get_local_balance()` / `get_remote_balance()` in `crates/fiber-lib/src/fiber/channel.rs`, while the constructors in `crates/fiber-types/src/channel.rs` default it to `None`. For third-party channels reconstructed from gossip it will be **`null`**.

So §5 holds, and gets two new normative clauses:

- Atlas MUST NOT treat `outbound_liquidity: null` as zero, or as any liquidity claim.
- If Atlas's own Fiber node ever opens channels, its *own* channels would carry a real value here while every other channel does not. Atlas MUST NOT serve that asymmetry as though it were network-wide data — it is a privileged view of our own node and would silently make our peers look better-characterized than everyone else.

---

## 2. Architecture consequences

Two changes to the picture in the README:

1. **Two independent ingest paths, not one pipeline.** L1 ingest (Faultline) and gossip ingest (Atlas) each run standalone and are joined afterward on `channel_outpoint`. The join is an enrichment step, not a dependency — Faultline degrades to unattributed-but-real events when the graph is missing a channel, which is exactly the `F+04` quarantine behaviour the spec already requires.
2. **The Fiber node is part of the deployed system.** Not a dev prerequisite. Health, sync lag, and bootnode connectivity of our own `fnn` are operational surface, and `/health` should report them.

---

## 3. Stack

Mostly as before; the reasoning is now "maintainable" rather than "fast to type."

- **Language:** TypeScript end-to-end.
- **Fiber access:** JSON-RPC to our own local `fnn` on `127.0.0.1:8227`. Evaluate the in-repo [`fiber-js`](https://github.com/nervosnetwork/fiber/tree/v0.8.1/fiber-js) client before hand-rolling one — if it ships usable types for `graph_nodes` / `graph_channels`, it removes a whole class of drift like §1.4.
- **CKB L1 access:** public CKB RPC + indexer (`get_cells`, `get_transactions`). [CCC](https://github.com/ckb-devrel/ccc) (`@ckb-ccc/core`) for typed access if it earns its weight; raw JSON-RPC is proven to work.
- **Store:** SQLite to start. Revisit only when a real query is too slow — with no deadline there is no excuse to pre-optimize, and no excuse to stay on it if it stops fitting.
- **API:** thin HTTP layer (Fastify/Hono) serving the shapes in the specs.
- **Dashboard:** deferred until the API is real (see §4). The API is the artifact consumers depend on.

**Schema-drift guard (new, and load-bearing).** §1.4 happened because field shapes were transcribed by hand from one version. Generate or check types against the node we actually run, and pin the `fnn` version in config so a version bump is a deliberate, visible change.

---

## 4. Phases

No dates. Each phase ends at a verifiable state, and phases 1 and 2 are genuinely parallel.

### Phase 0 — correct the record ✅ *(done 2026-07-31)*
- [x] `SPEC-ATLAS.md` → v0.2.0: `node_id` → `pubkey`, nullable `update_info_of_*`, corrected the per-direction field set (no max-HTLC exists; added `tlc_expiry_delta`), documented the response envelope, re-pinned to v0.8.1, added §5.1 on `outbound_liquidity`.
- [x] `SPEC-FAULTLINE.md` → v0.2.0: `node_id` → `pubkey`, added §2.1 script identities with provenance, §2.2 primitives, §2.3 on detection being independent of gossip.
- [x] `README.md`: added the self-hosting requirement, corrected the policy-field list, noted the two ingest paths are independent.

### Phase 1 — Faultline detection (no Fiber node needed)
- [ ] L1 scanner over `get_transactions` for both lock code hashes, cursor-persisted, resumable.
- [ ] Classify: cooperative close / force-close / penalty per SPEC-FAULTLINE §2, including the revocation-branch selector (`unlock_count == 0x00`) (**F+02**, **F+03**).
- [ ] Backfill the full testnet history; report the real class distribution. This is the first genuinely novel output — nobody currently knows what it looks like.
- [ ] Events land unattributed at this stage. That is expected, not a gap (**F+04** quarantine).

### Phase 2 — Atlas ingest (parallel with Phase 1) — *in progress*
- [x] Stand up `fnn` v0.8.1 on testnet against the public CKB RPC; gossip sync confirmed.
      Runs **observe-only**: `announce_listening_addr: false`, no channels, no funds.
      Announcing would inject a non-routable phantom node into the graph Atlas measures.
- [x] `graph_nodes` + `graph_channels` ingest → SQLite, cursor pagination, `first_seen` / `last_seen`.
- [x] Outpoint normalisation (`src/ckb/outpoint.ts`) — Fiber packs `channel_outpoint` as
      36 bytes (`tx_hash ‖ index-LE`), CKB returns `{tx_hash, index}`. Without conversion the
      join reads 0%, indistinguishable from "gossip has never heard of these channels".
      Join rate is now reported every ingest run (**A+05**).
- [ ] **A+01** proper: assert ingested counts match the source node's own graph RPC.
      Currently true by construction, not asserted.
- [ ] Derived signals: liveness buckets, `enabled` handling, node liveness/centrality, multi-asset coverage (**A+02**, **A+03**).
      **Unblocked.** The "no ChannelUpdate coverage" that appeared to block this was a symptom of
      the isolated node in §1.2, not a property of the network. On a correctly-versioned peered
      node, coverage went from 2/394 directions to 902/936 within one refresh.

### Phase 3 — the join
- [ ] Attribute Phase 1's events via `channel_outpoint` → `{node1, node2}` (**A+05**).
- [ ] Attribution confidence labelling: channel / side / node (**F-02**).
- [ ] Measure the join hit rate. Channels closed before our node ever saw them in gossip are permanently unattributable — quantify that, because it bounds Faultline's real-world coverage and belongs in the honest-limits section.

### Phase 4 — API
- [ ] Atlas: `/nodes`, `/nodes/:pubkey`, `/channels`, `/channels/:outpoint`, `/lsps`, `/health`.
- [ ] Faultline: `/faultline/nodes/:pubkey`, `/faultline/channels/:outpoint`, `/faultline/events`, `/faultline/penalties`.
- [ ] Reliability model: exposure-normalized rates, severity gradient, recency weighting, confidence labels (**F+05**).
- [ ] Copy audit: capacity never presented as spendable (**A+04**); no off-chain success ever credited (**F-01**).

### Phase 5 — dashboard
- [ ] Node list, channel list, node detail, LSP ranking, Faultline feed.

### Phase 6 — structural-authorization bond (was "dropped: roadmap only")
Un-dropped, and still last. Faultline is the sensor; the bond is the actuator. Deliberately gated behind a working, measured Faultline — a bond that slashes on events we cannot attribute confidently would be worse than no bond. Design first, deploy only after Phase 3 reports a join hit rate that justifies it.

---

## 5. Open questions

- **Mainnet.** Everything above is testnet. Mainnet has its own lock code hashes (`config/mainnet/config.yml`) and presumably far fewer force-closes. Is mainnet in scope, and does the answer change what we build?
- **Own-node channels.** Should Atlas's `fnn` open channels at all? It would give us `outbound_liquidity` for our own peers and let us test close/penalty paths end-to-end — at the cost of the §1.5 asymmetry and real funds. Currently assumed: **no**, observe-only.
- **CKB RPC dependency.** We rely on a public endpoint (`testnet.ckbapp.dev`) for both the Fiber node and the L1 scanner. Fine for now; a single point of failure for anything production.
- **Retention.** L1 history is unbounded and grows. Decide what the store keeps versus re-derives.

---

## 6. Definition of done (v0 release)

- Runs from a clean clone with documented steps, including standing up `fnn`.
- Serves the Atlas API and dashboard from real gossip data.
- Faultline detects and classifies all three event classes from real testnet L1 history, joined and attributed where derivable, with a **published join hit rate** and confidence labels.
- README states honest limits: no live balance (§1.5), no payment-success rate, force-close ≠ guilt, and the attribution-coverage bound from Phase 3.
- Spec versions match the `fnn` version actually run.

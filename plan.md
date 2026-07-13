# Build Plan — Fiber Atlas

Target: a demoable, judge-runnable submission for **Gone in 60ms** by **2026-07-15, 23:59 UTC**.
Written 2026-07-13 → effectively **~2.5 days**. Scope is cut to what ships, not what's ideal.

---

## Guiding cut

The submission spine is **Atlas visibility** (guaranteed shippable). **Faultline** is the differentiator and the ~day-2 stretch. The keyless structural-authorization bond is **documented roadmap only** — not built (deploying a keyless script safely cannot be done in this window, and rushing one contradicts the whole diligence premise).

| Bucket | Items |
|--------|-------|
| **Core (must ship)** | Gossip ingest → store → API → dashboard for nodes/channels/capacity/policy/liveness; LSP ranking view |
| **Stretch (if on track by mid-day 2)** | Faultline: L1 close/force-close/penalty detection, `channel_outpoint` join, reliability profiles |
| **Dropped** | Payment-failure attribution (data unavailable); routable-balance features (not broadcast); the SA bond (roadmap doc) |

If Faultline data proves unreachable in time, fall back to **liveness-only reliability** (staleness + disabled channels) — still Category 3, still honest.

---

## Stack (optimized for speed)

- **Language:** TypeScript end-to-end (fastest iteration in the window).
- **Fiber access:** JSON-RPC to a local **testnet** Fiber node synced to gossip (`graph_nodes`, `graph_channels`).
- **CKB L1 access (Faultline):** [CCC](https://github.com/ckb-devrel/ccc) (`@ckb-ccc/core`) or the CKB indexer RPC (`get_transactions` on funding outpoints / filtered by lock code hash).
- **Store:** SQLite (zero-ops, sufficient for one network's graph + events). Upsert by primary key.
- **API:** a thin HTTP layer (Fastify/Hono) serving the shapes in the specs.
- **Dashboard:** minimal single-page UI (Svelte or React + a table/graph lib). Function over polish — it must *show* something in a 2-minute demo.

Prereqs to confirm in hour 1: a reachable testnet Fiber node with gossip sync, and its RPC endpoint + chain hash.

---

## Milestones

### Day 0 (2026-07-13, remainder) — spine up
- [ ] Repo scaffolding, env config, testnet Fiber node RPC reachable.
- [ ] `graph_nodes` + `graph_channels` ingest loop → SQLite (upsert, pagination, `first_seen`/`last_seen`).
- [ ] Sanity: local node/channel counts match the node's own graph RPC (**A+01**).

### Day 1 (2026-07-14) — Atlas complete + Faultline started
- [ ] Derived signals: channel liveness buckets, `enabled` handling, node liveness/centrality, multi-asset coverage (**A+02/A+03**).
- [ ] API: `/nodes`, `/channels`, `/nodes/:id`, `/channels/:outpoint`, `/lsps`, `/health`.
- [ ] Dashboard: node list, channel list, node detail, LSP ranking. Capacity labeled as upper bound, never spendable (**A+04**).
- [ ] **Faultline start:** L1 watcher detects funding-cell spends at known `channel_outpoint`s; classify cooperative vs force-close (commitment-lock in outputs).

### Day 2 (2026-07-15, until freeze) — Faultline land + package
- [ ] Penalty detection: revocation-branch spend of `commitment-lock` (`unlock_count == 0x00`) (**F+03**).
- [ ] `channel_outpoint` join → attributed reliability profiles; embed Faultline summary in Atlas responses (**F+04**, **A+05**).
- [ ] Reliability model: exposure-normalized rates, severity gradient, recency weighting, confidence labels (**F+05**, **F-02**).
- [ ] Freeze early: README run instructions, `.env.example`, seed/screenshot data, 2-min demo recording.

**Hard stop: 2026-07-15, well before 23:59 UTC.** Reserve the last hours for packaging, not features.

---

## Demo script (what a judge sees)

1. Open the dashboard → the **live Fiber network**: N nodes, M channels, total capacity, asset coverage.
2. Sort nodes by LSP-fitness → the **`/lsps` ranking**: auto-accept, capacity, liveness.
3. Filter channels by liveness → **stale/disabled channels a router should skip** (the "gone in 60ms" tax, made visible).
4. Open a node with on-chain events → **Faultline**: its cooperative closes, force-closes, and any **penalty** (provable misbehavior), with attribution confidence.
5. One sentence on the roadmap: the same on-chain penalty feed is what a future **bonded LSP** would forfeit against — sensor today, actuator later.

Each step maps to a judging criterion: functional completeness, user flow, relevance to Fiber infra, usefulness to wallets/routers/merchants/operators, reusability (the API), and continued-development potential (the bond roadmap).

---

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Faultline L1 data not reachable in time | Ship liveness-only reliability; Faultline documented + partially wired |
| Penalty attribution to a specific `node_id` is heuristic | Label confidence; attribute to channel when node-level isn't derivable (**F-02**) |
| Sparse on-chain events on testnet (few real closes) | Seed a scripted force-close/penalty on testnet for the demo; note it as seeded |
| Scope creep into an "app on top of Fiber" (out of scope) | Stay a read-layer/API + dashboard; never hold funds or move value |
| Overbuilding the dashboard | Function over polish; the API is the reusable artifact judges care about |

---

## Definition of done (submission)

- Runs from a clean clone with documented steps against a testnet Fiber node.
- Serves the Atlas API and dashboard with real gossip data.
- Faultline detects at least cooperative + force-close, ideally penalty, joined and attributed — or a documented liveness-only fallback.
- README states honest limits (no live balance, no payment-success rate, force-close ≠ guilt).
- 2-minute demo recording + screenshots included.

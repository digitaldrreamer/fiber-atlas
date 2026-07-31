# SPEC-FAULTLINE: On-Chain Reliability Feed

Status: **Draft**
Version: **0.2.0**
Verified against: **fnn v0.8.1**, CKB testnet (2026-07-31)
Part of: [Fiber Atlas](../README.md)
Companion: [`SPEC-ATLAS.md`](./SPEC-ATLAS.md)

Faultline is the reliability half of Fiber Atlas. It converts a private, unverifiable question — *"is this node reliable?"* — into a public, cryptographically-grounded record by watching CKB L1 for channel closes and penalty spends and attributing them to nodes.

This is the differentiated contribution: Fiber and Lightning provide no public reliability feed. Faultline is buildable because the failures that matter leave an **on-chain footprint**, and that footprint can be joined back to the gossip graph.

---

## 1. The Core Idea

The gossip graph ([`SPEC-ATLAS.md`](./SPEC-ATLAS.md)) knows *which two nodes* a channel belongs to (`channel_outpoint → {node1, node2}`). CKB L1 knows *what happened to that channel*. The join key is the `channel_outpoint` — the funding cell's outpoint.

```
graph_channels.channel_outpoint  ═══ join ═══  spent funding cell on CKB L1
        │                                              │
   {node1, node2}                          { cooperative | force-close | penalty }
        └──────────────── attributed reliability record ─────────────────┘
```

Successes in a channel network are off-chain and invisible. **Failures that reach L1 are not.** Faultline is therefore a *failure registry*, and that asymmetry is a feature: on-chain events are unforgeable and cannot be wash-traded into a fake positive reputation.

---

## 2. On-Chain Event Model

A Fiber channel is opened by a funding transaction that creates a cell locked by `funding-lock` at `channel_outpoint`. The channel ends when that funding cell is spent. Faultline classifies the spend into a three-level gradient.

| Event | On-chain shape | Signal | Attribution |
|-------|----------------|--------|-------------|
| **Cooperative close** | Funding cell spent; outputs are plain payout cells, **no** `commitment-lock` | Neutral | The channel (`node1`, `node2`); no fault implied |
| **Force-close** | Funding cell spent; one or more outputs carry `commitment-lock` (delay/revocation structure) | Mild negative — unilateral close; often a peer that went offline | The channel; the *closing* side where distinguishable |
| **Penalty** | A `commitment-lock` cell is later spent via its **revocation branch** (`unlock_count == 0x00`, Schnorr sig over `revocation_pubkey_hash`) | Strong negative — a party broadcast a **revoked** state and was swept | The **penalized** party (the cheater) where identifiable; else the channel |

### 2.1 Script identities

Detection keys off two lock scripts. These code hashes are **network-specific** and are read from the `fiber.scripts` section of the fnn config actually being run — never hardcoded across networks.

| Script | CKB testnet `code_hash` (`hash_type: type`) |
|--------|---------------------------------------------|
| `FundingLock` | `0x6c67887fe201ee0c7853f1682c0b77c0e6214044c156c7558269390a8afa6d7c` |
| `CommitmentLock` | `0x740dee83f87c6f309824d8fd3fbdd3c8380ee6fc9acc90b1a748438afcdf81d8` |

Source: [`config/testnet/config.yml` @ v0.8.1](https://github.com/nervosnetwork/fiber/blob/v0.8.1/config/testnet/config.yml), which in turn references the [fiber-scripts testnet deployment migration](https://github.com/nervosnetwork/fiber-scripts/blob/main/deployment/testnet/migrations/2025-02-28-111246.json). Mainnet values live in `config/mainnet/config.yml` and **differ**; a scanner pointed at the wrong network's hashes silently returns nothing, which is indistinguishable from "no events." Treat an empty scan as a configuration failure until proven otherwise.

### 2.2 Detection primitives

- **Close detection:** watch for spends of cells at each known `channel_outpoint` (funding cells) — `get_transactions` on the funding outpoints, or a scan filtered by the `FundingLock` code hash.
- **Force-close detection:** inspect the closing transaction's outputs for the `CommitmentLock` code hash.
- **Penalty detection:** watch for spends of `CommitmentLock` cells whose unlock witness selects the revocation branch (`unlock_count == 0x00`). Fiber's `commitment-lock` uses this selector; see `nervosnetwork/fiber-scripts`.

### 2.3 Detection is independent of the gossip graph

**Scanning L1 by `CommitmentLock` code hash discovers force-closes network-wide without any Fiber node running.** The gossip graph is required to *attribute* an event to `{node1, node2}` (§3) — not to *find* it. This is why Faultline is not downstream of Atlas: the two ingest paths are independent, and joined afterward on `channel_outpoint`.

The practical consequence is that Faultline has a data source available immediately and in abundance. Verified against the public CKB testnet RPC (`https://testnet.ckbapp.dev/`, indexer enabled, no auth) on 2026-07-31: `get_cells` and `get_transactions` on both lock hashes each returned **more than 1000 results** — open channels, in-flight force-close outputs, and historical transactions alike, every query hitting the 1000-row page cap.

Two consequences worth stating plainly:

- There is **no need to seed synthetic force-closes** for testing or demonstration. Real events exist in volume.
- Any event whose `channel_outpoint` is absent from the graph is **quarantined, never discarded** (**F+04**).

Two independent populations are permanently unattributable to a node pair, and both are large:

1. **Channels closed before our node first synced gossip.** The gossip graph carries only *live* channels, so a channel that closed before we observed it was never in it. Historical backfill therefore attributes almost nothing.
2. **Private channels.** A Fiber channel is public only when `public_channel_info` is set (`is_public()`, `crates/fiber-lib/src/fiber/channel.rs`); private channels are never announced and never carry a `ChannelUpdate`. Measured on CKB testnet 2026-07-31: **925 gossip channels against 5,017 live funding cells — ~18% publicly announced.** No amount of observation time closes this gap. It is structural.

> **Normative.** Faultline MUST publish the join rate in **both directions**, because they answer different questions and only one of them bounds attribution:
> - `gossip → L1` — does every announced channel have a funding cell? Converges to ~100%; an integrity check on the join itself (**A+05**).
> - `L1 → gossip` — can a detected event be tied to a node pair? Bounded by the public/private ratio and by observation start. **This is the honest coverage figure.**
>
> Reporting only the first would overstate coverage by more than an order of magnitude. On testnet the two read 100.0% and 2.2% respectively.
>
> Neither is the coverage figure a consumer acts on. Both are ratios over the *channel* population; what matters is the share of **events** that name a node pair, which is lower again — 0.39% across the full backfill. See §3.1.

Detection coverage is unaffected: every close and penalty is found on L1 regardless of whether the channel was public. The limit is attribution, not detection — an unattributed penalty is still a real, verifiable, on-chain event.

---

## 3. Attribution and Its Confidence

Attribution quality differs by event and MUST be labeled:

- **Channel-level (high confidence):** a close is attributable to the pair `{node1, node2}` via the `channel_outpoint` join **when the channel is in the gossip graph**. This is *not* always available — see §2.3. It requires the channel to be public and to have been observed while open; on testnet that is a minority of channels. When the join misses, the event is retained as `unattributed` rather than dropped, and MUST NOT be quietly excluded from counts.
- **Side-level for force-close (medium):** which of the two nodes broadcast the commitment can sometimes be inferred from the commitment output structure / which delayed branch is present. Report only when derivable; otherwise attribute to the channel.
- **Cheater-level for penalty (medium):** the penalized party is whoever's revoked commitment was swept. The `commitment-lock` args carry per-channel derived key hashes (`local_delay_pubkey_hash`, `revocation_pubkey_hash`), **not** the node's gossip `pubkey` directly, so mapping the swept party to a specific `pubkey` is a best-effort heuristic (e.g. correlating with the funding parties and channel role). Report a confidence level with every penalty attribution.

> Normative: Faultline MUST NOT present a heuristic attribution as certain. Each record carries an attribution level and the evidence used.

### 3.1 Attribution is derived, never stored

The level is computed at read time (`event_attributed`, `src/db.ts`), on three values:

| Level | Meaning | Supports a per-node claim? |
|-------|---------|---------------------------|
| `node_pair` | Outpoint known **and** the channel is in the gossip graph | Yes — this is the published coverage figure |
| `channel` | Outpoint known, channel absent from gossip | No. A real, verifiable event that names no node |
| `unattributed` | No outpoint at all | No. Quarantined, never dropped (**F+04**) |

Two mistakes are ruled out by construction:

1. **Knowing the channel is not knowing the nodes.** An implementation that grades on `channel_outpoint IS NOT NULL` reports channel identification as attribution. Measured on testnet, that reads 70% where the honest figure is **0.39%** — a 175× overstatement of exactly the kind §2.3 forbids.
2. **Attribution cannot be frozen at insert.** Gossip membership is not fixed: a channel absent today becomes attributable the moment it is observed while still open. A stored value can only decay away from the truth, so the level MUST be derived on read.

Consequently the published coverage figure **rises with observation time and starts near zero.** It is a property of how long Faultline has been watching, not of the backfill's size — which is why a complete 8.6M-block history still yields 0.39%.

---

## 4. Credibility Model

Faultline serves **weighted evidence, not verdicts.** The weighting is deliberately asymmetric and non-gameable:

1. **Failures are hard; successes are not counted.** There is no on-chain "successful payment" event, and any off-chain success claim is unverifiable and wash-tradeable. Faultline never credits successes. Absence of failure over time and volume is the only positive signal, and it is implicit.
2. **Severity gradient:** `penalty` ≫ `force-close` > `cooperative close (neutral)`. A penalty is provable protocol misbehavior; a force-close is a unilateral exit that may be innocent; a cooperative close is normal.
3. **Normalize by exposure:** a node with 500 channels will accumulate more raw events than one with 5. Report rates (events per channel, per unit capacity, per unit time), not just counts.
4. **Recency:** weight recent events above old ones; a node that misbehaved a year ago and has been clean since is different from one misbehaving now.
5. **Not-guilt disclaimer is normative:** a force-close is *evidence*, not proof of unreliability. UI and API copy MUST frame force-closes as a signal a consumer weighs, not a conviction.

The output is a per-node reliability profile: counts and rates per event class, attribution confidences, and a recency-weighted summary — with the raw events always available so consumers can apply their own weighting.

### 4.1 Why recency weighting is not optional — measured

Rule 4 above is normally argued on principle. On Fiber testnet it is forced by the data: **the aggregate force-close rate is not a property of the protocol, it is an artifact of one era.**

Full L1 backfill of the `FundingLock` script, blocks 13,307,533 – 21,925,528 (2024-05-20 → 2026-07-31), 44,133 channels, 39,116 closes:

| Block era | Dates | Closes | Force-close |
|-----------|-------|--------|-------------|
| 13M – 17M | 2024-05 → 2025-08 | 1,760 | 6 – 17% |
| **18M** | 2025-08 → 2025-10 | 11,372 | **33.0%** |
| **19M** | 2025-10 → 2026-01 | 19,539 | **63.9%** |
| 20M | 2026-01 → 2026-04 | 4,797 | 0.5% |
| 21M | 2026-04 → 2026-07 | 1,648 | 2.1% |

Testnet sustained an elevated force-close regime for roughly **five and a half months (2025-08-06 → 2026-01-24)**, peaking at 92% in the 19.4M block window, then returning to a 0.5–2% baseline. Penalties track the same curve and then stop: 1,392 in the 18M era, 405 in 19M, ~0 since.

The consequences are normative:

- **The lifetime aggregate is misleading.** "42% of Fiber channels force-close" is arithmetically true over all history and describes no period anyone is operating in. A feed that reports lifetime rates would permanently condemn every node that was online in late 2025.
- **A reliability score MUST be windowed,** and the window MUST be stated with the figure. Faultline reports rates per era, never a single lifetime number.
- **Regime changes are themselves the signal.** The most useful output here is not any node's score but the fact that a network-wide failure regime began, persisted, and ended — visible only because the events are on-chain and the history is complete.

> Attribution note: essentially none of the 18M–19M events carry a node pair, since those channels closed years before any observer synced gossip (§2.3). The era finding is a **detection** result, and detection is complete regardless of attribution. This is the clearest demonstration that the two capabilities are worth separating.

Provenance: `src/bin/stats.ts` over `data/fiber-atlas.testnet.db`, funding scan complete. Penalty counts were taken while the `CommitmentLock` scan was still in progress and are lower bounds; the era *shape* is stable but absolute penalty totals will rise.

---

## 5. Why This Is the Only Honest Reliability Source

Considered and rejected as network-wide signals:

- **Payment failures** (`send_payment`/`get_payment` → `failed_error`): local to your own node and carry **no per-hop attribution**. Cannot build a global "node X fails Y%" from them.
- **Your own channel states** (`list_channels`): your node's channels only, not the network's.
- **Off-chain reputation attestations:** forgeable, wash-tradeable, and reintroduce a trusted attester — the exact problem this avoids.

On-chain closes and penalties are the one signal that is (a) network-wide observable, (b) unforgeable, and (c) attributable via the gossip join. That is why Faultline is on-chain-only.

---

## 6. API Surface (v0)

```
GET /faultline/nodes/:pubkey      → { cooperative, force_closes, penalties,
                                       rates, recency_weighted_score,
                                       attribution_confidence_breakdown }
GET /faultline/channels/:outpoint → close event + classification + attribution + evidence
GET /faultline/events             → chronological feed, filter by class/node/asset
GET /faultline/penalties          → penalty-only feed (the strongest signal), with confidence
```

Faultline summaries are also embedded in Atlas node/channel responses ([`SPEC-ATLAS.md`](./SPEC-ATLAS.md) §6) so one call answers "who and how trustworthy."

---

## 7. Relationship to a Future Bonded-LSP Layer

Faultline is the **sensor**. A later structural-authorization LSP bond — an open-locked cell that forfeits staked capacity when its owner is penalized on-chain — is the **actuator**. The bond forfeits on precisely the penalty events Faultline already detects. You cannot slash on failure data you cannot observe; Faultline is that observation layer, and it stands on its own without the bond.

This layering (sensor before actuator) is intentional. The bond is out of scope for this repo's initial build (keyless script deployment demands a diligence bar a hackathon window cannot meet); Faultline delivers standalone value now and de-risks the bond later.

---

## 8. Test / Acceptance

- **F+01** A cooperative close on testnet is detected and classified neutral, attributed to `{node1, node2}`.
- **F+02** A force-close (commitment-lock in outputs) is detected and classified force-close.
- **F+03** A penalty (revocation-branch spend of a commitment-lock) is detected and classified penalty, with an attribution confidence.
- **F+04** Every event joins to a `channel_outpoint` present in the Atlas graph; unjoinable events are quarantined, not silently dropped.
- **F+05** Counts are reported as exposure-normalized rates, never as raw counts alone.
- **F-01** No off-chain success is ever credited as positive reputation.
- **F-02** No heuristic attribution is presented without its confidence label.

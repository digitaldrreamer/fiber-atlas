# SPEC-FAULTLINE: On-Chain Reliability Feed

Status: **Draft**
Version: **0.1.0**
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

Detection primitives:

- **Close detection:** watch for spends of cells at each known `channel_outpoint` (funding cells). A CKB indexer / `get_transactions` on the funding outpoints, or a scan filtered by the `funding-lock` code hash.
- **Force-close detection:** inspect the closing transaction's outputs for the `commitment-lock` code hash.
- **Penalty detection:** watch for spends of `commitment-lock` cells whose unlock witness selects the revocation branch (`unlock_count == 0x00`). Fiber's `commitment-lock` uses this selector; see `nervosnetwork/fiber-scripts`.

---

## 3. Attribution and Its Confidence

Attribution quality differs by event and MUST be labeled:

- **Channel-level (high confidence):** every close is attributable to the pair `{node1, node2}` via the `channel_outpoint` join. Always available.
- **Side-level for force-close (medium):** which of the two nodes broadcast the commitment can sometimes be inferred from the commitment output structure / which delayed branch is present. Report only when derivable; otherwise attribute to the channel.
- **Cheater-level for penalty (medium):** the penalized party is whoever's revoked commitment was swept. The `commitment-lock` args carry per-channel derived key hashes (`local_delay_pubkey_hash`, `revocation_pubkey_hash`), **not** the node's gossip `node_id` directly, so mapping the swept party to a specific `node_id` is a best-effort heuristic (e.g. correlating with the funding parties and channel role). Report a confidence level with every penalty attribution.

> Normative: Faultline MUST NOT present a heuristic attribution as certain. Each record carries `attribution_confidence ∈ {channel, side, node}` and the evidence used.

---

## 4. Credibility Model

Faultline serves **weighted evidence, not verdicts.** The weighting is deliberately asymmetric and non-gameable:

1. **Failures are hard; successes are not counted.** There is no on-chain "successful payment" event, and any off-chain success claim is unverifiable and wash-tradeable. Faultline never credits successes. Absence of failure over time and volume is the only positive signal, and it is implicit.
2. **Severity gradient:** `penalty` ≫ `force-close` > `cooperative close (neutral)`. A penalty is provable protocol misbehavior; a force-close is a unilateral exit that may be innocent; a cooperative close is normal.
3. **Normalize by exposure:** a node with 500 channels will accumulate more raw events than one with 5. Report rates (events per channel, per unit capacity, per unit time), not just counts.
4. **Recency:** weight recent events above old ones; a node that misbehaved a year ago and has been clean since is different from one misbehaving now.
5. **Not-guilt disclaimer is normative:** a force-close is *evidence*, not proof of unreliability. UI and API copy MUST frame force-closes as a signal a consumer weighs, not a conviction.

The output is a per-node reliability profile: counts and rates per event class, attribution confidences, and a recency-weighted summary — with the raw events always available so consumers can apply their own weighting.

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
GET /faultline/nodes/:node_id     → { cooperative, force_closes, penalties,
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

# SPEC-FRONTEND — Design brief

**Status:** brief, not a blueprint. Everything in §1–§5 is fixed because it describes the audience, the data, or a claim the product must not make. Everything in §6 is yours.

**API:** `https://fiber-atlas.drreamer.digital` · all figures below pulled live, 2026-07-31.

---

## 1. What this is

Fiber Atlas is a public read-layer for the [Fiber Network](https://github.com/nervosnetwork/fiber), a payment-channel network on CKB. It answers one question that the protocol itself refuses to answer:

> **Who else is on this network, and can I rely on them?**

It observes. It never holds funds, never moves value, never acts on the network. It has two halves, and the difference between them drives most of the design:

| | **Faultline** — on-chain | **Atlas** — gossip |
|---|---|---|
| Source | Complete CKB L1 history | One observing node's live view |
| Answers | What already happened | What is true right now |
| Coverage | Total, verifiable, unforgeable | Partial, self-reported, current |
| Volume | Large (94k events) | Small (67 nodes) |
| Weakness | Says almost nothing about *who* | Says nothing about *reliability* |

A user must never be confused about which half they are reading. That is the single most important thing this interface does.

---

## 2. Audience

Four groups, in priority order. All four are asking about **other people's nodes**, never their own — this is not a node cockpit.

**1. Someone choosing a node to open a channel with** (wallet users, merchants, anyone needing inbound liquidity). The largest group and the least expert. They arrive asking "is this counterparty safe?" and they will accept whatever answer the page implies — including an answer we do not have. Designing for this person is mostly about designing what *not* to let them conclude.

**2. Node operators** benchmarking themselves against the network — what fee is everyone charging, what version is everyone on, where is everyone hosted, is my channel showing as stale to others.

**3. Wallet and routing developers** who will consume the API and want the UI as a reference implementation and a debugging surface. They read JSON. Make it easy to get from any view to the endpoint behind it.

**4. Ecosystem observers** — researchers, the CKB community, anyone asking how healthy Fiber is. They want the network-level charts and they will screenshot them. Assume every aggregate figure will be quoted out of context, and label accordingly.

---

## 3. The data

### 3.1 Two networks, and they are not comparable

Both are served. The user picks one; the interface shows one at a time. **Never side by side** — the whole point is that these figures do not travel between networks.

| | testnet | mainnet |
|---|---|---|
| Channels ever | 44,153 | 247 |
| Open now | 5,027 | 35 |
| Announced in gossip | 717 | 17 |
| Nodes | 67 | 6 |
| On-chain events | 93,331 | 220 |
| Cooperative closes | 22,643 | 206 |
| Force closes | 16,483 | **6** |
| Penalties | 3,595 | **0** |

Testnet is a large, chaotic dataset. Mainnet is a **six-node network** with a clean record. These need to feel like the same product without pretending they are the same size — a layout that looks right with 44,153 rows and empty with 6 has failed.

### 3.2 The attribution problem — read this twice

An on-chain event can be tied to a *channel* easily, but to the *nodes* in that channel only if that channel was visible in gossip while it was open. Almost none were.

- testnet: **252 of 93,331 events (0.27%)** name a node pair.
- mainnet: **0 of 220. Zero.**

**Consequence: there is no per-node reliability score, and there cannot be one.** A node page cannot say "0 force closes" — the API returns `observed: false` with `counts: null` precisely so the UI cannot render a zero. The correct display is a stated absence with the reason, and it must not look like a pass. A green tick here would be a lie told to person #1 in §2.

Every event carries `attribution` ∈ `node_pair` | `channel` | `unattributed`. This label travels with the data everywhere it appears.

### 3.3 What each surface has

**Network summary** — `/v0/{network}/summary`
Channel totals, close breakdown, penalty count, gossip node/channel counts, attribution coverage, block-time coverage. Includes a lifetime force-close rate that is **explicitly marked unusable** (see §4.2).

**Reliability over time** — `/v0/{network}/eras`
Closes bucketed by 1M-block windows, each with real header timestamps, force-close counts, penalty counts, and a rate that is `null` when the bucket has under 30 samples. Testnet's story is a failure era peaking at **63.9%** (2025-10-31 → 2026-02-02) collapsing to **0.5%** afterwards. Mainnet has 4 buckets, two of them below the sample floor.

**Force-close resolution** — `/v0/{network}/faultline/timing`
How long funds are locked after a channel fails. Complete, derived from L1 alone. Penalties: 2.6h median, 16h p95, 110h max. Settlements: 4.0h median, 96h p95, **470h max**. Plus 4,982 commitment cells never seen spent, oldest from 2024-10-12. This is the most useful thing in the dataset and the only major metric that is *complete* rather than sampled.

**Event feed** — `/v0/{network}/faultline/events`
Every close, penalty and settlement, chronological, dated, cursor-paginated, filterable by kind. Each row: kind, block, timestamp, tx hash, channel, attribution.

**Nodes** — `/v0/{network}/nodes`, `/nodes/{pubkey}`, `/lsps`
Pubkey, name (**often empty**), version, addresses, auto-accept threshold, first/last seen, open channel count, announced capacity, live fee policy, location. `/lsps` ranks candidates on auto-accept + capacity + liveness, and states in the response that it deliberately omits the reliability term the spec calls for.

**Channels** — `/v0/{network}/channels`, `/channels/{outpoint}`, `/channels/{outpoint}/updates`
Outpoint, both node pubkeys, capacity, dated open and close, close kind, and per-direction routing policy: enabled flag, fee rate, TLC minimum, TLC expiry delta, announcement time.

**Distributions** — `/v0/{network}/distribution`
Percentiles for open-channel capacity (median 499 CKB), announced fee rate (**almost every node sits on the 1000 default**), and closed-channel lifetime (median 5.3 days, max 321 days).

**Liveness** — `/v0/{network}/liveness`
Announcement staleness in age buckets. Currently: 1,855 directions, 1,773 enabled, 82 disabled, **348 not re-announced in over 7 days**. Node last-seen ages. This is the closest thing to a routing-health signal that exists.

**Location** — `/v0/{network}/geo`
Country and hosting provider per node, from addresses nodes broadcast themselves. Testnet: 23 Hong Kong, 20 Singapore, 8 US, 2 Nigeria, and one each in NL/ZA/DE. **Mainnet: all 6 nodes on Amazon.** Coverage is reported explicitly — 13 testnet nodes announce only private addresses and have no location to find.

**Health** — `/health`
Scan cursors, gossip freshness, block-time completeness. Whether the data being displayed is still being backfilled.

### 3.4 Shapes worth designing around

- **Names are usually absent.** Most nodes announce an empty `node_name`. The primary identifier is a 66-character hex pubkey. This is a real typographic problem, not an edge case.
- **Two testnet nodes hold 544 and 543 channels**; the next holds 29. It is a test harness and it distorts every ranking. Rankings need to survive it.
- **Fee rates are nearly constant.** Almost every node is on the default. A fee comparison view will be a flat line — that *is* the finding.
- **Mainnet has zero of several things.** Zero penalties, zero attributed events. Empty states are the normal case, and they carry meaning: "0 penalties in 17 months of complete history" is the strongest positive claim the project can make. An empty state here should read as an achievement, not as a missing feature.
- **Timestamps can be null.** A block whose header has not been fetched has no date. Coverage is currently 100% but will dip whenever a scan runs ahead of the block-time pass. Dates must degrade to "unknown", never to a guess.

---

## 4. Rules that are not negotiable

These are constraints on **meaning**, not on visual design. They exist because this project's only asset is that its numbers can be trusted. Every one of them corresponds to a mistake already made and caught.

**4.1 Nothing appears without its network.** Any figure that can be screenshotted must carry its network label in the same visual unit. Testnet's force-close rate is 42%; mainnet's is 2.8%. One quoted as the other is the failure mode this whole project is shaped to avoid.

**4.2 Never show a lifetime reliability rate as a usable number.** The API serves one, flagged. Show it struck through, greyed, footnoted — whatever reads as "this exists and you must not use it" — and route the user to the era view. Hiding it entirely is worse: someone will compute it themselves.

**4.3 Absence of data must never render as absence of failure.** Where the API says `observed: false`, the UI says so. No zero, no green tick, no empty progress bar at 0%. The supplied `no_data_reason` text exists for this.

**4.4 "Unknown" and "disabled" are different.** A channel direction with no gossip row is unknown; one with `enabled: false` is positively down. Three states, always: enabled / disabled / unknown.

**4.5 Capacity is not balance.** Fiber does not broadcast channel balances. Capacity is an upper bound on what a channel *could* carry, not what it can carry now. Never label it "liquidity", "available", or "funds". (The incumbent explorer shows per-side balances it cannot actually know — do not copy this.)

**4.6 Small samples do not get a rate.** Where the API returns a `null` rate with a `rate_suppressed_reason`, the chart must not draw a bar as though it were comparable. Show the counts; withhold the ratio.

**4.7 Every derived ratio shows its numerator and denominator.** A bare percentage will be quoted; the fraction beside it prevents the quote from being wrong.

**4.8 Staleness is measured from our observation.** Anything time-sensitive needs the "as of" moment visible, and a way to tell a stale *network* from a stale *observer*.

---

## 5. Deliberately absent

Not a roadmap — these are either impossible or actively harmful.

- **Channel balances / routable liquidity.** Not broadcast by Fiber for third-party channels. Impossible, not pending.
- **Base fee and maximum HTLC.** No Fiber equivalent exists; only fee rate and TLC minimum.
- **Payment success rates.** Visible only to a node's own operator, with no per-hop attribution.
- **Per-node reliability scores or rankings.** See §3.2.
- **A network topology graph.** Six nodes on mainnet; on testnet the harness pair dominates every layout. It would look impressive and inform nobody. If a compelling use emerges, argue for it — but the burden is on the graph.

---

## 6. Yours

Everything above is *what is true*. How it is presented is open, including:

- Navigation, information architecture, and how the network switch works
- Page composition, hierarchy, and what earns the top of a screen
- Visual language: type, colour, density, motion, whether it feels like an explorer, a terminal, a report, or something else
- Chart selection and interaction, within §4.6
- How a 66-character hex identifier is made livable
- How the two halves — settled history and live gossip — are made distinguishable at a glance. §1 says they must be. It does not say how, and this is the most interesting problem in the brief.
- Empty and loading states, which are the *common* case on mainnet
- Whether some of §3.3 belongs on the same page, a different page, or no page at all

**Two things worth aiming at.** First: the strongest single fact in the dataset is *"if a Fiber channel force-closes, here is how long your funds are actually locked"* — complete, verifiable, and published nowhere else. Second: this interface's real job is to be **legibly honest**. Most of §4 is about refusing to imply things. A design that makes uncertainty feel like a considered answer rather than a missing feature is the one that succeeds.

Push back on anything here that fights the design. Sections 1–5 are load-bearing, but they are claims about data, and claims can be re-examined.

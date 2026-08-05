# Methodology

This document exists because the point of this project is that its
classification logic is auditable by people who do not trust it. If a
check here can't be explained well enough for a skeptical third party to
reproduce it from the committed JSON alone, the check isn't done yet.

## Why this exists

Robinhood Chain (Arbitrum-based L2, public mainnet since 2026-07-01) has a
documented problem with malicious ERC20 contracts that drain buyers after
purchase, typically via concealed privileged logic in `transferFrom` that
bypasses the allowance check. Third-party bridges currently hand-curate a
safe list — not scalable, not auditable, not fast.

Separately, and just as damaging: legitimate fee-on-transfer (FOT) tokens
get flagged and blocked by the same heuristics that catch drainers, because
naive scanners can't tell a declared, capped, immutable fee apart from
concealed drainer logic. Data providers compound this by mishandling tokens
whose `totalSupply` decreases via burn — caching genesis supply instead of
reading current chain state, which silently corrupts every market cap/FDV
figure downstream. This is not hypothetical: see the live example below.

## Hard constraints (why the architecture looks like this)

- **No backend, no database, no server-side rendering.** Everything reads
  from public RPC and Blockscout directly in the browser, or from a
  scheduled GitHub Action. A hosted competitor on this chain collapsed
  under a spam flood of 60,000 tokens — this suite has no server to
  overwhelm, and the developer has intermittent access to his own machine,
  so nothing here can depend on a long-running process he has to keep
  alive.
- **Static hosting only**, deployed from a git push with no local build
  step.
- **No custody, no fee collection, no token gating, no wallet-connect**
  beyond an optional read of the viewer's own balance. This tooling holds
  nothing and charges nothing.
- **Read-only against chain state.** Nothing in this suite signs or
  broadcasts a transaction — the scanner's dynamic checks use `eth_call`
  simulation exclusively.
- **Vanilla JS / minimal tooling**, must run on a phone browser.

## Deliverable 2: supply conformance checker (built, live)

### Genesis supply
Read from the deployment transaction's logs specifically, not a chain-wide
scan, when `config/tokens/<name>.json` pins a `deploymentTxHash`: sum every
`Transfer(from=0x0, ...)` event in that one transaction's receipt. A token
can mint to more than one address at construction — TACO itself does this
(founder cut + LP allocation as two separate `Transfer(0x0, ...)` events in
one tx) — so summing all zero-origin transfers in the tx, not assuming
exactly one, matters for correctness on other tokens too.

If no `deploymentTxHash` is configured, falls back to a full chunked
`eth_getLogs` scan from block 0 (or a configured `deploymentBlock`) for the
first `Transfer(from=0x0, ...)` event — slower, but this checker is meant
to work for "a given token," not only for TACO.

### Burn verification — two independent paths, must agree
1. **By difference:** `genesisSupply - currentSupply` (current read fresh
   via `eth_call totalSupply()` every run).
2. **By log sum:** cumulative sum of every `Transfer(..., to=<burn
   address>, ...)` event across the token's full history, where burn
   addresses are `config/tokens/<name>.json`'s `burnAddresses` array
   (defaults to the zero address and the common `0x...dEaD` convention —
   TACO only ever uses the zero address, per its contract source, but the
   checker doesn't assume that for other tokens).

These two numbers come from genuinely different data (a single storage
read vs. a full event-log history) and are asserted equal. **Confirmed
live** on TACO: both methods agree to the wei (340,016,724.581936...
TACO burned, at time of writing) — this is not a rounding-tolerant
"close enough" check, it's exact BigInt equality. A mismatch would mean
either the configured `burnAddresses` is missing a real burn destination,
or the token has a non-`Transfer` supply-change path (rebase, hidden mint)
this checker doesn't model — either way, a real finding worth surfacing
loudly, not silently averaging away.

The log scan is **incremental**: `supply/state/<token>.json` checkpoints
the last block scanned plus the cumulative burned total, so only new
blocks since the last run get scanned. The checkpoint only ever advances
to the last gap-free block a chunk actually completed — if an
`eth_getLogs` chunk fails mid-scan, the checkpoint freezes before the gap
rather than silently skipping it, and the next run re-covers that range.

### External source comparison
Each external provider is an independent adapter (`supply/sources.mjs`)
that must never throw — an unreachable or unexpectedly-shaped response
becomes one row with `error` set, never crashes the whole run. Current
adapters:

| Source | What it reports | Known failure mode |
|---|---|---|
| Blockscout | `total_supply` (raw base units) | independent indexer, but still just re-derives from chain state — agreement here is a genuine cross-check, not circular, since it's different software on a different sync path than this checker's own `eth_call` |
| GeckoTerminal | `normalized_total_supply` | **confirmed live, 2026-08:** reports TACO's genesis supply (1,000,000,000) unconditionally, not current state — a **+51.5% overstatement** of supply and everything derived from it (market cap, FDV) at time of writing. This is the exact documented failure mode this project exists to catch, reproduced live against the reference fixture, not a hypothetical. |
| DexScreener | no raw supply field — this adapter backs one out as `marketCap / priceUsd`, explicitly labeled `dexscreener (implied)` in output, never presented as a number DexScreener itself stated | inherits DexScreener's own `priceUsd` display-precision rounding (small, single-digit-percent-of-a-percent scale, confirmed live to land within +0.01% for TACO) |

A source is flagged `capFdvWrong: true` when `|percentDelta| > 0.01%` —
chosen to separate real drift from harmless last-digit float rounding, not
as a claim that anything under that threshold is guaranteed correct.

### Reference fixture: why TACO
1B fixed genesis supply, 18 decimals, 4% burn-on-sell only (buys and
wallet transfers untaxed), rate is a Solidity `constant` with no setter,
ownership renounced to the zero address, LP burned. Immutable — nothing
about its behavior can change post-launch, which is exactly what makes it
a stable, reusable test fixture rather than a moving target. Contract:
`0x9e5e02F5C9ea48931d4e8f488089103e93F925fF`. Its own self-audit
(`AUDIT.md` in the `taco-burn` repo) documents the accepted tradeoffs of
that design (sells through an unregistered second pool would escape the
tax; LP adds to the registered pair are taxed like sells) — neither
affects this checker's correctness, both are disclosed-by-design, not
concealed.

## Deliverable 3: generic token dashboard (built, live)

Ported from the existing TACO-hardcoded `taco-burn/dist/stats.html` into a
single `config.json`-driven template (`dashboard/index.html` + `app.js`).
Same price/reserves/holder/24h-flow logic, parameterized. Caught a real bug
before shipping by executing the ported logic against live RPC rather than
trusting a static port: the natural first-draft config pointed `stablePool`
at the stablecoin's own token address instead of the actual Uniswap V2 pair
address, which reverts on every `eth_call` since a plain ERC20 doesn't
implement pair functions. See `dashboard/README.md` for the full account
and the fix.

## Deliverable 4: chain infrastructure QA monitor (mostly built, live)

Same scheduled-Action + committed-history pattern as Deliverable 2. Three
checks are live against real endpoints: RPC latency (`eth_blockNumber`
round-trip), Blockscout indexing lag (head block vs. `/api/v2/blocks`'
latest item), and verified-source coverage. That last one is reported as
an **all-time** figure, not "recently deployed" as the original brief
phrased it — confirmed live that Blockscout's `new_verified_smart_
contracts_24h` counter tracks verification *events* in the last 24h for
contracts of any age, not verifications of contracts deployed in that
window, so it can't be combined with `new_smart_contracts_24h` to derive
that more specific figure without per-contract creation-block lookups
(not implemented — expensive at this chain's deployment rate). See
`chainqa/README.md` for the full account.

The router compatibility matrix is explicitly NOT implemented: it needs
known router/aggregator addresses on this chain to test against, and none
were found in this repo's own deploy history (TACO's LP was added by
calling the pair contract directly, not through a router). Every committed
snapshot says so plainly (`routerCompatibility: {implemented: false,
reason: ...}`) rather than omitting the field silently or faking a result.

## Deliverable 1: FOT taxonomy scanner (built, validated against one fixture)

Classifies a token `clean` / `declared_fot` / `suspect` from static
source-text heuristics plus `eth_call`-only dynamic simulation. Every
check runs live against TACO and matches ground truth after fixing two
real bugs caught by testing against the actual contract source rather
than trusting the regex by inspection — see `scanner/README.md` for both
(a paren-truncation bug in the allowance-bypass check, and a
negation-blindness bug in the asymmetric-buy-sell check that initially
reported TACO's sell-only fee as applying to both directions).

Dynamic simulation impersonates real on-chain addresses (the pool, a real
top holder) via `eth_call`'s `from` field — no signature, no state
override, since a genuinely-funded real address makes the simulated
transfer succeed or fail on the contract's actual logic. A real
investigation went into computing exact "received amount" deltas (an
atomic probe-contract technique, compiled and tested live via `forge`/
`cast`) before concluding it fundamentally breaks `transfer()`'s
`msg.sender`-based auth model — see `scanner/README.md`'s "Known
limitation" section for the full technical account. What ships instead is
SUCCESS/REVERT detection, which is what actually answers "is this a
honeypot," the project's core concern.

Router compatibility discovered a real, useful fact about this chain
along the way: none of six verified router contracts found via Blockscout
search share TACO's own pool factory, so this chain's DEX liquidity is
fragmented across incompatible deployments — not a token-side FOT problem,
a chain-infrastructure one (see `chainqa/README.md`'s router-matrix note,
which independently hit the same wall).

**What's still missing:** a genuine `suspect` fixture. Every check is
validated on a known-good token; none has been validated against a real
drainer, because fabricating one would validate nothing real. See
`scanner/README.md`'s Fixtures section.

## Non-goals

No token launch functionality. No bonding curve, no factory, no liquidity
provisioning, no trade routing, no custody of user funds. No platform
token, no fee share, no staking, no revenue mechanism of any kind. No
ranking, trending, or featured list of tokens. This suite reads and
reports. It does not launch, trade, or promote.

## License
MIT — see `../LICENSE`.

# FOT taxonomy scanner — Deliverable 1 (built, validated against one fixture)

Classifies an ERC20 as `clean`, `declared_fot`, or `suspect`. Run:
`node scanner/scan.mjs [token-config-name]` (default: `taco`) — writes
`scanner/results/<token>.json`, rendered at `scanner/index.html`.

**Honest status:** every check below is real and tested live against
TACO (a known-good declared-FOT fixture), and the classifier correctly
returns `declared_fot`. But TACO is the *only* fixture available — a
genuine `suspect` contract is still needed to validate the other
direction (does this actually catch a real drainer, not just correctly
pass a clean token). See "Known limitation" and "Fixtures" below.

## Static checks (`static.mjs`)
Fetches verified source from Blockscout (`/api/v2/smart-contracts/
{address}`) and runs **regex/text heuristics** against it — not a full
Solidity AST parse. That tradeoff is real: it will misfire on contracts
whose style differs meaningfully from TACO's straightforward single-file
implementation (heavy inheritance, multi-file imports, unusual formatting
inside a function signature). Every check's evidence includes the matched
source text and line number specifically so a human can verify a finding
by eye rather than trust the regex blindly.

Two real bugs were caught by testing against TACO's actual source rather
than trusting the regex by inspection alone, both still in the code as
comments explaining the fix:
- `allowance_bypass` initially false-flagged TACO's completely standard
  infinite-approval idiom (`if (a != type(uint256).max)`) as a suspicious
  bypass, because a naive `[^)]+` regex for "the if-condition's text"
  truncates at the FIRST `)` — and `type(uint256).max` contains its own
  `)`. Fixed with a proper paren-depth-matched extractor
  (`extractIfConditions`), the same technique `extractFunctionBody`
  already used for brace matching.
- `asymmetric_buy_sell` initially reported TACO's fee as applying to
  *both* buy and sell, when it's actually sell-only by design
  (`isPair[to] && !isPair[f]`). A naive regex matched `isPair[f]` as "the
  buy-side check exists" without noticing it's *negated* — `!isPair[f]`
  is an exclusion ("only tax if sender is NOT a pair"), not a positive
  buy-side trigger. A regex negative-lookbehind doesn't fix this cleanly
  (variable-length `\w*` lets the engine start matching partway through
  an identifier, sidestepping the lookbehind) — fixed by manually walking
  backward from each match's index to check for `!`, rather than asking
  the regex to encode the negation.

If source isn't verified, every check returns `result: null` with an
explicit "not verified" note — never a fabricated "clean" for something
this v1 literally can't examine (no bytecode-only fallback implemented).

## Dynamic checks (`dynamic.mjs`)
Nothing here broadcasts a transaction (hard constraint #4). Buy/sell/
wallet-transfer simulation uses `eth_call` with an impersonated `from` —
JSON-RPC's `eth_call` needs no signature at all (it's a read-only,
non-persisted execution), and impersonating a REAL address that already
holds the token on-chain right now (the pool, or a top holder found via
Blockscout) means the simulated transfer genuinely succeeds or fails based
on the contract's real logic, with zero synthetic setup. Confirmed live
against TACO: buy, sell, wallet-transfer, and sell-from-an-existing-holder
all succeed cleanly (no honeypot behavior).

**Router compatibility** tests `getAmountsOut` (a pure view/quote
function, needs no allowance) against a fixed list of verified router
addresses (`config/chains/robinhood.json`'s `routerCandidates`, found via
Blockscout's contract search 2026-08-05 — real, verified, on-chain
addresses). Confirmed live: **all six candidates fail** for TACO, because
none of them share TACO's own pool factory (`uniswapV2Factory`) — this
chain's DEX liquidity is fragmented across multiple incompatible Uniswap
V2 factory deployments, and a router bound to factory A simply cannot
address a pool created by factory B. That's a real, useful finding about
this chain's infrastructure, not a bug in the check or a token-side FOT
problem — don't misread "0/6 routers compatible" as "TACO's tax breaks
routers."

## Known limitation: no exact "received amount" delta
The project brief asks for "actual received amount versus expected" per
simulated trade. A real investigation went into this rather than skipping
it quietly:

Plain `eth_call` cannot observe the resulting state of its own
(non-persisted) execution beyond the called function's return value —
`transfer()`/`transferFrom()` return only `bool`, not the delivered
amount. Two escape hatches were tried:

1. **Atomic probe contract**, injected via `eth_call`'s
   `stateOverride.code` at a scratch address: a tiny generic Solidity
   helper (`token.balanceOf(recipient)` → sub-call the transfer under test
   → `balanceOf(recipient)` again, all in one EVM call tree, since
   sub-calls within a single `eth_call` DO see each other's effects).
   Compiled with `forge build` and tested live via `cast call
   --override-code` — it works mechanically, but breaks the exact thing
   it needs: when the probe makes the sub-call, `msg.sender` as seen by
   the token becomes the PROBE's address, not the impersonated holder, so
   `transfer()`'s `require(balanceOf[msg.sender] >= amount)` fails (the
   probe itself holds nothing). `transferFrom()` doesn't have that
   problem but needs a real allowance, which no real holder has actually
   granted the probe.
2. **State-override the allowance/balance storage slot directly** — the
   fully general fix, but requires computing `keccak256(abi.encode(addr,
   slotIndex))` for the mapping slot, which needs a keccak256
   implementation. Deliberately not hand-rolled and added as a dependency
   for this v1 — a subtly-wrong hash would silently produce a WRONG
   "expected" figure, which is worse than not reporting one at all.

**What ships instead:** SUCCESS/REVERT detection for every simulated
trade, which is the signal that actually answers this project's stated
concern ("is this a honeypot that blocks sells") — an exact amount delta
would refine confidence in a *declared_fot* verdict but isn't what
separates *declared_fot* from *suspect*. Revisit with a proper keccak256
dependency or a full forked-node simulation (Anvil) if exact deltas become
load-bearing for some future check.

## Fixtures
- **TACO** (`config/tokens/taco.json`) — the declared-FOT fixture. Every
  check above was individually verified correct against its actual
  contract source and live chain state.
- **No `suspect` fixture yet.** Per this repo's non-goals and the
  project's own "don't fabricate" principle (see `chainqa/README.md`'s
  identical stance on router addresses): a plausible-looking fake drainer
  contract would validate nothing real and could mislead anyone reading
  scan results later. Find a real contract already reported/blocklisted
  by one of the third-party bridge safe-lists the project brief mentions,
  and use its actual address once identified.

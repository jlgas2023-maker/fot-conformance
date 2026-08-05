# Generic zero-backend token dashboard — Deliverable 3 (built, live)

Ported from `~/taco-burn/dist/stats.html` (a separate, already-live,
TACO-hardcoded page outside this repo) into `index.html` + `app.js`, driven
by a single `config.json` (`config.schema.json`, `example.config.json`).
Try it: `dashboard/index.html?config=example.config.json` (or omit
`?config=` — that's the default).

## What changed from stats.html
- Every hardcoded constant (`CA`, `PAIR`, `WETH`, `USDG`, `FACTORY`,
  `INITIAL_SUPPLY`, `BLOCKSCOUT`) now comes from a fetched `config.json`
  instead of a literal.
- `LABELS` became `config.labels`, keyed by lowercase address, with a
  `class` field driving the same tag styling stats.html hardcoded
  (`pool`/`hold`/`founder`/`burn`/`router`).
- Genesis supply: `config.genesisSupply`, or — if a token's config omits
  it — falls back to reading `supply/history/<symbol>/index.json`'s latest
  run (this repo's own Deliverable 2 output), so the two deliverables
  share one source of truth instead of each hardcoding it separately.
- USD pricing (`ethUsd()` → `nativeUsd()`) is optional: a token config
  without `stablePool` just shows native-currency figures instead of USD,
  rather than erroring.
- Holders/24h-flow load independently of each other once core stats
  resolve (neither blocks on the other) — stats.html already mostly did
  this; tightened further here.
- Added explorer links on price/FDV/liquidity/supply/holders/every wallet
  row and the block number, per the "every figure links to the query that
  produced it" requirement — confirmed live this was NOT actually true of
  the original TACO-specific page either, so this is a real fix, not just
  a port.

## Bug caught while porting (worth flagging explicitly)
The natural first draft of `example.config.json` set `stablePool` to
USDG's own **token** address (copied from `config/chains/robinhood.json`'s
`stablecoin` field). That's wrong — `reserves()` calls
`0x0902f1ac`/`0x0dfe1681` (Uniswap V2 pair functions) against whatever
address `stablePool` points to, and a plain ERC20 token contract doesn't
implement those, so every call reverted. Caught by actually executing the
ported price logic in Node against live RPC before calling this done, not
by static review — this repo's `config.schema.json` field description now
says explicitly not to make this mistake again, and the correct pool
address (`0x8803C117CCAe7b5146297876c2A25Df135141C4d`, found via the
factory's `getPair(USDG, WETH)`) is what's actually in
`example.config.json`.

## `chunkLogs`/`rpcRetry` duplication (known, accepted for now)
`supply/rpc.mjs` already has a tested version of this exact pattern.
`dashboard/app.js` has its own copy rather than importing it, because
`supply/rpc.mjs` is a Node ES module (`import`/`export`) and this page is
loaded as a plain browser `<script>`, not a module — sharing it cleanly
would mean converting one side or the other, or adding a build step, which
conflicts with the "no build step" hard constraint. Worth revisiting if a
third place ends up needing the same pattern.

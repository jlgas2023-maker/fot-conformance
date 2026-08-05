# Chain infrastructure QA monitor — Deliverable 4 (partially built)

Same scheduled-Action + committed-history pattern as `supply/` (Deliverable
2). Run: `node chainqa/check.mjs [chain-config-name]` (default: `robinhood`).

## Implemented, live
- **RPC availability and latency** — `eth_blockNumber` round-trip against
  `config/chains/<chain>.json`'s `rpc` field.
- **Blockscout indexing lag** — head block (from RPC) minus latest indexed
  block (`{explorerApiBase}/api/v2/blocks?type=block`, `items[0].height`).
  Confirmed live 2026-08: this chain's `/api/v2/stats` endpoint also
  reports a `total_blocks` figure that *doesn't* match `/api/v2/blocks`'
  top item (off by ~1,800 blocks at the moment checked) — used the
  `/blocks` endpoint here since it's the more direct block listing, not
  the summary stats endpoint, but that discrepancy between two "official"
  Blockscout numbers is itself worth remembering if this ever needs
  cross-checking.
- **Verified-source coverage** — `{explorerApiBase}/api/v2/
  smart-contracts/counters`. **Reported as an all-time figure, not
  "recently deployed" specifically** — see the comment above
  `checkVerificationCoverage` in `check.mjs` for why: the counters
  endpoint's `new_verified_smart_contracts_24h` (confirmed live to count
  verification *events* in the last 24h, for contracts of any age) came
  back larger than `new_smart_contracts_24h` (contracts actually deployed
  in that window), which only makes sense if most verifications target
  older contracts. A true "of contracts deployed in the last 24h, what %
  are verified" figure would need per-contract creation-block lookups —
  not implemented, would be expensive at this chain's deployment rate
  (~3,000 new contracts/day at time of writing).

## Not implemented
- **Router compatibility matrix** — needs known router/aggregator
  addresses on this chain to quote-and-simulate against. None were found
  in this repo's own deploy history: TACO's LP was added by calling the
  pair contract directly, not through a router (see `taco-burn/AUDIT.md`).
  Fabricating a plausible-looking router address to fill this in would
  produce a fake-looking-real result — worse than leaving it explicitly
  absent (`routerCompatibility: {implemented: false, reason: ...}` in
  every committed snapshot). Same principle as `scanner/README.md`'s
  fixture note: don't fabricate what isn't real. Revisit once a genuine
  router or aggregator address on Robinhood Chain is identified.

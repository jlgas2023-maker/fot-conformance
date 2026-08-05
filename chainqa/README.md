# Chain infrastructure QA monitor — Deliverable 4 (not yet implemented)

Per the build order, this depends on scheduling infrastructure the earlier
pieces establish — `supply/`'s GitHub Action (`.github/workflows/
supply-check.yml`) is the working reference for the pattern this should
follow: scheduled Action → `node chainqa/check.mjs` → commit a dated JSON
to a `history/` dir → render page reads the committed history, same as
`supply/index.html` does.

## Planned checks

- **RPC availability and latency** — sample each public Robinhood Chain
  RPC endpoint (currently only one is known,
  `config/chains/robinhood.json`'s `rpc` field; extend that config with an
  array if/when more public endpoints exist) with a cheap call
  (`eth_blockNumber`) and record round-trip time + success/failure.
- **Blockscout indexing lag** — `head block` (from RPC `eth_blockNumber`)
  minus `latest indexed block` (Blockscout's own
  `/api/v2/blocks?type=block` or equivalent — endpoint shape not yet
  confirmed live, check before implementing).
- **Router compatibility matrix** — for a fixed basket of token types
  (plain, FOT — TACO is the FOT fixture, a "plain" fixture is still
  needed, pick any non-FOT verified token on this chain once one is
  identified; rebasing if a real example exists on this chain, otherwise
  omit that column rather than fabricate a fixture), which routers and
  aggregators successfully quote AND simulate a swap
  (`eth_call`-only, same no-broadcast rule as `scanner/dynamic.mjs`).
- **Verification coverage** — percentage of recently deployed contracts
  (define "recent" as a rolling block window once implemented) with
  verified source, via Blockscout's smart-contract listing endpoint.

## Why this is last
Every other deliverable in this suite treats "the chain and its explorer
are reachable and current" as a given. This is the piece that actually
checks that assumption and makes the check visible — so if `supply/`'s
scheduled run ever goes stale, this page is where to look first for
whether it's this suite's bug or the chain's.

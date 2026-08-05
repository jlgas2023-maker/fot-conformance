# Generic zero-backend token dashboard — Deliverable 3 (not yet genericized)

Per the build order this is "mostly refactoring code that already exists" —
the source to port is `~/taco-burn/dist/stats.html` (not in this repo; a
separate, already-live, TACO-hardcoded page). That file already implements,
against this exact chain, in vanilla JS with zero dependencies:

- price / FDV / liquidity via pool reserves (`reserves()`, `tacoPrice()`,
  `ethUsd()`)
- current vs genesis supply with burn ring (`loadCore()`)
- holder distribution via Blockscout's `/api/v2/tokens/{addr}/holders`,
  with known addresses (pool, burn) labeled (`loadHolders()`)
- 24h buy/sell flow from chunked `eth_getLogs` pool-transfer scanning, with
  an explicit "partial data" warning when a chunk fails
  (`chunkLogs`/`rpcRetry`/`load24h()`)
- binary-search block-finding for a target timestamp, robust to this
  chain's non-uniform block time (`findBlockAtTime()`)

`supply/rpc.mjs` in this repo already extracted the `chunkLogs`/`rpcRetry`
pattern into a reusable, tested module — reuse it here rather than
re-copying from stats.html a second time.

## What "genericizing" means concretely
1. Replace every hardcoded constant (`CA`, `PAIR`, `WETH`, `USDG`,
   `FACTORY`, `INITIAL_SUPPLY`, `BLOCKSCOUT`) with a fetch of
   `config.json` (see `config.schema.json`), loaded via `?config=` query
   param or a same-directory default.
2. `LABELS` (the hardcoded pool/burn/founder address tags in stats.html)
   becomes `config.labels`, keyed by address.
3. Genesis supply: currently `INITIAL_SUPPLY=1_000_000_000` is a literal.
   Should read from `supply/history/<token>/index.json` if present (this
   repo's own Deliverable 2 output) so the two deliverables share one
   source of truth instead of each hardcoding it separately.
4. Progressive render and log-scan degradation are already implemented in
   the source file (`status()`, the `incomplete` flag threaded through
   `chunkLogs`/`load24h`) — carry that behavior over, don't rebuild it.
5. Every displayed figure should link to the explorer query that produced
   it (hard requirement, not yet true in the TACO-specific version either
   — check while porting, don't just assume it's already done).

## Config shape (`config.schema.json`)
See that file for the full schema. `example.config.json` is TACO's config
expressed in the target shape, cross-checked against `config/tokens/
taco.json` (the shared token config Deliverables 2 and 4 also use) so this
doesn't duplicate a second, possibly-drifting copy of the same addresses.

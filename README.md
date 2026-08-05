# Fee On Transfer Conformance Suite (Robinhood Chain)

Read-only, zero-backend tooling that classifies ERC20 tokens on Robinhood
Chain, checks whether external data providers report supply figures that
actually match the chain, and monitors the chain's own infrastructure —
all static-hosted, all reproducible by a third party from committed JSON,
none of it launches, trades, or holds anything.

**Live:** [supply conformance](supply/index.html) and the
[token dashboard](dashboard/index.html) are both built. The other two
deliverables below are scaffolded but not yet implemented — see each
one's own README.

Full rationale, hard constraints, and the exact methodology behind every
check: **[docs/methodology.md](docs/methodology.md)**.

## Status

| Deliverable | Status |
|---|---|
| 2. Supply conformance checker | **Built.** Live-caught GeckoTerminal reporting TACO's genesis supply as current (+51.5% overstatement) on its first real run — see `supply/history/taco/`. |
| 3. Generic token dashboard | **Built.** `taco-burn/dist/stats.html` ported into a config-driven template (`dashboard/index.html` + `app.js`) — verified against real chain data, caught and fixed a bad `stablePool` config value (token address vs. pool address) before shipping. |
| 1. FOT taxonomy scanner | Scaffolded (`scanner/README.md`, verdict schema). The hard one — static source/bytecode analysis, then `eth_call`-only dynamic simulation. Not yet done. |
| 4. Chain infrastructure QA monitor | Scaffolded (`chainqa/README.md`). Depends on the scheduling pattern Deliverable 2 already established. Not yet done. |

## Reference fixture

[TACO](https://robinhoodchain.blockscout.com/token/0x9e5e02F5C9ea48931d4e8f488089103e93F925fF)
(`0x9e5e02F5C9ea48931d4e8f488089103e93F925fF`) — 1B fixed genesis supply,
18 decimals, 4% burn-on-sell only, immutable rate with no setter, ownership
renounced, LP burned. Used throughout as the stable, declared-FOT test
fixture. See `docs/methodology.md` for why.

## Repository structure

```
config/     chain and token configs, as JSON
scanner/    taxonomy static + dynamic analysis        (Deliverable 1)
supply/     conformance checker + committed run history (Deliverable 2)
dashboard/  generic dashboard template                 (Deliverable 3)
chainqa/    infrastructure monitor + committed history  (Deliverable 4)
.github/workflows/   scheduled Actions
docs/       methodology, the reference writeup
```

## Running the supply checker locally

```
node supply/check.mjs taco
```

No `npm install` — `supply/*.mjs` is dependency-free (Node 18+'s global
`fetch`), on purpose, matching the "no build step" constraint even though
that constraint is really about the static-hosting side, not local dev.

## Non-goals

No token launch functionality. No bonding curve, no factory, no liquidity
provisioning, no trade routing, no custody of user funds. No platform
token, no fee share, no staking, no revenue mechanism of any kind. No
ranking, trending, or featured list of tokens. This suite reads and
reports. It does not launch, trade, or promote.

## License

MIT — see [LICENSE](LICENSE).

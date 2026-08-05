# FOT taxonomy scanner — Deliverable 1 (not yet implemented)

Classifies any ERC20 on the chain into `clean`, `declared_fot`, or `suspect`.
This is the hard deliverable (per the build order in `../docs/methodology.md`)
and is stubbed here as a defined verdict schema + planned check list, not a
working implementation yet. `supply/` (Deliverable 2) is the fully-built
reference for the coding conventions this should follow when built out:
dependency-free `.mjs`, `rpc.mjs`'s chunked/retrying `eth_getLogs` helper
reused as-is, every check's evidence traceable back to a raw RPC response.

## Verdict schema (`verdict.schema.json` — the contract, build to this)

```jsonc
{
  "token": "0x...",
  "chain": "robinhood",
  "checkedAt": "ISO timestamp",
  "verdict": "clean | declared_fot | suspect",
  // Never a bare score -- every entry below is one check, its result, and
  // the evidence a third party needs to reproduce it without trusting us.
  "checks": [
    {
      "id": "fee_rate_mutability",
      "result": "constant | immutable | mutable_with_setter | not_found",
      "evidence": { "setterSelector": "0x... | null", "sourceLine": null, "opcodeOffset": null }
    }
    // ... one entry per check below
  ]
}
```

## Planned checks

### Static (fetched verified source + deployed bytecode)
- Fee logic detection in `_transfer` / `transfer` / `transferFrom`.
- Fee rate mutability: compile-time constant vs `immutable` vs mutable
  storage var with a setter — report which, and the setter's 4-byte
  selector if one exists.
- Privileged address checks inside any transfer path.
- Storage mappings read inside `transferFrom` that are NOT the standard
  `_allowances` mapping — **the documented drainer pattern** per the
  project brief. Highest-priority check to get right.
- Allowance checks that can be conditionally bypassed.
- Mint / blacklist / pause / ownership functions, and whether `owner()` is
  the zero address.
- Asymmetric behavior: fee on sell but not buy, or transfer reverting
  conditionally on recipient.

### Dynamic (`eth_call` simulation only — nothing in this suite broadcasts
a transaction, matching hard constraint #4)
- Simulate buy, sell, wallet-to-wallet transfer; report actual received
  amount vs expected for each.
- Simulate a sell from a wallet that ALREADY holds the token, to catch
  sell-blocking that only triggers post-purchase (a plain "does the buy
  succeed" check misses this).
- Report which router function signatures succeed vs revert, specifically
  `swapExactTokensForETHSupportingFeeOnTransferTokens` vs the
  non-supporting variant — this is the concrete, checkable signal that
  distinguishes "legitimate FOT token, use the right router call" from
  "something is actually blocking the sell."

## Known-good / known-bad fixtures for testing this once built
- **TACO** (`config/tokens/taco.json`) — the reference declared-FOT fixture.
  Immutable, no setter, no privileged checks, no non-`_allowances` mapping
  read in `transferFrom`, asymmetric by design (sell-only) and disclosed as
  such. Should classify `declared_fot`, never `suspect`.
- A genuine drainer fixture is still needed — do not fabricate one; find a
  real reported-malicious contract on this chain via the third-party
  hand-curated bridge safe-lists referenced in the project brief and use
  its address as a `suspect` fixture once one is identified.

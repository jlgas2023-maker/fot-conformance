// External data-source adapters for the supply conformance checker.
// Each adapter is independent and MUST NOT throw -- a source being down,
// unsupported for this chain, or shaped differently than expected shows up
// as one row with error set, never crashes the whole run. That degrade-
// gracefully rule is load-bearing: this suite explicitly exists because a
// hosted competitor collapsed under unexpected inputs (see README).
//
// Every adapter returns:
//   { name, url, supply: number|null, method, raw, error: string|null, fetchedAt }
// `supply` is in whole-token units (already divided by decimals), or the
// adapter's own best equivalent (see dexscreener's "implied" note below).
// `method` is a one-line human string of exactly how supply was derived
// from the raw response -- required so the JSON verdict is reproducible by
// a third party without reading this file's source.

async function safeFetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function runAdapter(name, url, fn) {
  const fetchedAt = new Date().toISOString();
  try {
    const { supply, method, raw } = await fn();
    return { name, url, supply, method, raw, error: null, fetchedAt };
  } catch (err) {
    return { name, url, supply: null, method: null, raw: null, error: err.message, fetchedAt };
  }
}

// Blockscout's own indexer -- a genuinely independent code path from the
// raw eth_call this suite treats as ground truth (different software,
// different sync process), so agreement or disagreement here is
// meaningful, not circular.
export function blockscoutAdapter(chainCfg, tokenCfg) {
  const url = `${chainCfg.explorerApiBase}/api/v2/tokens/${tokenCfg.address}`;
  return runAdapter("blockscout", url, async () => {
    const j = await safeFetchJson(url);
    if (j.total_supply == null) throw new Error("no total_supply field in response");
    const supply = Number(BigInt(j.total_supply)) / 10 ** tokenCfg.decimals;
    return { supply, method: "total_supply field, raw base units / 10**decimals", raw: j };
  });
}

// GeckoTerminal (CoinGecko's DEX arm) -- confirmed live 2026-08 to return
// BOTH total_supply (matches genesis exactly, 1e27 base units for TACO)
// AND normalized_total_supply (also genesis, not current) for a token that
// has burned ~34% of genesis supply. This is the exact failure mode this
// whole suite exists to catch and document, not a hypothetical.
export function geckoTerminalAdapter(chainCfg, tokenCfg) {
  const network = chainCfg.geckoTerminalNetwork || "robinhood";
  const url = `https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${tokenCfg.address}`;
  return runAdapter("geckoterminal", url, async () => {
    const j = await safeFetchJson(url);
    const attrs = j?.data?.attributes;
    if (!attrs || attrs.normalized_total_supply == null)
      throw new Error("no data.attributes.normalized_total_supply in response");
    return {
      supply: Number(attrs.normalized_total_supply),
      method: "data.attributes.normalized_total_supply, already token-unit scaled",
      raw: attrs,
    };
  });
}

// DexScreener exposes no raw totalSupply field at all -- only fdv and
// marketCap (both USD). Confirmed live: for TACO these are numerically
// equal to each other, meaning DexScreener computes both from the SAME
// supply figure (no separate circulating/FDV distinction), so backing out
// supply = marketCap / priceUsd recovers whatever figure they used. This is
// explicitly labeled "implied", not "reported" -- it's this adapter's own
// derivation, not a number DexScreener stated directly, and priceUsd's
// limited display precision means it inherits some rounding error.
export function dexScreenerAdapter(chainCfg, tokenCfg) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenCfg.address}`;
  return runAdapter("dexscreener (implied)", url, async () => {
    const j = await safeFetchJson(url);
    const pair = (j.pairs || []).find(
      (p) => p.baseToken?.address?.toLowerCase() === tokenCfg.address.toLowerCase()
    );
    if (!pair) throw new Error("token not present in any pair (chain/token unsupported or unindexed)");
    if (!pair.marketCap || !pair.priceUsd) throw new Error("pair missing marketCap or priceUsd");
    const supply = Number(pair.marketCap) / Number(pair.priceUsd);
    return {
      supply,
      method: "implied: marketCap / priceUsd (DexScreener reports no raw supply field)",
      raw: { marketCap: pair.marketCap, priceUsd: pair.priceUsd, fdv: pair.fdv },
    };
  });
}

export const DEFAULT_ADAPTERS = [blockscoutAdapter, geckoTerminalAdapter, dexScreenerAdapter];

export async function runAllSources(chainCfg, tokenCfg, adapters = DEFAULT_ADAPTERS) {
  return Promise.all(adapters.map((mk) => mk(chainCfg, tokenCfg)));
}

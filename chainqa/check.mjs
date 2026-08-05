#!/usr/bin/env node
// Deliverable 4: chain infrastructure QA monitor. Usage:
//   node chainqa/check.mjs [chain-config-name]   (default: robinhood)
//
// Same pattern as supply/check.mjs: writes a dated snapshot to
// chainqa/history/<chain>/ plus an index.json manifest.
//
// Three of the four planned checks are implemented for real, against live
// endpoints -- see docs/methodology.md for what each one measures and its
// known limitation:
//   - RPC availability/latency (eth_blockNumber round-trip)
//   - Blockscout indexing lag (head block vs. latest indexed block)
//   - Verified-source coverage (Blockscout's smart-contracts counters --
//     ALL-TIME coverage, not scoped to "recently deployed" specifically;
//     see the note in the check itself for why)
//
// Router compatibility matrix is NOT implemented: it needs known
// router/aggregator addresses on this chain to test against, and none
// were found in this repo's own deploy history (TACO's LP was added by
// calling the pair contract directly, not through a router -- see
// taco-burn/AUDIT.md). Fabricating a plausible-looking router address to
// fill this in would be worse than leaving it explicitly absent -- see
// scanner/README.md's fixture note for the same principle applied there.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rpcRetry, blockNumber } from "../supply/rpc.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function loadJson(relPath) {
  return JSON.parse(await readFile(path.join(ROOT, relPath), "utf8"));
}

async function checkRpcLatency(chainCfg) {
  const t0 = performance.now();
  try {
    const block = await blockNumber(chainCfg.rpc);
    return { url: chainCfg.rpc, ok: true, latencyMs: Math.round(performance.now() - t0), block, error: null };
  } catch (err) {
    return { url: chainCfg.rpc, ok: false, latencyMs: Math.round(performance.now() - t0), block: null, error: err.message };
  }
}

async function checkIndexingLag(chainCfg, headBlock) {
  const url = `${chainCfg.explorerApiBase}/api/v2/blocks?type=block`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const indexedBlock = j.items?.[0]?.height;
    if (indexedBlock == null) throw new Error("no items[0].height in response");
    return { url, ok: true, indexedBlock, headBlock, lagBlocks: headBlock - indexedBlock, error: null };
  } catch (err) {
    return { url, ok: false, indexedBlock: null, headBlock, lagBlocks: null, error: err.message };
  }
}

// Blockscout's /api/v2/smart-contracts/counters gives all-time totals, not
// a "verified / newly-deployed-in-window" ratio -- confirmed live 2026-08:
// new_verified_smart_contracts_24h (verification EVENTS in the last 24h,
// for contracts of any age) came back larger than new_smart_contracts_24h
// (contracts actually DEPLOYED in the last 24h), which only makes sense if
// most verifications target older contracts, not yesterday's. Computing a
// true "of contracts deployed in the last 24h, what %% are verified"
// figure would mean listing every contract created in that block range
// and checking each one's verification status individually -- expensive
// (thousands/day on this chain) and not implemented here. This check is
// explicitly labeled "all-time" rather than overclaiming "recent."
async function checkVerificationCoverage(chainCfg) {
  const url = `${chainCfg.explorerApiBase}/api/v2/smart-contracts/counters`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const total = Number(j.smart_contracts);
    const verified = Number(j.verified_smart_contracts);
    if (!total) throw new Error("smart_contracts counter missing or zero");
    return {
      url,
      ok: true,
      scope: "all-time",
      totalContracts: total,
      verifiedContracts: verified,
      verifiedPct: (verified / total) * 100,
      newContracts24h: Number(j.new_smart_contracts_24h) || null,
      newVerified24h: Number(j.new_verified_smart_contracts_24h) || null,
      error: null,
    };
  } catch (err) {
    return { url, ok: false, scope: "all-time", totalContracts: null, verifiedContracts: null, verifiedPct: null, error: err.message };
  }
}

async function main() {
  const chainName = process.argv[2] || "robinhood";
  const chainCfg = await loadJson(`config/chains/${chainName}.json`);

  console.log(`=== chain infrastructure QA: ${chainCfg.name} ===`);

  const rpcResult = await checkRpcLatency(chainCfg);
  console.log(`  RPC: ${rpcResult.ok ? `OK, ${rpcResult.latencyMs}ms, block ${rpcResult.block}` : `FAILED: ${rpcResult.error}`}`);

  const indexingResult = rpcResult.ok
    ? await checkIndexingLag(chainCfg, rpcResult.block)
    : { url: `${chainCfg.explorerApiBase}/api/v2/blocks?type=block`, ok: false, error: "skipped -- RPC head block unavailable" };
  console.log(
    `  indexing lag: ${indexingResult.ok ? `${indexingResult.lagBlocks} blocks (indexed ${indexingResult.indexedBlock}, head ${indexingResult.headBlock})` : `FAILED: ${indexingResult.error}`}`
  );

  const verificationResult = await checkVerificationCoverage(chainCfg);
  console.log(
    `  verified-source coverage (all-time): ${verificationResult.ok ? `${verificationResult.verifiedPct.toFixed(2)}% (${verificationResult.verifiedContracts.toLocaleString()} / ${verificationResult.totalContracts.toLocaleString()})` : `FAILED: ${verificationResult.error}`}`
  );

  console.log(`  router compatibility matrix: NOT IMPLEMENTED -- no known router/aggregator addresses on this chain, see this file's header comment`);

  const snapshot = {
    chain: chainCfg.name,
    fetchedAt: new Date().toISOString(),
    rpc: rpcResult,
    indexingLag: indexingResult,
    verificationCoverage: verificationResult,
    routerCompatibility: { implemented: false, reason: "no known router/aggregator addresses on this chain -- see check.mjs header comment" },
  };

  const historyDir = `chainqa/history/${chainName}`;
  await mkdir(path.join(ROOT, historyDir), { recursive: true });
  const fname = `${snapshot.fetchedAt.replace(/[:.]/g, "-")}.json`;
  await writeFile(path.join(ROOT, historyDir, fname), JSON.stringify(snapshot, null, 2));

  let index = [];
  try {
    const loaded = await loadJson(`${historyDir}/index.json`);
    // Confirmed live 2026-08-05: a malformed (non-array) index.json made
    // it into git once already and crashed every subsequent run with
    // "index.push is not a function" -- self-heal instead of trusting the
    // file's shape blindly, same as a missing file just starts fresh.
    if (Array.isArray(loaded)) index = loaded;
    else console.warn(`${historyDir}/index.json was not an array (got ${typeof loaded}) -- starting a fresh index instead of crashing`);
  } catch {
    // First run for this chain.
  }
  index.push({
    file: fname,
    fetchedAt: snapshot.fetchedAt,
    rpcOk: rpcResult.ok,
    rpcLatencyMs: rpcResult.latencyMs,
    indexingLagBlocks: indexingResult.lagBlocks,
    verifiedPct: verificationResult.verifiedPct,
  });
  await writeFile(path.join(ROOT, historyDir, "index.json"), JSON.stringify(index, null, 2));

  console.log(`  wrote ${historyDir}/${fname}`);
}

main().catch((err) => {
  console.error("chainqa check failed:", err);
  process.exit(1);
});

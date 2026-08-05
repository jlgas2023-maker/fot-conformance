#!/usr/bin/env node
// Deliverable 2: supply conformance checker. See docs/methodology.md for
// the full rationale. Usage:
//   node supply/check.mjs <token-config-name>   (default: taco)
//
// Writes a dated, immutable JSON snapshot to supply/history/<token>/ and
// updates supply/history/<token>/index.json (a manifest the render page
// reads instead of directory-listing, which GitHub Pages can't do) and
// supply/state/<token>.json (the incremental burn-scan checkpoint --
// NOT dated/history, this file is overwritten each run on purpose).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ethCall,
  rpcRetry,
  blockNumber,
  getLogsChunked,
  transferLogsTopics,
  transferValue,
} from "./rpc.mjs";
import { runAllSources } from "./sources.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const TOTAL_SUPPLY_SELECTOR = "0x18160ddd"; // totalSupply()

async function loadJson(relPath) {
  return JSON.parse(await readFile(path.join(ROOT, relPath), "utf8"));
}

async function loadConfigs(tokenName) {
  const tokenCfg = await loadJson(`config/tokens/${tokenName}.json`);
  const chainCfg = await loadJson(`config/chains/${tokenCfg.chain}.json`);
  return { tokenCfg, chainCfg };
}

// Genesis supply = sum of every Transfer(from=0x0) event in the deployment
// tx (a token can mint to more than one address at construction -- TACO
// itself does: founder cut + LP allocation, two separate Transfer(0x0, ...)
// events in one tx). Falls back to a full chunked chain scan from block 0
// for tokens whose config doesn't pin a deploymentTxHash -- slower, but
// this checker is meant to work for "a given token", not just TACO.
async function readGenesisSupply(chainCfg, tokenCfg) {
  if (tokenCfg.deploymentTxHash) {
    const receipt = await rpcRetry(chainCfg.rpc, "eth_getTransactionReceipt", [tokenCfg.deploymentTxHash]);
    if (!receipt) throw new Error(`no receipt for deploymentTxHash ${tokenCfg.deploymentTxHash}`);
    const [topic0] = transferLogsTopics({ from: "0x0000000000000000000000000000000000000000" });
    const mints = (receipt.logs || []).filter(
      (l) =>
        l.address.toLowerCase() === tokenCfg.address.toLowerCase() &&
        l.topics[0]?.toLowerCase() === topic0.toLowerCase() &&
        BigInt(l.topics[1]) === 0n
    );
    if (mints.length === 0)
      throw new Error("deploymentTxHash has no Transfer(0x0, ...) logs for this token -- wrong tx hash?");
    const totalRaw = mints.reduce((s, l) => s + transferValue(l), 0n);
    return {
      genesisRaw: totalRaw,
      method: `sum of ${mints.length} Transfer(0x0,...) log(s) in deploymentTxHash ${tokenCfg.deploymentTxHash}`,
      evidence: { txHash: tokenCfg.deploymentTxHash, mintCount: mints.length },
    };
  }

  // Fallback: scan from block 0 (or deploymentBlock if given without a tx
  // hash) for the first Transfer(from=0x0) event.
  const fromBlock = tokenCfg.deploymentBlock || 0;
  const latest = await blockNumber(chainCfg.rpc);
  const topics = transferLogsTopics({ from: "0x0000000000000000000000000000000000000000" });
  const { logs, incomplete } = await getLogsChunked(chainCfg.rpc, {
    address: tokenCfg.address,
    topics,
    fromBlock,
    toBlock: latest,
  });
  if (logs.length === 0)
    throw new Error(
      `no Transfer(0x0,...) logs found scanning block ${fromBlock}-${latest}${incomplete ? " (scan incomplete -- RPC errors, see log)" : ""}`
    );
  // All mints from the deployment block (genesis can be multi-event, as
  // above) -- take every log at the lowest block number found.
  const minBlock = Math.min(...logs.map((l) => parseInt(l.blockNumber, 16)));
  const genesisLogs = logs.filter((l) => parseInt(l.blockNumber, 16) === minBlock);
  const totalRaw = genesisLogs.reduce((s, l) => s + transferValue(l), 0n);
  return {
    genesisRaw: totalRaw,
    method: `sum of ${genesisLogs.length} Transfer(0x0,...) log(s) at first-seen block ${minBlock} (chain-scanned, no deploymentTxHash configured)`,
    evidence: { firstBlock: minBlock, mintCount: genesisLogs.length, scanIncomplete: incomplete },
  };
}

// Incremental burn-log scan: only re-scans blocks after the last committed
// checkpoint, not the whole chain every run. First run on a token with no
// checkpoint yet starts at deploymentBlock (or 0) -- expect that one run to
// be slow; every run after is cheap.
async function updateBurnCheckpoint(chainCfg, tokenCfg, latestBlock) {
  const statePath = `supply/state/${tokenCfg.symbol.toLowerCase()}.json`;
  let state = { lastScannedBlock: (tokenCfg.deploymentBlock || 1) - 1, cumulativeBurnedRaw: "0" };
  try {
    state = await loadJson(statePath);
  } catch {
    // No checkpoint yet -- fresh start, defaults above stand.
  }

  const fromBlock = state.lastScannedBlock + 1;
  if (fromBlock > latestBlock) {
    return { burnedRaw: BigInt(state.cumulativeBurnedRaw), incomplete: false, scannedNewBlocks: 0 };
  }

  const topics = transferLogsTopics({ to: tokenCfg.burnAddresses });
  const { logs, incomplete, scannedThrough } = await getLogsChunked(chainCfg.rpc, {
    address: tokenCfg.address,
    topics,
    fromBlock,
    toBlock: latestBlock,
  });
  const newBurned = logs.reduce((s, l) => s + transferValue(l), 0n);
  const cumulativeBurnedRaw = BigInt(state.cumulativeBurnedRaw) + newBurned;

  // Only advance the checkpoint to scannedThrough (never past a gap left
  // by a failed chunk) -- see getLogsChunked's own comment. Rescans a
  // small already-covered range next run rather than silently missing a
  // gap forever.
  const newLastScanned = Math.max(scannedThrough, state.lastScannedBlock);
  await mkdir(path.join(ROOT, "supply/state"), { recursive: true });
  await writeFile(
    path.join(ROOT, statePath),
    JSON.stringify(
      { lastScannedBlock: newLastScanned, cumulativeBurnedRaw: cumulativeBurnedRaw.toString(), updatedAt: new Date().toISOString() },
      null,
      2
    )
  );
  return { burnedRaw: cumulativeBurnedRaw, incomplete, scannedNewBlocks: scannedThrough - fromBlock + 1 };
}

async function main() {
  const tokenName = process.argv[2] || "taco";
  const { tokenCfg, chainCfg } = await loadConfigs(tokenName);
  const dec = tokenCfg.decimals;
  const toUnits = (raw) => Number(raw) / 10 ** dec;

  console.log(`=== supply conformance: ${tokenCfg.symbol} on ${chainCfg.name} ===`);

  const [currentSupplyHex, latestBlock] = await Promise.all([
    ethCall(chainCfg.rpc, tokenCfg.address, TOTAL_SUPPLY_SELECTOR),
    blockNumber(chainCfg.rpc),
  ]);
  const currentRaw = BigInt(currentSupplyHex);
  console.log(`  on-chain totalSupply: ${toUnits(currentRaw).toLocaleString()} (block ${latestBlock})`);

  const genesis = await readGenesisSupply(chainCfg, tokenCfg);
  console.log(`  genesis supply: ${toUnits(genesis.genesisRaw).toLocaleString()} -- ${genesis.method}`);

  const burnedByDifference = genesis.genesisRaw - currentRaw;
  const burnCheck = await updateBurnCheckpoint(chainCfg, tokenCfg, latestBlock);
  const burnedByLogs = burnCheck.burnedRaw;
  const agree = burnedByDifference === burnedByLogs;

  console.log(`  burned (genesis - current):     ${toUnits(burnedByDifference).toLocaleString()}`);
  console.log(`  burned (sum of burn transfers): ${toUnits(burnedByLogs).toLocaleString()}` + (burnCheck.incomplete ? " (INCOMPLETE SCAN)" : ""));
  console.log(`  independent checks agree: ${agree}`);
  if (!agree && !burnCheck.incomplete) {
    console.warn(
      `  !! MISMATCH: difference of ${toUnits(burnedByDifference - burnedByLogs).toLocaleString()} ${tokenCfg.symbol} -- ` +
        `either burnAddresses in config/tokens/${tokenName}.json is missing a real burn destination, or the token has a non-Transfer supply-change path (rebase, hidden mint) this checker doesn't model.`
    );
  }

  const externalSources = await runAllSources(chainCfg, tokenCfg);
  const onChainSupplyUnits = toUnits(currentRaw);
  const rows = [
    {
      source: "on-chain (ground truth)",
      reportedSupply: onChainSupplyUnits,
      onChainSupply: onChainSupplyUnits,
      absoluteDelta: 0,
      percentDelta: 0,
      capFdvWrong: false,
      method: "eth_call totalSupply() at latest block, this run",
      error: null,
    },
    ...externalSources.map((s) => {
      if (s.supply == null) {
        return {
          source: s.name,
          reportedSupply: null,
          onChainSupply: onChainSupplyUnits,
          absoluteDelta: null,
          percentDelta: null,
          capFdvWrong: null,
          method: s.method,
          error: s.error,
        };
      }
      const absoluteDelta = s.supply - onChainSupplyUnits;
      const percentDelta = (absoluteDelta / onChainSupplyUnits) * 100;
      return {
        source: s.name,
        reportedSupply: s.supply,
        onChainSupply: onChainSupplyUnits,
        absoluteDelta,
        percentDelta,
        // >0.01% is "wrong enough to matter" for a display figure -- exact
        // float equality would flag harmless last-digit rounding as drift.
        capFdvWrong: Math.abs(percentDelta) > 0.01,
        method: s.method,
        error: null,
      };
    }),
  ];

  for (const r of rows) {
    if (r.error) console.log(`  [${r.source}] ERROR: ${r.error}`);
    else
      console.log(
        `  [${r.source}] ${r.reportedSupply.toLocaleString()} (Δ ${r.percentDelta >= 0 ? "+" : ""}${r.percentDelta.toFixed(3)}%)` +
          (r.capFdvWrong ? "  <-- market cap/FDV derived from this figure is WRONG" : "")
      );
  }

  const snapshot = {
    token: tokenCfg.symbol,
    chain: chainCfg.name,
    address: tokenCfg.address,
    fetchedAt: new Date().toISOString(),
    block: latestBlock,
    onChainSupply: onChainSupplyUnits,
    genesisSupply: toUnits(genesis.genesisRaw),
    genesisMethod: genesis.method,
    genesisEvidence: genesis.evidence,
    burnedByDifference: toUnits(burnedByDifference),
    burnedByLogs: toUnits(burnedByLogs),
    burnChecksAgree: agree,
    burnScanIncomplete: burnCheck.incomplete,
    sources: rows,
  };

  const historyDir = `supply/history/${tokenCfg.symbol.toLowerCase()}`;
  await mkdir(path.join(ROOT, historyDir), { recursive: true });
  const fname = `${snapshot.fetchedAt.replace(/[:.]/g, "-")}.json`;
  await writeFile(path.join(ROOT, historyDir, fname), JSON.stringify(snapshot, null, 2));

  let index = [];
  try {
    index = await loadJson(`${historyDir}/index.json`);
  } catch {
    // First run for this token -- start a fresh index.
  }
  index.push({
    file: fname,
    fetchedAt: snapshot.fetchedAt,
    block: snapshot.block,
    onChainSupply: snapshot.onChainSupply,
    maxAbsPercentDelta: Math.max(
      0,
      ...rows.filter((r) => r.percentDelta != null).map((r) => Math.abs(r.percentDelta))
    ),
    burnChecksAgree: agree,
  });
  await writeFile(path.join(ROOT, historyDir, "index.json"), JSON.stringify(index, null, 2));

  console.log(`  wrote ${historyDir}/${fname}`);
}

main().catch((err) => {
  console.error("supply check failed:", err);
  process.exit(1);
});

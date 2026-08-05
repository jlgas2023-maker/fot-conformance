#!/usr/bin/env node
// Deliverable 1: FOT taxonomy scanner CLI. Usage:
//   node scanner/scan.mjs <token-config-name>   (default: taco)
//
// Writes scanner/results/<token>.json -- the current verdict for that
// token, matching scanner/verdict.schema.json. Not a dated-history series
// like supply/ and chainqa/ (this is a point-in-time classification you
// re-run to re-verify, not a drift-over-time metric), but IS overwritten
// on every run so `git log` on this one file is itself a real audit trail
// of every re-verification and whether the verdict ever changed.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runStaticChecks } from "./static.mjs";
import { runDynamicChecks } from "./dynamic.mjs";
import { classify } from "./classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function loadJson(relPath) {
  return JSON.parse(await readFile(path.join(ROOT, relPath), "utf8"));
}

async function main() {
  const tokenName = process.argv[2] || "taco";
  const tokenCfg = await loadJson(`config/tokens/${tokenName}.json`);
  const chainCfg = await loadJson(`config/chains/${tokenCfg.chain}.json`);

  console.log(`=== FOT taxonomy scan: ${tokenCfg.symbol} on ${chainCfg.name} ===`);

  const [staticChecks, dynamicChecks] = await Promise.all([
    runStaticChecks(tokenCfg, chainCfg),
    runDynamicChecks(tokenCfg, chainCfg),
  ]);
  const checks = [...staticChecks, ...dynamicChecks];
  const { verdict, reason } = classify(checks);

  console.log(`  verdict: ${verdict} (${reason.join(", ")})`);
  for (const c of checks) {
    console.log(`  [${c.kind}] ${c.id}: ${JSON.stringify(c.result)}`);
  }

  const output = {
    token: tokenCfg.address,
    symbol: tokenCfg.symbol,
    chain: chainCfg.name,
    checkedAt: new Date().toISOString(),
    verdict,
    verdictReason: reason,
    checks,
  };

  const resultsDir = "scanner/results";
  await mkdir(path.join(ROOT, resultsDir), { recursive: true });
  await writeFile(path.join(ROOT, resultsDir, `${tokenName}.json`), JSON.stringify(output, null, 2));
  console.log(`  wrote ${resultsDir}/${tokenName}.json`);
}

main().catch((err) => {
  console.error("scan failed:", err);
  process.exit(1);
});

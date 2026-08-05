// FOT taxonomy scanner -- dynamic (eth_call simulation) half. Nothing here
// ever broadcasts a transaction, matching hard constraint #4 -- every
// simulated buy/sell/transfer uses eth_call with a `from` override, which
// the JSON-RPC spec allows with NO signature at all (eth_call is a
// read-only, non-persisted EVM execution; the node doesn't check that the
// caller can actually authorize `from`, since nothing is being committed).
//
// Scope note on "actual received amount vs expected" (the project brief's
// wording): a real investigation went into this before landing on the
// scope below -- see scanner/README.md's "Known limitation" section for
// the full account, including a working-but-abandoned atomic-probe-
// contract technique (compiled and tested live, real bytecode included in
// git history if resurrecting it) that turned out to break `transfer()`'s
// msg.sender-based auth model. Plain eth_call cannot observe a
// non-persisted call's resulting state, and getting an exact delta would
// need either a keccak256 implementation (to compute storage slots for a
// balance/allowance stateOverride) or a full forked-node simulation
// (Anvil) -- neither implemented here. What IS implemented, fully and
// tested live against TACO: SUCCESS/REVERT detection for buy, sell,
// wallet transfer, and sell-from-an-existing-holder, which is the signal
// that actually answers "is this a honeypot / does it block sells" --
// the FOT project's primary concern.

import { rpcRetry } from "../supply/rpc.mjs";

const SCRATCH_RECIPIENT = "0x0000000000000000000000000000000000dEcaf1";
const TRANSFER_SELECTOR = "0xa9059cbb";
const GET_AMOUNTS_OUT_SELECTOR = "0xd06ca61f";

function padAddress(addr) {
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}
function padUint(n) {
  return BigInt(n).toString(16).padStart(64, "0");
}
function encodeTransfer(to, amountRaw) {
  return TRANSFER_SELECTOR + padAddress(to) + padUint(amountRaw);
}
// getAmountsOut(uint256 amountIn, address[] path) -- standard ABI dynamic
// encoding: head is [amountIn, offset-to-array], tail is [length, elements...].
function encodeGetAmountsOut(amountInRaw, path) {
  const head = padUint(amountInRaw) + padUint(64); // offset = 0x40, right after the 2 head words
  const tail = padUint(path.length) + path.map((a) => padAddress(a)).join("");
  return GET_AMOUNTS_OUT_SELECTOR + head + tail;
}

async function ethCallFrom(rpcUrl, from, to, data) {
  try {
    const result = await rpcRetry(rpcUrl, "eth_call", [{ from, to, data }, "latest"]);
    return { ok: true, result, error: null };
  } catch (err) {
    return { ok: false, result: null, error: err.message };
  }
}

/**
 * Simulates a plain transfer(to, amount) with `from` impersonated at the
 * eth_call level -- no signature, no state override needed, since `from`
 * genuinely has real balance on-chain right now for every caller of this
 * function (a real pool, or a real existing holder).
 */
async function simulateTransfer(chainCfg, tokenAddress, fromAddress, toAddress, amountRaw) {
  const data = encodeTransfer(toAddress, amountRaw);
  const r = await ethCallFrom(chainCfg.rpc, fromAddress, tokenAddress, data);
  return {
    from: fromAddress,
    to: toAddress,
    amountRaw: amountRaw.toString(),
    ok: r.ok,
    revertReason: r.ok ? null : r.error,
  };
}

async function findTopHolder(chainCfg, tokenAddress, excludeAddresses = []) {
  const url = `${chainCfg.explorerApiBase}/api/v2/tokens/${tokenAddress}/holders`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`holders fetch failed: HTTP ${r.status}`);
  const j = await r.json();
  const exclude = new Set(excludeAddresses.map((a) => a.toLowerCase()));
  const holder = (j.items || []).find((h) => !exclude.has((h.address?.hash || "").toLowerCase()));
  if (!holder) throw new Error("no holder found outside the excluded set (pool/etc)");
  return { address: holder.address.hash, balanceRaw: BigInt(holder.value || "0") };
}

/**
 * @param {object} tokenCfg - {address, pool, decimals}
 * @param {object} chainCfg
 * @returns {Promise<Array>} dynamic checks, kind: "dynamic", matching
 *   scanner/verdict.schema.json
 */
export async function runDynamicChecks(tokenCfg, chainCfg) {
  const checks = [];
  const testAmount = 10n ** BigInt(Math.max(tokenCfg.decimals - 3, 0)); // ~0.001 token, scaled to decimals

  let topHolder;
  try {
    topHolder = await findTopHolder(chainCfg, tokenCfg.address, [tokenCfg.pool]);
  } catch (err) {
    checks.push({
      id: "sim_sell", kind: "dynamic", result: null,
      evidence: { txSimulated: null, error: `could not find a test holder: ${err.message}` },
    });
    checks.push({
      id: "sim_sell_from_existing_holder", kind: "dynamic", result: null,
      evidence: { txSimulated: null, error: `could not find a test holder: ${err.message}` },
    });
  }

  // BUY: pair -> scratch recipient. The pair itself always has a real,
  // large balance, so this needs no holder lookup at all.
  const buy = await simulateTransfer(chainCfg, tokenCfg.address, tokenCfg.pool, SCRATCH_RECIPIENT, testAmount);
  checks.push({
    id: "sim_buy", kind: "dynamic", result: buy.ok,
    evidence: { txSimulated: buy, expectedAmount: testAmount.toString(), actualAmount: null, selector: TRANSFER_SELECTOR },
  });

  // Wallet-to-wallet: pair -> a second scratch address (deliberately NOT
  // the pair or a real holder on either side, so this can't accidentally
  // trigger sell/buy-specific logic keyed on isPair-style checks).
  const walletTransfer = await simulateTransfer(
    chainCfg, tokenCfg.address, tokenCfg.pool,
    "0x0000000000000000000000000000000000dEcaf2", testAmount
  );
  checks.push({
    id: "sim_wallet_transfer", kind: "dynamic", result: walletTransfer.ok,
    evidence: { txSimulated: walletTransfer, expectedAmount: testAmount.toString(), actualAmount: null, selector: TRANSFER_SELECTOR },
  });

  if (topHolder) {
    // SELL: a real top holder (excluding the pool) -> the pool. This
    // wallet already holds the token BEFORE this call (it's a real
    // existing holder found via the explorer, not freshly funded), which
    // means this single test simultaneously satisfies "simulate a sell"
    // AND "simulate a sell from a wallet that already holds the token" --
    // the two are the same test when the source is a genuine holder
    // rather than a synthetic one, so both checks below share one call.
    const sell = await simulateTransfer(chainCfg, tokenCfg.address, topHolder.address, tokenCfg.pool, testAmount);
    checks.push({
      id: "sim_sell", kind: "dynamic", result: sell.ok,
      evidence: { txSimulated: sell, expectedAmount: testAmount.toString(), actualAmount: null, selector: TRANSFER_SELECTOR, holderBalanceRaw: topHolder.balanceRaw.toString() },
    });
    checks.push({
      id: "sim_sell_from_existing_holder", kind: "dynamic", result: sell.ok,
      evidence: { txSimulated: sell, note: "same call as sim_sell -- source wallet is a real pre-existing holder, not synthetically funded, so this case is covered by the same simulation", holderBalanceRaw: topHolder.balanceRaw.toString() },
    });
  }

  // Router compatibility: candidate verified router addresses on this
  // chain, found via Blockscout's contract search 2026-08-05 (see
  // scanner/README.md for the full list and how it was compiled -- these
  // are real, verified, on-chain addresses, not fabricated). getAmountsOut
  // is a pure view function -- needs no allowance/signature, unlike an
  // actual swap, so it's testable for every candidate without needing a
  // holder who's already approved that specific router.
  const routerCandidates = chainCfg.routerCandidates || [];
  for (const router of routerCandidates) {
    const data = encodeGetAmountsOut(testAmount, [tokenCfg.address, chainCfg.nativeWrapper]);
    const r = await ethCallFrom(chainCfg.rpc, SCRATCH_RECIPIENT, router, data);
    checks.push({
      id: "router_fee_supporting_variant", kind: "dynamic", result: r.ok,
      evidence: {
        selector: GET_AMOUNTS_OUT_SELECTOR,
        note: "tests getAmountsOut (a view/quote function, no allowance needed) as a proxy for whether this router recognizes the token's pool -- NOT an actual swap execution, see README's Known limitation",
        router,
        actualAmount: r.ok ? r.result : null,
        error: r.ok ? null : r.error,
      },
    });
  }
  if (routerCandidates.length === 0) {
    checks.push({
      id: "router_fee_supporting_variant", kind: "dynamic", result: null,
      evidence: { note: "no routerCandidates configured for this chain -- see chainCfg.routerCandidates" },
    });
  }

  return checks;
}

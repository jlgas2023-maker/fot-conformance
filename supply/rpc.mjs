// Minimal JSON-RPC + eth_getLogs chunking helper. No dependencies (Node 18+
// has global fetch) -- kept dependency-free on purpose so `node supply/
// check.mjs` runs with zero `npm install` step, matching the "no build
// step" hard constraint even though that constraint is really about the
// static hosting side, not CI.
//
// CHUNK=50000 and the retry/backoff shape are carried over verbatim from
// taco-burn/dist/stats.html's chunkLogs/rpcRetry, confirmed live on this
// chain: 200000-block chunks can exceed the RPC's hard 10000-log-per-call
// result cap during a busy range; 50000 stays comfortably under it.

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CHUNK = 50000;

export async function rpc(rpcUrl, method, params) {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || `${method} rpc error`);
  return j.result;
}

export async function rpcRetry(rpcUrl, method, params, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500 * i));
    try {
      return await rpc(rpcUrl, method, params);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export const ethCall = (rpcUrl, to, data, block = "latest") =>
  rpcRetry(rpcUrl, "eth_call", [{ to, data }, block]);

export async function blockNumber(rpcUrl) {
  return parseInt(await rpcRetry(rpcUrl, "eth_blockNumber", []), 16);
}

export function padAddress(addr) {
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

// Sum of a Transfer log's `value` (the non-indexed data field), as a BigInt
// -- callers divide by 10**decimals themselves so this stays exact
// (no float rounding) for supply-conformance arithmetic.
export function transferValue(log) {
  return BigInt(log.data);
}

/**
 * Chunked eth_getLogs over [fromBlock, toBlock] inclusive. Returns
 * {logs, incomplete, scannedThrough} -- scannedThrough is the last block
 * successfully covered by a chunk with no gap before it, so a caller doing
 * incremental scanning can safely checkpoint from there even if a later
 * chunk failed (never checkpoint past a gap).
 */
export async function getLogsChunked(rpcUrl, { address, topics, fromBlock, toBlock }) {
  const out = [];
  let incomplete = false;
  let scannedThrough = fromBlock - 1;
  for (let s = fromBlock; s <= toBlock; s += CHUNK) {
    const e = Math.min(s + CHUNK - 1, toBlock);
    try {
      const logs = await rpcRetry(rpcUrl, "eth_getLogs", [
        { address, topics, fromBlock: "0x" + s.toString(16), toBlock: "0x" + e.toString(16) },
      ]);
      out.push(...(logs || []));
      if (!incomplete) scannedThrough = e;
    } catch (err) {
      incomplete = true;
      console.warn(`getLogsChunked: gave up on ${s}-${e}: ${err.message}`);
      // Keep going -- a gap in the middle of the range shouldn't block
      // collecting logs from chunks after it, but scannedThrough freezes
      // at the last gap-free point so the checkpoint stays honest.
    }
  }
  return { logs: out, incomplete, scannedThrough };
}

export function transferLogsTopics({ from, to } = {}) {
  const t1 = from ? "0x" + padAddress(from) : null;
  const t2 = Array.isArray(to)
    ? to.map((a) => "0x" + padAddress(a))
    : to
    ? "0x" + padAddress(to)
    : null;
  return [TRANSFER_TOPIC, t1, t2];
}

export { TRANSFER_TOPIC };

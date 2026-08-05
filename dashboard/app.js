// Generic zero-backend token dashboard -- Deliverable 3. Ported from
// taco-burn/dist/stats.html (the TACO-hardcoded original, confirmed live
// on this chain) by replacing every hardcoded constant with a value from
// a fetched config.json (see config.schema.json). The RPC/log-scanning
// logic itself is carried over verbatim where it was already
// confirmed-live-correct there -- see inline notes for exactly which bugs
// those fixes were for, so a future edit doesn't accidentally reintroduce
// them.
//
// Loads ?config=<path> (default "./example.config.json", relative to this
// page) so one static page serves any token/chain without a rebuild.

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const CONFIG_URL = qs.get("config") || "./example.config.json";

let CFG; // populated by init()
let idc = 0;

async function rpc(method, params) {
  const r = await fetch(CFG.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++idc, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}
const call = (to, data, block = "latest") => rpc("eth_call", [{ to, data }, block]);
const padA = (a) => a.toLowerCase().replace("0x", "").padStart(64, "0");
const N = (hex, dec) => Number(BigInt(hex)) / 10 ** dec;

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO64 = "0x" + "0".repeat(64);

async function reserves(pair, block = "latest") {
  const r = (await call(pair, "0x0902f1ac", block)).slice(2);
  return {
    r0: BigInt("0x" + r.slice(0, 64)),
    r1: BigInt("0x" + r.slice(64, 128)),
    t0: ("0x" + (await call(pair, "0x0dfe1681", block)).slice(-40)).toLowerCase(),
  };
}

// USD pricing via a stable/native-wrapper pool (e.g. WETH/USDG) -- optional.
// A token whose config omits stablePool just won't show USD figures
// (dashboard degrades to native-currency-only display, not an error).
async function nativeUsd() {
  if (!CFG.stablePool) return null;
  const { r0, r1, t0 } = await reserves(CFG.stablePool);
  const stableIsT0 = t0 !== CFG.nativeWrapper.toLowerCase();
  // Assume the stable leg has 6 decimals (USDC/USDG convention) and the
  // wrapper has 18 -- true for every stable this chain currently has, but
  // flagged here since a future config with a different-decimals stable
  // would silently misprice without this comment as a pointer to fix it.
  const [u, w] = stableIsT0 ? [Number(r0) / 1e6, Number(r1) / 1e18] : [Number(r1) / 1e6, Number(r0) / 1e18];
  return w ? u / w : null;
}

async function tokenPriceNative(block = "latest") {
  const { r0, r1, t0 } = await reserves(CFG.pool, block);
  const wrapperIsT0 = t0 === CFG.nativeWrapper.toLowerCase();
  const [w, t] = wrapperIsT0 ? [Number(r0) / 1e18, Number(r1) / 10 ** CFG.decimals] : [Number(r1) / 1e18, Number(r0) / 10 ** CFG.decimals];
  return { native: w / t, weth: w, token: t };
}

/* ---- formatters ---- */
const fUsd = (v) => (v == null ? "--" : "$" + Math.round(v).toLocaleString());
const fM = (v) => (v / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "M";
function subPrice(p, unit = "$") {
  if (!isFinite(p) || p <= 0) return unit + "—";
  if (p >= 0.01) return unit + p.toPrecision(3);
  const [m, e] = p.toExponential(3).split("e");
  const exp = -parseInt(e);
  const digits = m.replace(".", "").replace(/0+$/, "");
  return unit + "0.0<sub>" + (exp - 1) + "</sub>" + digits;
}
function status(txt, err) {
  $("status").textContent = txt;
  $("dot").className = "dot" + (err ? " err" : "");
}
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const explorerAddr = (a) => `${CFG.explorerApiBase}/address/${a}`;
const explorerToken = () => `${CFG.explorerApiBase}/token/${CFG.token}`;
const explorerTx = (h) => `${CFG.explorerApiBase}/tx/${h}`;

/* ---- genesis supply: config value, or fall back to this repo's own
   supply/ Deliverable 2 output so the two deliverables share one source
   of truth instead of each hardcoding it separately (see dashboard/
   README.md point 3). ---- */
async function resolveGenesisSupply() {
  if (CFG.genesisSupply != null) return CFG.genesisSupply;
  try {
    const idx = await (await fetch(`../supply/history/${CFG.symbol?.toLowerCase() || "token"}/index.json`)).json();
    if (Array.isArray(idx) && idx.length) {
      const snap = await (await fetch(`../supply/history/${CFG.symbol.toLowerCase()}/${idx[idx.length - 1].file}`)).json();
      return snap.genesisSupply;
    }
  } catch {
    // No supply/ history for this token -- fine, just means genesisSupply
    // must come from config for this token instead.
  }
  return null;
}

/* ---- cheap live stats: price, fdv, liq, supply, burn, holders ---- */
async function loadCore() {
  const [nativeUsdPrice, genesis] = await Promise.all([nativeUsd(), resolveGenesisSupply()]);
  const { native, weth } = await tokenPriceNative();
  const priceUsd = nativeUsdPrice != null ? native * nativeUsdPrice : null;
  const supply = N(await call(CFG.token, "0x18160ddd"), CFG.decimals);
  const burned = genesis != null ? genesis - supply : null;
  const burnPct = genesis != null ? (burned / genesis) * 100 : null;
  const fdv = priceUsd != null ? priceUsd * supply : null;
  const liq = nativeUsdPrice != null ? weth * nativeUsdPrice * 2 : null;

  if (nativeUsdPrice != null) $("nativepx").innerHTML = `<a href="${explorerAddr(CFG.stablePool)}" target="_blank">native $${Math.round(nativeUsdPrice).toLocaleString()}</a>`;
  $("price").innerHTML = priceUsd != null ? `<a href="${explorerAddr(CFG.pool)}" target="_blank" style="color:inherit">${subPrice(priceUsd)}</a>` : subPrice(native, "");
  $("fdv").innerHTML = `<a href="${explorerToken()}" target="_blank" style="color:inherit">${fUsd(fdv)}</a>`;
  $("liq").innerHTML = `<a href="${explorerAddr(CFG.pool)}" target="_blank" style="color:inherit">${fUsd(liq)}</a>`;
  $("liqx").innerHTML = weth.toFixed(2) + " " + (CFG.nativeSymbol || "native");
  if (burnPct != null) {
    $("burnpct").textContent = burnPct.toFixed(2) + "%";
    $("burnx").textContent = Math.round(burned).toLocaleString() + " " + CFG.symbol;
    const ring = $("ring");
    ring.style.background = `conic-gradient(var(--burn) ${burnPct}%, var(--raise) 0)`;
    $("ringpct").textContent = burnPct.toFixed(1) + "%";
    const nextMs = Math.ceil((burnPct + 0.01) / 2.5) * 2.5;
    $("nextms").textContent = ((genesis * nextMs) / 100 / 1e6).toFixed(1) + "M (" + nextMs + "%)";
  } else {
    $("burnpct").textContent = "--";
    $("burnx").textContent = "no genesis supply configured";
  }
  $("supply").innerHTML = `<a href="${explorerToken()}" target="_blank" style="color:inherit">${Math.round(supply).toLocaleString()}</a>`;
  $("burnedtot").textContent = burned != null ? Math.round(burned).toLocaleString() : "--";
  $("genesisv").textContent = genesis != null ? genesis.toLocaleString() : "--";
  try {
    const hc = await (await fetch(`${CFG.explorerApiBase}/api/v2/tokens/${CFG.token}`)).json();
    if (hc.holders_count) $("holders").innerHTML = `<a href="${explorerToken()}?tab=holders" target="_blank" style="color:inherit">${hc.holders_count}</a>`;
  } catch {
    // Explorer holder count is a nice-to-have, not load-bearing -- leave
    // the "…" placeholder rather than erroring the whole KPI row.
  }
  return { priceUsd, native, supply, burned, burnPct, genesis };
}

/* ---- holder map ---- */
async function loadHolders(price, supply, genesis) {
  const d = await (await fetch(`${CFG.explorerApiBase}/api/v2/tokens/${CFG.token}/holders`)).json();
  const items = (d.items || []).slice(0, 12);
  if (!items.length) return;
  const rows = items.map((h) => {
    const addr = ((h.address || {}).hash || "").toLowerCase();
    const bal = Number(BigInt(h.value || "0")) / 10 ** CFG.decimals;
    // % of genesis (max) supply, matching CoinGecko/DexScreener convention
    // -- NOT % of current post-burn supply, which reads higher and
    // diverges further as more supply burns. Falls back to % of current
    // supply if no genesis figure is configured/derivable.
    const base = genesis || supply;
    return { addr, bal, pct: (bal / base) * 100, usd: price != null ? bal * price : null, meta: (CFG.labels || {})[addr] };
  });
  const max = rows[0].bal;
  $("holderst").innerHTML = rows
    .map((r) => {
      const name = r.meta ? r.meta.tag : "Holder";
      const cls = r.meta ? r.meta.class : "";
      const tag = r.meta ? `<span class="tag ${cls}">${cls}</span>` : "";
      const barcol =
        cls === "pool" ? "linear-gradient(90deg,#4a5030,#9a9c80)" :
        cls === "hold" ? "linear-gradient(90deg,#8a6a1f,var(--gold))" :
        cls === "founder" ? "linear-gradient(90deg,#7a9600,var(--lime))" :
        cls === "burn" ? "linear-gradient(90deg,#b8352c,var(--sell))" : "var(--line2)";
      return `<tr><td><div class="who"><a href="${explorerAddr(r.addr)}" target="_blank" class="lbl" style="color:var(--ink)">${name}</a> ${tag}<span class="adr">${short(r.addr)}</span></div></td>
      <td class="barcell"><div class="minibar"><i style="width:${((r.bal / max) * 100).toFixed(1)}%;background:${barcol}"></i></div></td>
      <td class="num">${r.pct.toFixed(2)}%</td><td class="num">${fM(r.bal)}</td><td class="num">${fUsd(r.usd)}</td></tr>`;
    })
    .join("");
  const top3 = rows.slice(0, 3).reduce((s, r) => s + r.pct, 0);
  $("holderinsight").innerHTML = `Top 3 addresses hold <b>${top3.toFixed(0)}%</b> of supply. The rest is the tradeable float.`;
}

/* ---- 24h flow: chunked getLogs, sequential (not concurrent) with
   retry+backoff per chunk -- see rpc.mjs's comment in supply/ for why
   200000-block chunks fail live on this chain and 50000 is the confirmed
   safe size, and stats.html's original comment for why concurrent
   sells/buys/burns queries silently dropped chunks under contention. ---- */
async function rpcRetry(method, params, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400 * i));
    try {
      return await rpc(method, params);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
async function chunkLogs(topics, from, to) {
  const CHUNK = 50000;
  let out = [];
  let incomplete = false;
  for (let s = from; s <= to; s += CHUNK) {
    const e = Math.min(s + CHUNK - 1, to);
    try {
      out = out.concat(
        (await rpcRetry("eth_getLogs", [{ address: CFG.token, topics, fromBlock: "0x" + s.toString(16), toBlock: "0x" + e.toString(16) }])) || []
      );
    } catch (err) {
      incomplete = true;
      console.warn("chunkLogs gave up on", s, "-", e, err);
    }
  }
  return { logs: out, incomplete };
}
async function findBlockAtTime(targetTs, latest) {
  let lo = 0, hi = latest;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ts = Number(BigInt((await rpcRetry("eth_getBlockByNumber", ["0x" + mid.toString(16), false])).timestamp));
    if (ts < targetTs) lo = mid + 1; else hi = mid;
  }
  return lo;
}

async function load24h(price, burnedTotal, genesis) {
  const latest = parseInt(await rpcRetry("eth_blockNumber", []), 16);
  const tNow = Number(BigInt((await rpcRetry("eth_getBlockByNumber", ["0x" + latest.toString(16), false])).timestamp));
  const from = await findBlockAtTime(tNow - 86400, latest);
  $("blockinfo").innerHTML = `<a href="${CFG.explorerApiBase}/blocks/${latest}" target="_blank" style="color:var(--dim)">block <b>${latest.toLocaleString()}</b></a>`;

  const sellsR = await chunkLogs([TRANSFER, null, "0x" + padA(CFG.pool)], from, latest);
  const buysR = await chunkLogs([TRANSFER, "0x" + padA(CFG.pool), null], from, latest);
  const burnAddrs = (CFG.burnAddresses && CFG.burnAddresses.length ? CFG.burnAddresses : ["0x0000000000000000000000000000000000000000"]).map((a) => "0x" + padA(a));
  const burnsR = await chunkLogs([TRANSFER, null, burnAddrs.length > 1 ? burnAddrs : burnAddrs[0]], from, latest);
  const sells = sellsR.logs, buys = buysR.logs, burns = burnsR.logs;
  const anyIncomplete = sellsR.incomplete || buysR.incomplete || burnsR.incomplete;

  const dec = CFG.decimals;
  const agg = (logs, topicIdx) => {
    const o = {};
    for (const l of logs) {
      const a = "0x" + l.topics[topicIdx].slice(-40);
      const v = Number(BigInt(l.data)) / 10 ** dec;
      o[a] = o[a] || [0, 0];
      o[a][0] += v;
      o[a][1]++;
    }
    return o;
  };
  const sMap = agg(sells, 1), bMap = agg(buys, 2);
  const sold = Object.values(sMap).reduce((s, v) => s + v[0], 0);
  const bought = Object.values(bMap).reduce((s, v) => s + v[0], 0);
  const burn24 = burns.reduce((s, l) => s + Number(BigInt(l.data)) / 10 ** dec, 0);

  const warn = anyIncomplete ? ' <span style="color:var(--sell)" title="Some data chunks failed even after retries -- numbers below may undercount.">⚠ partial data</span>' : "";
  $("soldv").innerHTML = fM(sold) + (price != null ? " · ~" + fUsd(sold * price) : "") + warn;
  $("boughtv").innerHTML = fM(bought) + (price != null ? " · ~" + fUsd(bought * price) : "") + (anyIncomplete ? warn : "");
  $("b24v").textContent = genesis ? fM(burnedTotal) + " / " + fM(genesis) : fM(burnedTotal);
  const mx = Math.max(sold, bought, 1);
  $("soldbar").style.width = (sold / mx) * 100 + "%";
  $("boughtbar").style.width = (bought / mx) * 100 + "%";
  $("b24bar").style.width = genesis ? (burnedTotal / genesis) * 100 + "%" : "0%";
  const net = bought - sold;
  $("net").innerHTML = `<span class="${net < 0 ? "neg" : "pos"}">${net < 0 ? "−" : "+"}${fM(Math.abs(net))}</span>`;
  $("stx").textContent = sells.length;
  $("btx").textContent = buys.length;
  $("burn24").textContent = fM(burn24);

  const ratio = bought > 0 ? sold / bought : Infinity;
  $("flowinsight").innerHTML =
    sold > bought
      ? `Selling outweighed buying <b>${ratio.toFixed(1)}:1</b> by volume — net <b>${fM(Math.abs(net))} ${CFG.symbol}</b> left holders, torching <b>${fM(burn24)}</b> in burns.`
      : `Buying outweighed selling — net <b>+${fM(net)} ${CFG.symbol}</b> accumulated.`;

  const renderSide = async (map, containerId, fillClass, negClass) => {
    const top = Object.entries(map).sort((a, b) => b[1][0] - a[1][0]).slice(0, 8);
    const bals = await Promise.all(top.map(([a]) => call(CFG.token, "0x70a08231" + padA(a)).then((x) => N(x, dec)).catch(() => null)));
    const tmax = top.length ? top[0][1][0] : 1;
    $(containerId).innerHTML =
      top
        .map(([a, v], i) => {
          const meta = (CFG.labels || {})[a];
          const drained = bals[i] != null && bals[i] < 10;
          const tag = meta ? `<span class="tag ${meta.class}">${meta.tag}</span>` : drained ? `<span class="tag gone">${negClass === "neg" ? "exited" : "flipped"}</span>` : "";
          return `<tr><td><div class="who"><a href="${explorerAddr(a)}" target="_blank" class="lbl" style="color:var(--ink)">${meta ? meta.tag : "Holder"}</a> ${tag}<span class="adr">${short(a)}</span></div></td>
      <td class="barcell"><div class="minibar"><i class="${fillClass}" style="width:${((v[0] / tmax) * 100).toFixed(1)}%"></i></div></td>
      <td class="num">${fM(v[0])}</td><td class="num">${v[1]}</td><td class="num ${negClass}">${price != null ? "~" + fUsd(v[0] * price) : "--"}</td></tr>`;
        })
        .join("") || `<tr><td colspan="5" class="loading">No activity in the last 24h.</td></tr>`;
  };
  await renderSide(sMap, "sellers", "fill-sell", "neg");
  await renderSide(bMap, "buyers", "fill-buy", "pos");

  try {
    const { native: nativeOld } = await tokenPriceNative("0x" + from.toString(16));
    const { native: nativeNow } = await tokenPriceNative();
    const chg = (nativeNow / nativeOld - 1) * 100;
    $("pricechg").innerHTML = `<span class="${chg < 0 ? "neg" : "pos"}">${chg < 0 ? "▼" : "▲"} ${Math.abs(chg).toFixed(1)}% / 24h</span>`;
  } catch {
    // 24h price-change is a bonus figure, not load-bearing.
  }
}

async function tick() {
  try {
    status("Reading chain…");
    const c = await loadCore();
    status("Live · updated " + new Date().toLocaleTimeString());
    return c;
  } catch (e) {
    status("Chain read failed — retrying…", true);
    throw e;
  }
}

async function init() {
  CFG = await (await fetch(CONFIG_URL)).json();
  document.title = `${CFG.symbol || "Token"} — Live On-Chain Stats`;
  $("tickername").textContent = CFG.symbol || CFG.token;
  $("cadisplay").textContent = "CA " + short(CFG.token);
  $("cadisplay").href = explorerToken();

  let c = await tick();
  // Holders and 24h-flow run independently of each other once core stats
  // are in, not chained -- neither blocks on the other (progressive
  // render requirement). Core itself IS a real dependency for both (they
  // need price/supply), so that one sequential step stays.
  loadHolders(c.priceUsd, c.supply, c.genesis).catch(() => {
    $("holderst").innerHTML = `<tr><td colspan="5" class="loading">Holder data unavailable right now.</td></tr>`;
  });
  load24h(c.priceUsd, c.burned, c.genesis).catch(() => {
    $("flowinsight").textContent = "24h flow unavailable right now — will retry.";
  });

  setInterval(async () => {
    try {
      c = await tick();
    } catch {
      // tick() already sets the error status; nothing else to do here.
    }
  }, 30000);
  setInterval(() => {
    if (c) load24h(c.priceUsd, c.burned, c.genesis).catch(() => {});
  }, 240000);
}

init().catch((e) => {
  status("Failed to load config from " + CONFIG_URL + ": " + e.message, true);
});

// 单个代币的完整成交 + K 线原始数据 + 交易者盈亏。只读。
//   数据源(逐个和链上核对过):
//     four Agent 模式:Core 的 TradeExecuted 事件(链上,从创建区块起增量拉)
//     Gang V1 / V2:gang.fun 成交接口,翻页拉全(抽查的交易发起人、代币到账数量都和链上 Transfer 一致)
//     Flap 内盘(Flap 曲线):fsi.taxed.fun 成交(买卖笔数、份额加总都和 Reader.marketDetail 链上数一致)
//     已开盘的外盘部分:DexScreener 找流动性最大的池子 → GeckoTerminal 分钟 K 线(美元;和链上储备算出的价差 < 1%)
//   统一输出:成交 { ts(秒), side, trader, tx, quote(底池币数量), tokens, price(每个代币多少底池币) },新的在前;
//   K 线点 { t, p(美元单价), v(美元成交额) },由前端按周期聚合;另给 supply 让前端换算市值。
import { ethers } from "ethers";
import { logRpc, HAS_PRIVATE, PUBLIC_WINDOW } from "./logrpc.mjs";
const c_partial = new Set();   // 只查到最近一段的 four 币(没配自己的节点)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { provider } from "./detect.mjs";
import { bnbUsd } from "./prices.mjs";

const CORE = "0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3";
const coreI = new ethers.Interface([
  "event TradeExecuted(address indexed token, address indexed trader, uint256 indexed presetId, bool isBuy, address quoteAsset, address vault, uint256 requestedTokenAmount, uint256 tokenAmount, uint256 curveQuoteAmount, uint256 traderQuoteAmount, uint256 lastPrice, uint256 slippageLimit, uint256 protocolFee, uint256 taxFee, uint256 devFee, uint256 antiSniperFee, uint256 totalRaised, uint256 remainingForSale)",
]);
const T_TRADE = coreI.getEvent("TradeExecuted").topicHash;
const fmt = (x) => Number(ethers.formatEther(x));
const here = (p) => fileURLToPath(new URL(p, import.meta.url));


// ---------- four:链上 TradeExecuted,从创建区块起;每个币记住拉到哪个块,下次只拉新的 ----------
const fourCache = new Map();   // ca → { last, rows, blockTs }
function createdBlockOf(ca) {
  try { return JSON.parse(readFileSync(here("./scan-cache.json"), "utf8")).four.tokens[ca]?.createdBlock ?? null; } catch { return null; }
}
// 同一个币同时只拉一次(K 线和成交列表会同时来要),否则两次增量会把同一段日志加两遍
const fourBusy = new Map();
function fourTrades(ca) {
  if (!fourBusy.has(ca)) fourBusy.set(ca, fourTradesOnce(ca).finally(() => fourBusy.delete(ca)));
  return fourBusy.get(ca);
}
async function fourTradesOnce(ca) {
  const head = parseInt(await logRpc("eth_blockNumber", []), 16);
  let c = fourCache.get(ca);
  if (!c) {
    // 从创建区块查起;没配自己的节点时公共节点只能查最近约 1 小时,更早的成交查不到(页面会提示)
    let from = createdBlockOf(ca) ?? head - 200_000;
    if (!HAS_PRIVATE && head - from > PUBLIC_WINDOW) { from = head - PUBLIC_WINDOW; c_partial.add(ca); }
    c = { last: from - 1, rows: [] };
    fourCache.set(ca, c);
  }
  const topic = ethers.zeroPadValue(ca, 32);
  for (let a = c.last + 1; a <= head; a += 5000) {
    const b = Math.min(a + 4999, head);
    const logs = await logRpc("eth_getLogs", [{ address: CORE, topics: [T_TRADE, topic], fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }]);
    c.seen ??= new Set();
    for (const l of logs) {
      const key = l.transactionHash + ":" + l.logIndex;
      if (c.seen.has(key)) continue;   // 去重:同一条日志只记一次
      c.seen.add(key);
      const d = coreI.parseLog(l).args;
      c.rows.push({ blk: parseInt(l.blockNumber, 16), li: parseInt(l.logIndex, 16), side: d.isBuy ? "buy" : "sell", trader: d.trader.toLowerCase(), tx: l.transactionHash,
        quote: fmt(d.traderQuoteAmount), tokens: fmt(d.tokenAmount), price: fmt(d.lastPrice) });
    }
    c.last = b;
  }
  // 区块号 → 时间:最新块时间戳 + 实测出块间隔
  const lb = await provider.getBlock("latest");
  const ob = await provider.getBlock(lb.number - 20000).catch(() => null);
  const per = ob ? (lb.timestamp - ob.timestamp) / (lb.number - ob.number) : 0.45;
  return c.rows.map((r) => ({ ...r, ts: Math.round(lb.timestamp - (lb.number - r.blk) * per) })).sort((a, b) => b.blk - a.blk || b.li - a.li);
}

// ---------- Gang:gang.fun 成交接口翻页 ----------
// 增量:已经拉过的成交记在内存里,之后从最新一页往回翻,翻到见过的成交就停(不用每次把几百笔全拉一遍)
const gangSeen = new Map();   // ca → 成交数组(新 → 旧)
const gKey = (t) => `${t.tx}:${t.trader}:${t.side}:${t.tokens}`;
function gangRow(t, v2) {
  const base = Number(v2 ? t.quoteIn : t.bnb), fee = v2 ? Number(t.taxPlat || 0) + Number(t.taxDiv || 0) : Number(t.fee || 0);
  return { ts: t.ts, side: t.side, trader: t.trader, handle: t.traderHandle || null, tx: t.tx, quote: t.side === "buy" ? base + fee : base, fee, tokens: Number(t.tokens), price: Number(t.price) };
}
async function gangTrades(ca, v2, max = 20000) {
  const old = gangSeen.get(ca), known = old ? new Set(old.map(gKey)) : null;
  const out = [];
  let hitOld = false;
  // 第一次拉:接口每页最多 200 笔、每次要 2~5 秒,按 4 页一批并发拉(到某一页不满 200 笔为止)
  if (!known) {
    const page = (off) => fetch(`https://gang.fun/api/${v2 ? "stocks/tokens" : "tokens"}/${ca}/trades?limit=200&offset=${off}&sort=ts_desc`, { signal: AbortSignal.timeout(20000) }).then((r) => r.json());
    const pages = [];
    for (let off = 0; off < max; off += 800) {
      const batch = await Promise.all([0, 200, 400, 600].map((d) => page(off + d)));
      pages.push(...batch);
      if (batch.some((j) => !j.hasMore || (j.items ?? []).length < 200)) break;
    }
    for (const j of pages) for (const t of j.items ?? []) out.push(gangRow(t, v2));
    const seen = new Set(), all = out.filter((t) => { const k = gKey(t); if (seen.has(k)) return false; seen.add(k); return true; });
    gangSeen.set(ca, all);
    if (gangSeen.size > 40) gangSeen.delete(gangSeen.keys().next().value);
    return all;
  }
  for (let off = 0; off < max && !hitOld;) {
    const j = await fetch(`https://gang.fun/api/${v2 ? "stocks/tokens" : "tokens"}/${ca}/trades?limit=200&offset=${off}&sort=ts_desc`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
    // 金额口径(用链上 Transfer / 发射台事件核对过):接口的 quoteIn(V2)/ bnb(V1)不含平台费 ——
    //   买入:交易者实际付出 = 金额 + 平台费(V2 还有分红税);卖出:金额就是实际到手。
    for (const t of j.items ?? []) out.push(gangRow(t, v2));
    if (known && out.some((t) => known.has(gKey(t)))) { hitOld = true; break; }
    if (!j.hasMore || !(j.items ?? []).length) break;
    off = j.nextOffset ?? off + (j.items ?? []).length;
  }
  let all = out;
  if (hitOld) { const fresh = out.filter((t) => !known.has(gKey(t))); all = fresh.concat(old); }
  gangSeen.set(ca, all);
  if (gangSeen.size > 40) gangSeen.delete(gangSeen.keys().next().value);
  return all;
}

// ---------- Flap 内盘:fsi.taxed.fun(按 market) ----------
async function fsiSide(market, ns) {
  const j = await fetch(`https://fsi.taxed.fun/fsi/v1/${market.toLowerCase()}/G/${ns}?sort=time_desc&limit=1000`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
  return (j.items ?? []).filter((x) => x.confirmed);
}
async function idagentTrades(market) {
  const [b, s] = await Promise.all([fsiSide(market, "virtualBuyFill"), fsiSide(market, "virtualSellFill")]);
  return [...b.map((x) => ({ x, side: "buy" })), ...s.map((x) => ({ x, side: "sell" }))].map(({ x, side }) => {
    const quote = Number(x.amount) / 1e18, tokens = Number(x.extra) / 1e18;
    return { ts: Number(x.updatedAt) < 1e12 ? Number(x.updatedAt) : Math.round(Number(x.updatedAt) / 1000), side, trader: x.actor.toLowerCase(), tx: x.txHash, quote, tokens, price: tokens ? quote / tokens : 0, blk: x.blockNumber, li: x.logIndex };
  }).sort((a, b) => b.blk - a.blk || b.li - a.li);
}

// ---------- 外盘:DexScreener 找池子 → GeckoTerminal 分钟 K 线(美元) ----------
const dexCache = new Map();
async function dexBars(ca) {
  const hit = dexCache.get(ca);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  let v = { bars: [], pool: null, priceUsd: null, mcapUsd: null, liqUsd: null };
  try {
    const ds = await fetch("https://api.dexscreener.com/tokens/v1/bsc/" + ca, { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
    const ps = (Array.isArray(ds) ? ds : []).filter((x) => x.baseToken?.address?.toLowerCase() === ca && Number(x.priceUsd)).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    if (ps[0]) {
      v = { bars: [], pool: ps[0].pairAddress, dex: ps[0].dexId, priceUsd: Number(ps[0].priceUsd), mcapUsd: Number(ps[0].marketCap || ps[0].fdv) || null, liqUsd: ps[0].liquidity?.usd ?? null };
      const g = await fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${v.pool}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${ca}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) }).then((r) => r.json()).catch(() => null);
      v.bars = (g?.data?.attributes?.ohlcv_list ?? []).map(([t, o, h, l, c, vol]) => ({ t, o, h, l, c, v: vol })).sort((a, b) => a.t - b.t);
    }
  } catch {}
  dexCache.set(ca, { at: Date.now(), v });
  return v;
}

// 底池币美元价:BNB / WBNB 用币安行情,其他用 DexScreener(缓存 60 秒)
const usdCache = new Map();
export async function quoteUsdOf(q, fallback) {
  if (!q || /^w?bnb$/i.test(q) || q === "0x0000000000000000000000000000000000000000" || q.toLowerCase() === "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c") return bnbUsd();
  if (fallback) return fallback;
  if (!ethers.isAddress(q)) return null;
  const k = q.toLowerCase(), hit = usdCache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const v = await dexBars(k).then((x) => x.priceUsd).catch(() => null);
  usdCache.set(k, { at: Date.now(), v });
  return v;
}

// ---------- 汇总 ----------
const allCache = new Map();   // ca → { at, v }
const histBusy = new Map();
// 有新成交推过来时,让这个币的缓存失效(下次请求就会带上新成交)
// 有新成交时只标成「过期」:下次请求先拿旧的(页面不用等),同时后台增量刷新
export function invalidate(ca) { const h = allCache.get(String(ca).toLowerCase()); if (h) h.at = 0; }
export function history(d, { wait = false } = {}) {
  const ca = d.ca.toLowerCase();
  const hit = allCache.get(ca);
  if (hit && Date.now() - hit.at < 8_000) return Promise.resolve(hit.v);
  if (!histBusy.has(ca)) histBusy.set(ca, historyOnce(d).finally(() => histBusy.delete(ca)));
  // 5 分钟内的旧结果先用着(后台已经在刷新);更旧的、或者要求等最新的,就等这一轮
  if (hit && !wait && Date.now() - hit.at < 300_000 || hit && hit.at === 0 && !wait) { histBusy.get(ca).catch(() => {}); return Promise.resolve(hit.v); }
  return histBusy.get(ca);
}
async function historyOnce(d) {
  const ca = d.ca.toLowerCase();
  let trades = [], source = null;
  if (d.platform === "four") { trades = await fourTrades(ca); source = "链上 TradeExecuted"; }
  else if (d.platform === "gangv1" || d.platform === "gangv2") { trades = await gangTrades(ca, d.platform === "gangv2"); source = "gang.fun"; }
  else if (d.platform === "idagent" && d.market) { trades = await idagentTrades(d.market); source = "fsi.taxed.fun"; }
  // 底池币美元价:Gang V2 用 gang 接口给的,Flap 内盘 的 quote 是地址
  const qUsd = await quoteUsdOf(d.platform === "gangv2" ? d.quote : d.quote, d.platform === "gangv2" ? d.quoteUsd : null);
  const supply = d.platform === "four" ? d.supply : d.platform?.startsWith("gang") || d.platform === "idagent" ? 1e9 : null;
  const dex = d.stage === "outer" ? await dexBars(ca) : null;
  const v = {
    source, partial: c_partial.has(ca), quote: d.quote, quoteUsd: qUsd, supply: supply ?? (dex?.mcapUsd && dex?.priceUsd ? dex.mcapUsd / dex.priceUsd : null),
    supplyNote: d.platform === "idagent" ? "Flap 内盘 按 1 份额 = 1 代币、总量 10 亿估算" : null,
    trades,
    points: qUsd ? trades.filter((t) => t.price > 0).map((t) => ({ t: t.ts, p: t.price * qUsd, v: t.quote * qUsd })).reverse() : [],
    dex,
  };
  allCache.set(ca, { at: Date.now(), v });
  if (allCache.size > 30) allCache.delete(allCache.keys().next().value);
  return v;
}

// 某个地址在这个币上的买卖和盈亏(金额是底池币单位,另给美元)
export async function traderStats(d, trader) {
  const h = await history(d);
  const me = trader.toLowerCase();
  const list = h.trades.filter((t) => t.trader === me).sort((a, b) => a.ts - b.ts);
  const sum = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
  const buys = list.filter((t) => t.side === "buy"), sells = list.filter((t) => t.side === "sell");
  const bT = sum(buys, "tokens"), bQ = sum(buys, "quote"), sT = sum(sells, "tokens"), sQ = sum(sells, "quote");
  // 持有量:非 Flap 内盘 读链上余额(更准,也算进了转入转出);Flap 内盘按成交算份额
  let hold = Math.max(0, bT - sT), holdSrc = "按成交推算";
  if (d.platform !== "idagent") {
    try {
      const i = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
      hold = fmt(i.decodeFunctionResult("balanceOf", await provider.call({ to: d.ca, data: i.encodeFunctionData("balanceOf", [trader]) }))[0]);
      holdSrc = "链上余额";
    } catch {}
  }
  const last = h.trades[0]?.price ?? 0;
  const avgBuy = bT ? bQ / bT : null;
  const realized = avgBuy != null ? sQ - avgBuy * Math.min(sT, bT) : sQ;
  const holdQ = hold * last, unreal = avgBuy != null ? holdQ - avgBuy * Math.min(hold, bT) : holdQ;
  return {
    trader: me, handle: list.find((t) => t.handle)?.handle ?? null, quote: d.quote, quoteUsd: h.quoteUsd,
    buys: buys.length, sells: sells.length, boughtTokens: bT, boughtQ: bQ, soldTokens: sT, soldQ: sQ, avgBuy, avgSell: sT ? sQ / sT : null,
    hold, holdSrc, holdQ, realized, unrealized: unreal, total: realized + unreal, pct: bQ ? ((realized + unreal) / bQ) * 100 : null,
    firstAt: list[0]?.ts ?? null, trades: list.slice(-200).reverse(),
  };
}

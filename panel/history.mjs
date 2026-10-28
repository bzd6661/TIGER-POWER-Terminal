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
import { gangJson } from "./upstream.mjs";
import { dataFile } from "./datadir.mjs";
const c_partial = new Set();   // 只查到最近一段的 four 币(没配自己的节点)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { provider } from "./detect.mjs";
import { bnbUsd } from "./prices.mjs";
import { flapTrades, isGatedKnown } from "./flapnft.mjs";
import { loadTrades, saveTrades, loadBars, saveBars, fetchJsonCached } from "./cache.mjs";

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
  try { return JSON.parse(readFileSync(dataFile("scan-cache.json"), "utf8")).four.tokens[ca]?.createdBlock ?? null; } catch { return null; }
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
    // 有历史缓存:从上次拉到的块往前 15 个块接着拉(防链重组,重复的按 tx:logIndex 去重)
    const ch = await loadTrades("four", ca);
    if (ch?.rows.length) {
      c = { last: ch.cursor - 15, rows: ch.rows, seen: new Set(ch.rows.map((r) => r.tx + ":" + r.li)) };
      fourCache.set(ca, c);
    }
  }
  if (!c) {
    // 从创建区块查起;没配自己的节点时公共节点只能查最近约 1 小时,更早的成交查不到(页面会提示)
    let from = createdBlockOf(ca) ?? head - 200_000;
    if (!HAS_PRIVATE && head - from > PUBLIC_WINDOW) { from = head - PUBLIC_WINDOW; c_partial.add(ca); }
    c = { last: from - 1, rows: [] };
    fourCache.set(ca, c);
  }
  const topic = ethers.zeroPadValue(ca, 32);
  const added = [];
  for (let a = c.last + 1; a <= head; a += 5000) {
    const b = Math.min(a + 4999, head);
    const logs = await logRpc("eth_getLogs", [{ address: CORE, topics: [T_TRADE, topic], fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }]);
    c.seen ??= new Set();
    for (const l of logs) {
      const key = l.transactionHash + ":" + l.logIndex;
      if (c.seen.has(key)) continue;   // 去重:同一条日志只记一次
      c.seen.add(key);
      const d = coreI.parseLog(l).args;
      const row = { blk: parseInt(l.blockNumber, 16), li: parseInt(l.logIndex, 16), side: d.isBuy ? "buy" : "sell", trader: d.trader.toLowerCase(), tx: l.transactionHash,
        quote: fmt(d.traderQuoteAmount), tokens: fmt(d.tokenAmount), price: fmt(d.lastPrice) };
      c.rows.push(row); added.push(row);
    }
    c.last = b;
  }
  // 只查到最近一段(公共节点)的不写缓存:下次配了自己的节点还能从头补全
  if (!c_partial.has(ca)) saveTrades("four", ca, added.map((r) => ({ ...r, ts: r.blk })), c.last, (r) => r.tx + ":" + r.li);
  // 区块号 → 时间:最新块时间戳 + 实测出块间隔
  const lb = await provider.getBlock("latest");
  const ob = await provider.getBlock(lb.number - 20000).catch(() => null);
  const per = ob ? (lb.timestamp - ob.timestamp) / (lb.number - ob.number) : 0.45;
  return c.rows.map((r) => ({ ...r, ts: Math.round(lb.timestamp - (lb.number - r.blk) * per) })).sort((a, b) => b.blk - a.blk || b.li - a.li);
}

// ---------- Gang:gang.fun 成交接口翻页 ----------
// 增量:已经拉过的成交记在内存里,之后从最新一页往回翻,翻到见过的成交就停(不用每次把几百笔全拉一遍)
const gangSeen = new Map();   // ca → 成交数组(新 → 旧)
// 内存里留多少个币的成交:公开版看的人多、币也多,留多一点,免得来回重拉
const CAP = process.env.AGENTBUY_PUBLIC === "1" ? 150 : 30;
const gKey = (t) => `${t.tx}:${t.trader}:${t.side}:${t.tokens}`;
function gangRow(t, v2) {
  const base = Number(v2 ? t.quoteIn : t.bnb), fee = v2 ? Number(t.taxPlat || 0) + Number(t.taxDiv || 0) : Number(t.fee || 0);
  return { ts: t.ts, side: t.side, trader: t.trader, handle: t.traderHandle || null, tx: t.tx, quote: t.side === "buy" ? base + fee : base, fee, tokens: Number(t.tokens), price: Number(t.price) };
}
async function gangTrades(ca, v2, max = 20000) {
  if (!gangSeen.has(ca)) { const ch = await loadTrades("gang", ca); if (ch?.cursor === 1 && ch.rows.length) gangSeen.set(ca, ch.rows); }
  const old = gangSeen.get(ca), known = old ? new Set(old.map(gKey)) : null;
  const out = [];
  let hitOld = false;
  // 第一次拉:接口每页最多 200 笔、每次要 2~5 秒,按 4 页一批并发拉(到某一页不满 200 笔为止)
  if (!known) {
    const page = (off) => gangJson(`https://gang.fun/api/${v2 === "v3" ? "v3/tokens" : v2 ? "stocks/tokens" : "tokens"}/${ca}/trades?limit=200&offset=${off}&sort=ts_desc`, 20000);
    const pages = [];
    for (let off = 0; off < max; off += 800) {
      const batch = await Promise.all([0, 200, 400, 600].map((d) => page(off + d)));
      pages.push(...batch);
      if (batch.some((j) => !j.hasMore || (j.items ?? []).length < 200)) break;
    }
    for (const j of pages) for (const t of j.items ?? []) out.push(gangRow(t, v2));
    const seen = new Set(), all = out.filter((t) => { const k = gKey(t); if (seen.has(k)) return false; seen.add(k); return true; });
    gangSeen.set(ca, all);
    saveTrades("gang", ca, all, all.length < max ? 1 : 0, gKey);   // 1 = 从开盘起拉全了
    if (gangSeen.size > CAP) gangSeen.delete(gangSeen.keys().next().value);
    return all;
  }
  for (let off = 0; off < max && !hitOld;) {
    const j = await gangJson(`https://gang.fun/api/${v2 === "v3" ? "v3/tokens" : v2 ? "stocks/tokens" : "tokens"}/${ca}/trades?limit=200&offset=${off}&sort=ts_desc`);
    // 金额口径(用链上 Transfer / 发射台事件核对过):接口的 quoteIn(V2)/ bnb(V1)不含平台费 ——
    //   买入:交易者实际付出 = 金额 + 平台费(V2 还有分红税);卖出:金额就是实际到手。
    for (const t of j.items ?? []) out.push(gangRow(t, v2));
    if (known && out.some((t) => known.has(gKey(t)))) { hitOld = true; break; }
    if (!j.hasMore || !(j.items ?? []).length) break;
    off = j.nextOffset ?? off + (j.items ?? []).length;
  }
  let all = out;
  if (hitOld) { const fresh = out.filter((t) => !known.has(gKey(t))); all = fresh.concat(old); saveTrades("gang", ca, fresh, 1, gKey); }
  gangSeen.set(ca, all);
  if (gangSeen.size > CAP) gangSeen.delete(gangSeen.keys().next().value);
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
// 更早的外盘 K 线(往前翻出来的页)不会再变:按池子单独缓存,每 30 秒刷新时只重拉最新一页
const oldBars = new Map();   // pool → { bars, at }
// GeckoTerminal 免费接口约 30 次 / 分钟(收藏栏每个外盘币都会定时拉 K 线,很容易超):
//   所有请求排成一队,两次之间至少隔 2.2 秒;碰到 429 就停 2 分钟(期间返回 null,调用方沿用旧数据)
let geckoLimitedUntil = 0, geckoQueue = Promise.resolve(), geckoLast = 0, geckoDepth = 0;
function gecko(pool, ca, tf, agg, before) {
  const url = `https://api.geckoterminal.com/api/v2/networks/bsc/pools/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=1000&currency=usd&token=${ca}${before ? "&before_timestamp=" + before : ""}`;
  // 队伍里已经排了 20 个(约 45 秒的量):这次不排了,调用方沿用旧 K 线(不然一个人刷很多币就能让所有人的外盘 K 线等好几分钟)
  if (geckoDepth >= 20) return Promise.resolve(null);
  geckoDepth++;
  const job = geckoQueue.then(async () => {
    if (Date.now() < geckoLimitedUntil) return null;
    const wait = geckoLast + 2200 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    geckoLast = Date.now();
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    if (r.status === 429) { geckoLimitedUntil = Date.now() + 120_000; console.error("[K线] GeckoTerminal 限流,暂停 2 分钟(外盘 K 线先用旧的)"); return null; }
    if (!r.ok) return null;
    const g = await r.json();
    return (g.data?.attributes?.ohlcv_list ?? []).map(([t, o, h, l, c, vol]) => ({ t, o, h, l, c, v: vol }));
  }).catch(() => null).finally(() => geckoDepth--);
  geckoQueue = job;
  return job;
}
// 最新一页之前到 since(内盘最后一笔)之间的 K 线:缺口 2 天以内按分钟线往前翻(最多 3 页);更长的直接用一页小时线(1000 根 ≈ 41 天)
async function backfill(pool, ca, firstT, since) {
  const k = pool.toLowerCase(), hit = oldBars.get(k);
  if (hit && (hit.bars.length ? hit.bars[hit.bars.length - 1].t >= firstT - 3600 : Date.now() - hit.at < 600_000)) return hit.bars;   // 翻不到更早的也记 10 分钟,别每次都去问
  // 缓存里已经有从 since 到 firstT 的 K 线(上次补过):直接用,不再问 GeckoTerminal
  const stored = (await loadBars(pool, since - 3600)).filter((b) => b.t < firstT);
  if (stored.length && stored[0].t <= since + 3600 && stored[stored.length - 1].t >= firstT - 3600) {
    oldBars.set(k, { bars: stored, at: Date.now() });
    return stored;
  }
  let bars = [], before = firstT, failed = false;
  if (firstT - since <= 2 * 86400) {
    for (let i = 0; i < 3 && before > since + 60; i++) {
      const pg = await gecko(pool, ca, "minute", 1, before);
      if (!pg) { failed = true; break; }
      const older = pg.filter((b) => b.t < before);
      if (!older.length) break;
      bars = bars.concat(older);
      before = Math.min(...older.map((b) => b.t));
    }
  } else {
    const pg = await gecko(pool, ca, "hour", 1, before);
    if (!pg) failed = true;
    else bars = pg.filter((b) => b.t < before && b.t + 3600 > since);
  }
  bars.sort((a, b) => a.t - b.t);
  if (bars.length) saveBars(pool, bars);
  if (!failed || bars.length) { oldBars.set(k, { bars, at: Date.now() }); if (oldBars.size > 30) oldBars.delete(oldBars.keys().next().value); }
  return bars;
}
// withBars=false:只要现价(底池币的美元价),不拉 K 线
async function dexBars(ca, since = null, withBars = true) {
  const key = withBars ? ca : ca + ":price", hit = dexCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;   // 60 秒:K 线 1 分钟一根,刷得更勤也没新东西,还容易被限流
  let v = { bars: [], pool: null, priceUsd: null, mcapUsd: null, liqUsd: null };
  try {
    const ds = await fetchJsonCached("https://api.dexscreener.com/tokens/v1/bsc/" + ca, 15, { timeout: 10000 });
    const ps = (Array.isArray(ds) ? ds : []).filter((x) => x.baseToken?.address?.toLowerCase() === ca && Number(x.priceUsd)).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    if (ps[0]) {
      v = { bars: [], pool: ps[0].pairAddress, dex: ps[0].dexId, priceUsd: Number(ps[0].priceUsd), mcapUsd: Number(ps[0].marketCap || ps[0].fdv) || null, liqUsd: ps[0].liquidity?.usd ?? null };
      // 被限流 / 超时(拿到 null)时沿用上一次的 K 线,不要把图清空成只剩内盘
      const fresh = withBars ? await gecko(v.pool, ca, "minute", 1, null) : [];
      if (fresh?.length) saveBars(v.pool, fresh);
      // 拿不到最新一页(限流 / 超时):用上一次的,没有就用缓存里最近 1000 分钟的
      v.bars = fresh ? fresh.sort((a, b) => a.t - b.t) : hit?.v?.bars ?? (await loadBars(v.pool, Math.floor(Date.now() / 1000) - 60_000));
      // 毕业早于最新一页:往前补,让内盘和外盘的 K 线接上
      if (since && v.bars.length && v.bars[0].t > since + 120) {
        const older = await backfill(v.pool, ca, v.bars[0].t, since);
        if (older.length) v.bars = older.filter((b) => b.t < v.bars[0].t).concat(v.bars);
      }
    }
  } catch {}
  dexCache.set(key, { at: Date.now(), v });
  if (dexCache.size > 100) dexCache.delete(dexCache.keys().next().value);
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
  const v = await dexBars(k, null, false).then((x) => x.priceUsd).catch(() => null);
  usdCache.set(k, { at: Date.now(), v });
  return v;
}

// ---------- 汇总 ----------
const allCache = new Map();   // ca → { at, v }
const histBusy = new Map();
// 同时最多拉几个币的成交(公开版 6 个、本地 50 个):很多人同时点开不同的币时排队,不把外部接口一下打爆
const HIST_MAX = process.env.AGENTBUY_PUBLIC === "1" ? 6 : 50;
let histActive = 0;
const histWait = [];
async function histSlot(fn) {
  if (histActive >= HIST_MAX) await new Promise((r) => histWait.push(r));
  histActive++;
  try { return await fn(); } finally { histActive--; histWait.shift()?.(); }
}
// 有新成交推过来时,让这个币的缓存失效(下次请求就会带上新成交)
// 有新成交 / 自己下完单时标成「过期」:下次请求等增量刷新完再返回(只拉最新一页,很快)
export function invalidate(ca) { const h = allCache.get(String(ca).toLowerCase()); if (h) h.at = 0; }
export function history(d, { wait = false } = {}) {
  const ca = d.ca.toLowerCase();
  const hit = allCache.get(ca);
  if (hit && Date.now() - hit.at < 8_000) return Promise.resolve(hit.v);
  if (!histBusy.has(ca)) histBusy.set(ca, histSlot(() => historyOnce(d)).finally(() => histBusy.delete(ca)));
  // 5 分钟内的旧结果先用着(后台已经在刷新);更旧的、或者要求等最新的,就等这一轮
  // 5 分钟内的旧结果先用着(后台已经在刷新)。但标成「过期」(有新成交 / 刚下完单)的要等这一轮刷新:
  //   增量刷新只拉最新一页,一般 1 秒内,换来的是自己刚下的单马上能在成交列表里看到
  if (hit && hit.at !== 0 && !wait && Date.now() - hit.at < 300_000) { histBusy.get(ca).catch(() => {}); return Promise.resolve(hit.v); }
  // 这一轮失败了(接口限流等)就先用旧数据,别让页面报错
  return histBusy.get(ca).catch((e) => { if (hit) return hit.v; throw e; });
}
async function historyOnce(d) {
  const ca = d.ca.toLowerCase();
  let trades = [], source = null;
  if (d.platform === "four") { trades = await fourTrades(ca); source = "链上 TradeExecuted"; }
  else if (d.platform === "gangv1" || d.platform === "gangv2" || d.platform === "gangv3") { trades = await gangTrades(ca, d.platform === "gangv3" ? "v3" : d.platform === "gangv2"); source = "gang.fun"; }
  else if (d.platform === "idagent" && d.market) { trades = await idagentTrades(d.market); source = "fsi.taxed.fun"; }
  // Flap Portal 盘(门槛盘):Portal 的 TokenBought / TokenSold 事件;已发射又不在门槛盘登记表里的不翻链(外盘部分走 K 线)
  else if (d.platform === "flapportal" && (d.stage === "inner" || isGatedKnown(ca))) { trades = await flapTrades(ca); source = "Flap Portal 链上事件"; if (!HAS_PRIVATE) c_partial.add(ca); }
  // 底池币美元价:Gang V2 用 gang 接口给的,Flap 内盘 的 quote 是地址
  const qUsd = await quoteUsdOf(d.platform === "flapportal" ? d.quoteAddress ?? "BNB" : d.quote, d.platform === "gangv2" || d.platform === "gangv3" || d.platform === "flapportal" ? d.quoteUsd : null);
  const supply = d.platform === "four" ? d.supply : d.platform?.startsWith("gang") || d.platform === "idagent" || d.platform === "flapportal" ? 1e9 : null;
  // 外盘 K 线要往前补到内盘最后一笔成交,毕业前后才接得上(trades 新的在前)
  const dex = d.stage === "outer" ? await dexBars(ca, trades[0]?.ts ?? null) : null;
  const v = {
    source, partial: c_partial.has(ca), quote: d.quote, quoteUsd: qUsd, supply: supply ?? (dex?.mcapUsd && dex?.priceUsd ? dex.mcapUsd / dex.priceUsd : null),
    supplyNote: d.platform === "idagent" ? "Flap 内盘 按 1 份额 = 1 代币、总量 10 亿估算" : null,
    trades,
    points: qUsd ? trades.filter((t) => t.price > 0).map((t) => ({ t: t.ts, p: t.price * qUsd, v: t.quote * qUsd })).reverse() : [],
    dex,
  };
  allCache.set(ca, { at: Date.now(), v });
  if (allCache.size > CAP) allCache.delete(allCache.keys().next().value);
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

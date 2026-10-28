// 只读数据的辅助函数:本地面板(server.mjs)和公开服务器(public-server.mjs)共用
import { detect } from "./detect.mjs";
import { tokenMeta } from "./scan.mjs";
import { history } from "./history.mjs";

// 从最近成交算:买/卖笔数、成交额、5 分钟 / 1 小时涨幅(价格是曲线价,底池币计价)
export function tradeStats(items) {
  if (!items?.length) return null;
  const now = Date.now() / 1000, last = items[0].price;
  const priceAt = (sec) => items.find((t) => t.ts <= now - sec)?.price;   // items 新的在前
  const chg = (sec) => { const p = priceAt(sec); return p > 0 && last > 0 ? (last / p - 1) * 100 : null; };
  const oldest = items[items.length - 1].ts;
  return {
    buys: items.filter((t) => t.side === "buy").length, sells: items.filter((t) => t.side === "sell").length,
    volume: items.reduce((a, t) => a + (t.quote || 0), 0), windowMin: Math.max(1, Math.round((now - oldest) / 60)), n: items.length,
    chg5m: chg(300), chg1h: chg(3600), lastPrice: last,
  };
}


// 最近一次识别结果(查币 / 下单都会更新):20 秒内下单直接用,省掉一次识别(0.4–2 秒)。
// 就算这 20 秒里刚好毕业,内盘脚本的链上模拟也会失败,不会买错。
const detectCache = new Map();
const detectBusy = new Map();   // 同一个币同时只识别一次(鼠标悬停预取 + 点击会撞在一起)
export async function detectCached(ca, maxAge = 20_000) {
  const k = ca.toLowerCase(), hit = detectCache.get(k);
  if (hit && Date.now() - hit.at < maxAge) return hit.d;
  if (!detectBusy.has(k)) detectBusy.set(k, detect(ca, { hint: tokenMeta(k)?.platform })
    .then((d) => { detectCache.set(k, { at: Date.now(), d }); if (detectCache.size > 2000) detectCache.delete(detectCache.keys().next().value); return d; }).finally(() => detectBusy.delete(k)));
  return detectBusy.get(k);
}
// Gang 交易附言:launch = 发币宣言;buy / sell = 多空对决。text 为空 + status sealed = 密封(24 小时内揭晓)
const notesCache = new Map();
export async function gangNotes(ca) {
  const hit = notesCache.get(ca);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const items = [];
  let before = null;
  for (let page = 0; page < 5; page++) {   // 最多 500 条
    const q = new URLSearchParams({ limit: "100", token: ca, withExpired: "1" });
    if (before !== null) q.set("before", String(before));
    const j = await fetch(`https://gang.fun/api/notes?${q}`, { signal: AbortSignal.timeout(12000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!j?.items) break;
    items.push(...j.items);
    if (!j.hasMore || j.next === null || j.next === undefined) break;
    before = j.next;
  }
  const slim = (n) => ({
    id: n.id, tx: n.tx, kind: n.kind, ts: n.ts, postedTs: n.postedTs, status: n.status, revealBy: n.revealBy,
    agent: n.agent?.address?.toLowerCase() ?? null, handle: n.agent?.handle ?? null,
    quote: n.trade?.quoteAmount ? Number(n.trade.quoteAmount) : null, quoteSymbol: n.trade?.quoteSymbol ?? null, usd: n.trade?.usd ?? null,
    text: n.text ?? null, conf: n.conf ?? null, changeNow: n.perf?.changeNow ?? null, peak: n.perf?.peak ?? null,
  });
  const launch = items.find((n) => n.kind === "launch");
  const v = { manifesto: launch ? slim(launch) : null, notes: items.filter((n) => n.kind === "buy" || n.kind === "sell").map(slim) };
  notesCache.set(ca, { at: Date.now(), v });
  if (notesCache.size > 50) notesCache.delete(notesCache.keys().next().value);
  return v;
}
// 收藏栏用:现价市值 + 24 小时涨跌。内盘用完整成交(美元价),外盘用 DexScreener 现价 + 分钟 K 线(最多约 16 小时,不够就从最早那根算)
const tickerCache = new Map();
export async function tickerOf(ca) {
  const hit = tickerCache.get(ca);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const d = await detectCached(ca, 120_000);
  const h = await history(d);
  const since = Date.now() / 1000 - 86400;
  let now = null, ref = null, from = null;
  if (d.stage === "outer" && h.dex?.priceUsd) {
    now = h.dex.priceUsd;
    const bars = h.dex.bars ?? [];
    const b = bars.find((x) => x.t >= since) ?? bars[0];
    if (b) { ref = b.o; from = b.t; }
  }
  const pts = h.points ?? [];   // 按时间从早到晚
  if (now === null && pts.length) now = pts[pts.length - 1].p;
  if (ref === null && pts.length) {
    let i = pts.findIndex((p) => p.t > since);
    const p = i > 0 ? pts[i - 1] : pts[0];
    ref = p.p; from = p.t;
  }
  const v = {
    symbol: d.symbol, stage: d.stage,
    mcUsd: now !== null && h.supply ? now * h.supply : d.mcUsd ?? null,
    change: now && ref ? (now / ref - 1) * 100 : null,
    since: from && from > since ? from : null,   // 不为空 = 币还不到 24 小时,涨跌是从这个时间(开盘)算的
  };
  tickerCache.set(ca, { at: Date.now(), v });
  if (tickerCache.size > 2000) tickerCache.delete(tickerCache.keys().next().value);
  return v;
}


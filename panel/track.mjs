// 钱包追踪:关注一些地址(.ai / .bnb 域名或直接填地址),实时显示它们在 four Agent / Gang / ID Agent 内盘上的买卖。
//   实时:直接用 live.mjs 已经在订阅的链上成交,按交易者筛出来,不额外轮询。
//   动作标签:用链上余额判断 —— 买之前是 0 = 建仓、否则加仓;卖完剩下不到 0.5% = 清仓、否则减仓(给出卖了持仓的百分之几)。
//            ID Agent 内盘看的是份额(sharesOf),其他看代币余额。
//   历史:新加一个地址时从链上补最近 24 小时(只写历史,不弹提示)。没配自己的节点时公共节点只能查约 1 小时,会标出来。
//   数据只存在本机:panel/track.json(关注列表)、panel/track-feed.jsonl(动态,保留 30 天、最多 5 万条)。
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { provider } from "./detect.mjs";
import { bus, TRADER_LOG_SOURCES, decodeLog, marketInfo } from "./live.mjs";
import { logRpc, LOG_STEP, HAS_PRIVATE, PUBLIC_WINDOW } from "./logrpc.mjs";
import { handleOf } from "./trades.mjs";
import { tokenMeta } from "./scan.mjs";
import { bawJson } from "./session.mjs";
import { bnbUsd } from "./prices.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const LIST = here("./track.json"), FEED = here("./track-feed.jsonl");
const FEED_DAYS = 30, FEED_MAX = 50_000;
const lc = (a) => String(a ?? "").toLowerCase();
const iface = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function sharesOf(address) view returns (uint256)", "function symbol() view returns (string)"]);
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };

let list = readJson(LIST, { targets: [], groups: ["默认"] });
if (!list.groups?.length) list.groups = ["默认"];
const saveList = () => { try { writeFileSync(LIST, JSON.stringify(list, null, 1)); } catch {} bus.emit("event", { type: "track-list" }); };
const targetOf = (a) => list.targets.find((t) => t.address === lc(a));

// 最近的动态放内存(新 → 旧),翻页时再读文件
let feed = [];
try { feed = readFileSync(FEED, "utf8").trim().split("\n").filter(Boolean).slice(-500).map((l) => JSON.parse(l)).reverse(); } catch {}
const feedIds = new Set(feed.map((e) => e.id));
function compact() {
  try {
    const cut = Date.now() / 1000 - FEED_DAYS * 86400;
    const lines = readFileSync(FEED, "utf8").trim().split("\n").filter(Boolean);
    const keep = lines.slice(-FEED_MAX).filter((l) => { try { return JSON.parse(l).ts >= cut; } catch { return false; } });
    if (keep.length < lines.length) writeFileSync(FEED, keep.join("\n") + (keep.length ? "\n" : ""));
  } catch {}
}
compact();

// ---------- 代币名字 ----------
const symCache = new Map();
async function symbolOf(ev) {
  if (ev.platform === "idagent") return marketInfo(ev.market)?.symbol || symCache.get(ev.ca) || ev.ca?.slice(0, 8) || "?";
  const m = tokenMeta(ev.ca);
  if (m?.symbol) return m.symbol;
  if (symCache.has(ev.ca)) return symCache.get(ev.ca);
  let s = ev.ca.slice(0, 8);
  try { s = iface.decodeFunctionResult("symbol", await provider.call({ to: ev.ca, data: iface.encodeFunctionData("symbol") }))[0]; } catch {}
  symCache.set(ev.ca, s);
  return s;
}
// 底池币名字:扫链缓存里有就用;Gang V2 没有就问一次 gang.fun(按币缓存);WBNB 当 BNB 算
const gangQuote = new Map();
async function quoteOf(ev) {
  let q = ev.quoteSym || (ev.platform === "gangv1" || ev.platform === "four" ? "BNB" : tokenMeta(ev.ca)?.quote);
  if (!q && ev.platform === "gangv2") {
    if (!gangQuote.has(ev.ca)) gangQuote.set(ev.ca, await fetch(`https://gang.fun/api/tokens/${ev.ca}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).then((d) => d?.quoteSymbol ?? "").catch(() => ""));
    q = gangQuote.get(ev.ca);
  }
  return /^w?bnb$/i.test(q ?? "") ? "BNB" : q || "";
}
// 现在的持仓(ID Agent 内盘看份额)
async function holding(ev, who) {
  try {
    if (ev.platform === "idagent" && ev.market) return Number(ethers.formatEther(iface.decodeFunctionResult("sharesOf", await provider.call({ to: ev.market, data: iface.encodeFunctionData("sharesOf", [who]) }))[0]));
    return Number(ethers.formatEther(iface.decodeFunctionResult("balanceOf", await provider.call({ to: ev.ca, data: iface.encodeFunctionData("balanceOf", [who]) }))[0]));
  } catch { return null; }
}
function label(side, tokens, after) {
  if (after === null) return { action: side === "buy" ? "买入" : "卖出", pct: null };
  if (side === "buy") { const before = Math.max(0, after - tokens); return { action: before <= tokens * 0.001 ? "建仓" : "加仓", pct: null }; }
  const before = after + tokens;
  return { action: after <= before * 0.005 ? "清仓" : "减仓", pct: before > 0 ? Math.min(100, (tokens / before) * 100) : null };
}
async function makeEvent(ev, t, extra = {}) {
  const sym = await symbolOf(ev), quote = await quoteOf(ev), px = quote === "BNB" ? await bnbUsd().catch(() => null) : null;
  return {
    id: `${ev.tx}:${ev.li ?? 0}`, ts: ev.ts, target: lc(ev.trader), targetName: t.name || null, group: t.group,
    side: ev.side, platform: ev.platform, ca: ev.ca, market: ev.market ?? null, symbol: sym, quote, quoteAmt: ev.quote, usd: px ? ev.quote * px : null,
    tokens: ev.tokens, tx: ev.tx, ...extra,
  };
}
function push(e, { live }) {
  if (feedIds.has(e.id)) return false;
  feedIds.add(e.id);
  feed.unshift(e); if (feed.length > 500) feed.length = 500;
  older = null;
  try { appendFileSync(FEED, JSON.stringify(e) + "\n"); } catch {}
  if (live) bus.emit("event", { type: "track", ...e });
  return true;
}

// ---------- 实时 ----------
bus.on("event", async (ev) => {
  if (ev.type !== "trade" || !ev.trader || !ev.ca) return;
  const t = targetOf(ev.trader); if (!t) return;
  const after = await holding(ev, lc(ev.trader));
  push(await makeEvent(ev, t, label(ev.side, ev.tokens, after)), { live: true });
});

// ---------- 历史回补(最近 24 小时) ----------
let backfilling = null;
const queue = new Set();
const status = { running: false, last: null };
export const trackStatus = () => ({ ...status, queued: [...queue] });
async function blockAt(sec, head, headTs) {
  // 用 head 和 head−20000 两个块估出块速度,再线性推算
  const b = await provider.getBlock(head - 20000);
  const per = (headTs - Number(b.timestamp)) / 20000;
  return Math.max(0, head - Math.ceil((headTs - sec) / per));
}
async function backfillOnce(addrs, hours = 24) {
  const hb = await provider.getBlock("latest");
  const head = hb.number, headTs = Number(hb.timestamp);
  let from = await blockAt(headTs - hours * 3600, head, headTs);
  let partial = false;
  if (!HAS_PRIVATE && head - from > PUBLIC_WINDOW) { from = head - PUBLIC_WINDOW; partial = true; }
  const lb = await provider.getBlock(from);
  const per = (headTs - Number(lb.timestamp)) / Math.max(1, head - from);
  const tsOf = (n) => Math.round(headTs - (head - n) * per);
  const pads = addrs.map((a) => ethers.zeroPadValue(a, 32).toLowerCase());
  const logs = [];
  for (let a = from; a <= head; a += LOG_STEP) {
    const b = Math.min(head, a + LOG_STEP - 1), range = { fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) };
    // 节点偶尔超时:每段最多试 3 次
    const get = async (filter) => { let err; for (let i = 0; i < 3; i++) { try { return await logRpc("eth_getLogs", [filter]); } catch (e) { err = e; await new Promise((r) => setTimeout(r, 1500)); } } throw err; };
    const [x, y] = await Promise.all([
      get({ ...range, address: TRADER_LOG_SOURCES.addresses, topics: [TRADER_LOG_SOURCES.topics, null, pads] }),
      get({ ...range, topics: [TRADER_LOG_SOURCES.idTopic, null, pads] }),
    ]);
    logs.push(...x, ...y);
  }
  const evs = logs.map((l) => decodeLog({ ...l, blockNumber: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16) }))
    .filter((e) => e?.type === "trade" && e.ca).sort((p, q) => p.blk - q.blk || p.li - q.li);
  // 动作标签:窗口里按时间累计;卖出时窗口里没看到足够的买入(之前买的),最后一笔用现在的余额判断是否清仓
  const run = new Map(), lastIdx = new Map();
  evs.forEach((e, i) => lastIdx.set(`${e.trader}|${e.ca}`, i));
  let added = 0;
  for (const [i, e] of evs.entries()) {
    const t = targetOf(e.trader); if (!t) continue;
    const k = `${e.trader}|${e.ca}`, before = run.get(k) ?? 0;
    let lab;
    if (e.side === "buy") { lab = { action: before <= e.tokens * 0.001 ? "建仓" : "加仓", pct: null }; run.set(k, before + e.tokens); }
    else if (before >= e.tokens * 0.99) { const after = before - e.tokens; lab = { action: after <= before * 0.005 ? "清仓" : "减仓", pct: Math.min(100, (e.tokens / before) * 100) }; run.set(k, after); }
    else {
      const now = lastIdx.get(k) === i ? await holding(e, e.trader) : null;
      lab = { action: now !== null && now <= e.tokens * 0.005 ? "清仓" : "减仓", pct: null }; run.set(k, 0);
    }
    if (push(await makeEvent({ ...e, ts: tsOf(e.blk) }, t, { ...lab, backfill: true }), { live: false })) added++;
  }
  if (added) {
    // 回补的是旧记录:按时间重排文件和内存
    try {
      const rows = readFileSync(FEED, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).sort((p, q) => p.ts - q.ts);
      writeFileSync(FEED, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      feed = rows.slice(-500).reverse(); older = null;
    } catch {}
  }
  const now = Date.now();
  for (const a of addrs) { const t = targetOf(a); if (t) { t.backfilledAt = now; t.backfillPartial = partial; } }
  saveList();
  return { trades: evs.length, added, partial, hours };
}
function backfill(addrs) {
  for (const a of addrs) queue.add(lc(a));
  if (backfilling) return backfilling;
  backfilling = (async () => {
    status.running = true;
    try {
      while (queue.size) {
        const batch = [...queue].slice(0, 20); batch.forEach((a) => queue.delete(a));
        const t0 = Date.now();
        try { const r = await backfillOnce(batch); status.last = { at: Date.now(), ms: Date.now() - t0, ...r }; }
        catch (e) { status.last = { at: Date.now(), ms: Date.now() - t0, error: e.message.slice(0, 200) }; console.error("[追踪] 历史回补失败", e.message); }
      }
    } finally { status.running = false; backfilling = null; bus.emit("event", { type: "track-list" }); }
  })();
  return backfilling;
}
export function startTrack() {
  const pending = list.targets.filter((t) => !t.backfilledAt).map((t) => t.address);
  if (pending.length) backfill(pending);
}

// ---------- 关注列表 ----------
// 输入可以是地址,也可以是 .ai / .bnb 等域名(用币安钱包解析)
async function resolve(input) {
  const v = String(input ?? "").trim();
  if (ethers.isAddress(v)) return { address: lc(v), domain: null };
  if (!/^[a-z0-9_.-]+\.[a-z]{2,}$/i.test(v)) throw new Error("填地址(0x…)或 .ai / .bnb 名字");
  const r = await bawJson("1", ["wallet", "resolve-domain", "--name", v, "--binanceChainId", "56"], 30_000);
  const a = r?.data?.address;
  if (!r?.success || !ethers.isAddress(a ?? "")) throw new Error(`解析不到 ${v}:${r?.error?.message ?? "没有这个名字"}`);
  return { address: lc(a), domain: v.toLowerCase() };
}
export function trackList() { return { ...list, status: trackStatus(), hasPrivate: HAS_PRIVATE }; }
export async function trackAdd({ input, name, remark, group }) {
  const { address, domain } = await resolve(input);
  const cur = targetOf(address);
  const handle = domain || (await handleOf(address).catch(() => null)) || null;
  const g = String(group || cur?.group || "默认").slice(0, 20);
  if (!list.groups.includes(g)) list.groups.push(g);
  const v = { address, name: String(name ?? cur?.name ?? handle ?? "").slice(0, 40), handle: handle ?? cur?.handle ?? null, remark: String(remark ?? cur?.remark ?? "").slice(0, 80), group: g, addedAt: cur?.addedAt ?? Date.now(), backfilledAt: cur?.backfilledAt ?? null };
  if (cur) Object.assign(cur, v); else list.targets.push(v);
  saveList();
  if (!cur) backfill([address]);
  return v;
}
export function trackUpdate({ address, name, remark, group }) {
  const t = targetOf(address); if (!t) throw new Error("没在关注这个地址");
  if (name !== undefined) t.name = String(name).slice(0, 40);
  if (remark !== undefined) t.remark = String(remark).slice(0, 80);
  if (group !== undefined) { const g = String(group || "默认").slice(0, 20); t.group = g; if (!list.groups.includes(g)) list.groups.push(g); }
  saveList();
  return t;
}
export function trackRemove({ address }) { list.targets = list.targets.filter((t) => t.address !== lc(address)); saveList(); return { ok: true }; }
export function trackGroup({ op, name }) {
  const g = String(name ?? "").trim().slice(0, 20);
  if (!g) throw new Error("分组名不能空");
  if (op === "add" && !list.groups.includes(g)) list.groups.push(g);
  if (op === "delete" && g !== "默认") { list.groups = list.groups.filter((x) => x !== g); for (const t of list.targets) if (t.group === g) t.group = "默认"; }
  saveList();
  return list;
}
export function trackRebackfill({ address }) { const t = targetOf(address); if (!t) throw new Error("没在关注这个地址"); backfill([t.address]); return { ok: true }; }

// 动态翻页:before(秒)之前的 limit 条,新 → 旧;可按地址 / 分组筛
let older = null;
export function trackFeed({ before, limit = 100, target, group } = {}) {
  if (!older) { try { older = readFileSync(FEED, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); } catch { older = []; } }
  const n = Math.min(500, Math.max(1, Number(limit) || 100)), b = Number(before) || Infinity;
  const ok = (e) => e.ts < b && (!target || e.target === lc(target)) && (!group || group === "all" || (targetOf(e.target)?.group ?? e.group) === group);
  const items = [];
  let i = 0;
  for (; i < older.length && items.length < n; i++) if (ok(older[i])) items.push(older[i]);
  const more = older.slice(i).some(ok);
  // 显示名用最新的(改过备注 / 名字后旧记录也跟着变)
  return { items: items.map((e) => ({ ...e, targetName: targetOf(e.target)?.name || e.targetName })), more };
}

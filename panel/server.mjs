#!/usr/bin/env node
// 内盘管理面板(本机网页):node panel/server.mjs  →  打开 http://127.0.0.1:4400
//   粘贴 CA → 自动识别平台(four.meme / Gang V1 / Gang V2 / Flap 内盘 / 其他)和内外盘 → 两个账号的持仓、现值、买 1% 要多少
//   → 点按钮买卖。下单全部转给已经测过的脚本(fourbuy/foursell、gangv1buy/gangv1sell、gangbuy/gangv2sell、fast/sell、dexbuy/dexsell),
//   每次下单前服务端会重新识别一次,按最新状态选脚本;脚本输出实时显示在页面上。
// 安全:只监听 127.0.0.1;校验 Host / Origin;所有 POST 要带页面里的随机令牌,别的网页没法替你下单。
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { detect } from "./detect.mjs";
import { walletsOverview, costsFor, noteToken } from "./wallets.mjs";
import { scan, scanLite, tokenMeta, refreshScan } from "./scan.mjs";
import { gzipSync } from "node:zlib";
import { tokenImage } from "./enrich.mjs";
import { recentTrades, handleOf } from "./trades.mjs";
import { history, traderStats, invalidate } from "./history.mjs";
import { startLive, bus, liveStatus } from "./live.mjs";
import { lists, op as listOp } from "./lists.mjs";
import { settings, setSettings, checkMaxBuy, approvals, revoke, quoteBalances, recordLatency, latencyStats, startAutoClaim } from "./extras.mjs";
import { tg } from "./autotransfer.mjs";

// ---------- 实时推送(SSE):链上新盘 / 成交 / 毕业 → 所有打开的页面 ----------
const streams = new Set();
bus.on("event", (ev) => {
  if (ev.type === "trade" && ev.ca) invalidate(ev.ca);
  if (ev.type === "launch" || ev.type === "graduate") refreshScan();
  // 自己的号在链上买了币:记下来,持仓列表马上能显示(不用等币安交易记录收录);Flap 内盘买的是份额,开盘后才有代币,不记
  if (ev.type === "trade" && ev.side === "buy" && ev.trader && ev.ca && ev.platform !== "idagent") {
    addresses().then((W) => { for (const [acct, a] of Object.entries(W)) if (a.toLowerCase() === ev.trader) noteToken(acct, ev.ca); }).catch(() => {});
  }
  const line = "data: " + JSON.stringify(ev) + "\n\n";
  for (const r of streams) r.write(line);
});
setInterval(() => { for (const r of streams) r.write(": ping\n\n"); }, 20_000);
import { addresses } from "./session.mjs";
import { sessions, loginStart, loginStatus, logout, unpin, startDropoutWatch } from "./session.mjs";
import { startTrack, trackList, trackAdd, trackUpdate, trackRemove, trackGroup, trackRebackfill, trackFeed } from "./track.mjs";
import { quote } from "./quote.mjs";
import { bnbUsd } from "./prices.mjs";
import { initCopy, copyState, copyTask, copyPauseAll } from "./copy.mjs";
import { startFlapNft } from "./flapnft.mjs";
import { cacheStatus } from "./cache.mjs";
import { startUpdateCheck, updateStatus } from "./update.mjs";
import { startAutoTransfer, list as atList, setWatch as atSet, target as atTarget, setTarget as atSetTarget, setAppConfirm as atSetAppConfirm } from "./autotransfer.mjs";

// 从最近成交算:买/卖笔数、成交额、5 分钟 / 1 小时涨幅(价格是曲线价,底池币计价)
function tradeStats(items) {
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

const PORT = Number(process.env.PANEL_PORT || 4400);
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const AGENTBUY = here("../");
const SHARE = here("../");   // four 脚本(fourbuy / foursell)就在 agentbuy 根目录
const BAW2_BIN = here("../baw2/bin");
// 页面令牌:第一次生成后存到本机 .panel-token,重启沿用(否则每次自动重启后,已打开的页面都会报「令牌不对」)
const TOKEN_FILE = here("./.panel-token");
const TOKEN = (() => {
  try { const t = readFileSync(TOKEN_FILE, "utf8").trim(); if (/^[0-9a-f]{48}$/.test(t)) return t; } catch {}
  const t = randomBytes(24).toString("hex");
  try { writeFileSync(TOKEN_FILE, t); } catch {}
  return t;
})();
const busy = new Set();   // 正在下单的账号,防止连点
// 最近一次识别结果(查币 / 下单都会更新):20 秒内下单直接用,省掉一次识别(0.4–2 秒)。
// 就算这 20 秒里刚好毕业,内盘脚本的链上模拟也会失败,不会买错。
const detectCache = new Map();
const detectBusy = new Map();   // 同一个币同时只识别一次(鼠标悬停预取 + 点击会撞在一起)
async function detectCached(ca, maxAge = 20_000) {
  const k = ca.toLowerCase(), hit = detectCache.get(k);
  if (hit && Date.now() - hit.at < maxAge) return hit.d;
  if (!detectBusy.has(k)) detectBusy.set(k, detect(ca, { hint: tokenMeta(k)?.platform })
    .then((d) => (detectCache.set(k, { at: Date.now(), d }), d)).finally(() => detectBusy.delete(k)));
  return detectBusy.get(k);
}
// Gang 交易附言:launch = 发币宣言;buy / sell = 多空对决。text 为空 + status sealed = 密封(24 小时内揭晓)
const notesCache = new Map();
async function gangNotes(ca) {
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
async function tickerOf(ca) {
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
  return v;
}

// 按识别结果选脚本;返回 { script, args, env? } 或抛错
function route(d, action, acct, arg, appConfirm = false) {
  const ca = d.ca, A = ["--acct", acct];
  // 按比例买:1pct / half,或自定义 p0.3(= 总量的 0.3%,0.01–1)
  const pctOf = arg === "1pct" ? 1 : arg === "half" ? 0.5 : /^p\d/.test(String(arg)) ? Number(String(arg).slice(1)) : null;
  const isPct = pctOf !== null;
  const bnb = isPct ? null : arg;
  if (action === "sell") {
    const pct = arg;
    if (d.platform === "four") return fourEnv(acct, { script: SHARE + "foursell.mjs", args: [ca, pct, "--slip", "10"] });
    if (d.platform === "idagent") return { script: AGENTBUY + "sell.mjs", args: [ca, pct, ...A] };
    if (d.stage === "outer") return { script: AGENTBUY + "dexsell.mjs", args: [ca, pct, ...A] };
    if (d.platform === "flapportal") return { script: AGENTBUY + "flapportal.mjs", args: ["sell", ca, pct, ...A] };
    if (d.platform === "gangv1") return { script: AGENTBUY + "gang/gangv1sell.mjs", args: [ca, "--pct", pct, ...A, ...(appConfirm ? ["--app-confirm"] : [])] };
    if (d.platform === "gangv2") return { script: AGENTBUY + "gang/gangv2sell.mjs", args: [ca, pct, ...A, ...(appConfirm ? ["--app-confirm"] : [])] };
    if (d.platform === "gangv3") return { script: AGENTBUY + "gang/gangv3.mjs", args: ["sell", ca, pct, ...A, ...(appConfirm ? ["--app-confirm"] : [])] };
    throw new Error("不知道怎么卖这个币");
  }
  // buy
  if (d.stage === "outer" || d.platform === "dex") {
    if (!bnb) throw new Error("外盘买入请填 BNB 数量");
    return { script: AGENTBUY + "dexbuy.mjs", args: [ca, bnb, ...A] };
  }
  if (d.platform === "four") {
    let budget = bnb;
    if (isPct) {
      const c = d.cost1pct ? d.cost1pct * pctOf : null;   // 买 1% 的报价 × 比例
      if (!c) throw new Error("报不出买 1% 的价格,请改填 BNB 数量");
      budget = (Math.ceil(c * 1.05 * 1e5) / 1e5).toFixed(5);   // 多带 5%,超过 1% 的部分脚本会自动卡住,多的退回
    }
    return fourEnv(acct, { script: SHARE + "fourbuy.mjs", args: [ca, budget] });
  }
  // Flap 普通 Portal / 门槛盘:按 BNB 买;按比例买用「买 1%」的估价折成 BNB(多带 5%,超过 2% 额度的部分同一笔退回)
  if (d.platform === "flapportal") {
    let amt = bnb;
    if (isPct) {
      const c = d.cost1pctBnb ? d.cost1pctBnb * pctOf : null;
      if (!c) throw new Error("报不出买 1% 的价格,请改填 BNB 数量");
      amt = (Math.ceil(c * 1.05 * 1e5) / 1e5).toFixed(5);
    }
    return { script: AGENTBUY + "flapportal.mjs", args: ["buy", ca, amt, ...A] };
  }
  if (d.platform === "gangv3") {
    if (!isPct) throw new Error("Gang 内盘请用「买 1% / 买 0.5%」");
    return { script: AGENTBUY + "gang/gangv3.mjs", args: ["buy", ca, ...(pctOf < 1 ? ["--tokens", String(Math.round(pctOf * 1e7))] : []), ...A] };
  }
  if (d.platform === "gangv1" || d.platform === "gangv2") {
    if (!isPct) throw new Error("Gang 内盘请用「买 1% / 买 0.5%」");
    const script = AGENTBUY + (d.platform === "gangv1" ? "gang/gangv1buy.mjs" : "gang/gangbuy.mjs");
    // 1% = 1000 万个(总量 10 亿);买 1% 时不传 --tokens,脚本按剩余额度买满
    return { script, args: [ca, ...(pctOf < 1 ? ["--tokens", String(Math.round(pctOf * 1e7))] : []), ...A] };
  }
  if (d.platform === "idagent") {
    if (!bnb) throw new Error("Flap 内盘请填 BNB 数量");
    return { script: AGENTBUY + "fast.mjs", args: [ca, bnb, ...A, "--wait"] };
  }
  throw new Error("不知道怎么买这个币");
}
// 跑下单脚本(手动下单和跟单共用):plans 来自 route();每行输出回调 onLine(账号, 行);
//   结束时返回 { worst, results: { 账号: { code, out } } }。调用前已经检查过登录和 busy,这里负责占用 / 释放 busy
function execOrder(d, action, plans, { arg, t0 = Date.now(), clientTs = null, onLine = () => {} } = {}) {
  plans.forEach((p) => busy.add(p.a));
  return new Promise((done) => {
    let left = plans.length, worst = 0;
    const results = {};
    for (const p of plans) {
      const env = p.env ?? process.env;
      if (p.fourAcct) env.FOURBUY_WALLET = d.wallets[p.fourAcct];
      onLine(p.a, `$ node ${p.script.split(/[\\/]/).slice(-2).join("/")} ${p.args.join(" ")}`);
      const out = [];
      const ps = spawn(process.execPath, [p.script, ...p.args], { env, cwd: AGENTBUY, windowsHide: true });
      // 耗时:预览通过、交易提交的时间点(相对服务器收到请求)
      const steps = {};
      const mark = (l) => {
        if (!steps.preview && /preview 通过|模拟:|已提交/.test(l)) steps.preview = Date.now() - t0;
        if (!steps.submitted && /已提交|txHash|0x[0-9a-f]{64}/i.test(l)) steps.submitted = Date.now() - t0;
      };
      const pipe = (st) => st.on("data", (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => { mark(l); if (out.length < 200) out.push(l); onLine(p.a, l); }));
      pipe(ps.stdout); pipe(ps.stderr);
      ps.on("close", (code) => {
        busy.delete(p.a);
        if (code === 0 && action === "buy" && d.platform !== "idagent") noteToken(p.a, d.ca);   // 外盘买的也记下,持仓列表马上能显示
        invalidate(d.ca);   // 自己下完单:成交列表 / K 线的缓存标成过期,下一次请求就会带上这笔
        recordLatency({ ts: Date.now(), platform: d.platform, stage: d.stage, action, acct: p.a, arg, ok: code === 0, ms: Date.now() - t0,
          clickToServer: Number(clientTs) > 0 ? Math.max(0, t0 - Number(clientTs)) : null, steps });
        worst = Math.max(worst, code ?? 1);
        results[p.a] = { code: code ?? 1, out, submitted: !!steps.submitted };
        onLine(p.a, code === 0 ? "✔ 结束" : `✘ 退出码 ${code}`);
        if (--left === 0) done({ worst, results });
      });
    }
  });
}
// 跟单下单:只用已登录的钱包;钱包正有单在跑就最多等 30 秒;买入按 BNB 数量,Gang 内盘换算成占总量的比例
async function copyOrder({ ca, action, accts, bnb, arg, slip }) {
  const ss = await sessions();
  const ok = accts.filter((a) => ss[a]?.connected);
  if (!ok.length) throw new Error("跟单选的钱包都没登录");
  for (let i = 0; i < 60 && ok.some((a) => busy.has(a)); i++) await new Promise((r) => setTimeout(r, 500));
  const free = ok.filter((a) => !busy.has(a));
  if (!free.length) throw new Error("钱包一直有单在跑,这次没跟");
  free.forEach((a) => busy.add(a));   // 马上占住,和检查之间没有 await
  let started = false;
  try {
  const d = await detectCached(ca, 4_000);
  if (action === "buy") {
    checkMaxBuy(bnb);
    if (d.stage === "inner" && d.platform?.startsWith("gang")) {
      const px = await bnbUsd();
      const per1 = d.quote === "BNB" ? d.cost1pct : d.cost1pct && d.quoteUsd && px ? (d.cost1pct * d.quoteUsd) / px : null;
      if (!per1) throw new Error("Gang 盘报不出买 1% 的价格");
      const pct = bnb / per1;
      if (pct < 0.01) throw new Error(`${bnb} BNB 不到总量 0.01%,Gang 内盘买不了这么少`);
      arg = "p" + Math.min(1, pct).toFixed(4);
    } else arg = String(bnb);
  }
  const plans = free.map((a) => ({ a, ...route(d, action, a, arg, false) }));
  if (Number(slip) > 0) for (const p of plans) {
    const i = p.args.indexOf("--slip");
    if (i >= 0) p.args[i + 1] = String(Number(slip)); else p.args.push("--slip", String(Number(slip)));
  }
  started = true;
  const r = await execOrder(d, action, plans, { arg });
  const results = {};
  for (const [a, x] of Object.entries(r.results)) results[a] = { ok: x.code === 0, submitted: x.submitted, last: x.out.slice(-2) };
  for (const a of ok.filter((a) => !free.includes(a))) results[a] = { ok: false, submitted: false, last: ["钱包一直有单在跑,跳过"] };
  for (const a of accts.filter((a) => !ok.includes(a))) results[a] = { ok: false, submitted: false, last: ["没登录,跳过"] };
  return { results, symbol: d.symbol };
  } finally { if (!started) free.forEach((a) => busy.delete(a)); }
}
// four 的脚本没有 --acct:用环境变量 AGENTBUY_ACCT 选账号 + FOURBUY_WALLET 给地址
function fourEnv(acct, cmd) {
  return { ...cmd, env: { ...process.env, AGENTBUY_ACCT: acct }, fourAcct: acct };
}

function guard(req) {
  const host = req.headers.host;
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(host)) throw new Error("Host 不允许");
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) throw new Error("Origin 不允许");
  if (req.method === "POST" && req.headers["x-panel-token"] !== TOKEN) throw new Error("令牌不对");
}
async function body(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 4096) throw new Error("请求太大"); }
  return JSON.parse(s || "{}");
}
// 大于 16 KB 的 JSON 用 gzip 压缩(扫链列表、K 线历史动辄几百 KB)
const json = (res, code, obj) => {
  const s = JSON.stringify(obj);
  if (s.length > 16_384 && /\bgzip\b/.test(res.req?.headers["accept-encoding"] ?? "")) {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-encoding": "gzip", vary: "accept-encoding" });
    return res.end(gzipSync(s, { level: 4 }));
  }
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(s);
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try { guard(req); } catch (e) { return json(res, 403, { error: e.message }); }
  try {
    // 钱包追踪页
    if (req.method === "GET" && req.url === "/track") {
      const html = readFileSync(here("./track.html"), "utf8").replace("__PANEL_TOKEN__", TOKEN);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; img-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(html);
    }
    // 钱包追踪:关注列表 / 动态(数据只在本机 panel/track.json、track-feed.jsonl)
    if (req.method === "POST" && req.url.startsWith("/api/track")) {
      const b = await body(req);
      if (req.url === "/api/track") return json(res, 200, trackList());
      if (req.url === "/api/track/add") return json(res, 200, await trackAdd(b));
      if (req.url === "/api/track/update") return json(res, 200, trackUpdate(b));
      if (req.url === "/api/track/remove") return json(res, 200, trackRemove(b));
      if (req.url === "/api/track/group") return json(res, 200, trackGroup(b));
      if (req.url === "/api/track/backfill") return json(res, 200, trackRebackfill(b));
      if (req.url === "/api/track/feed") return json(res, 200, trackFeed(b));
    }
    // 跟单:任务在本机 panel/copy-tasks.json;新建时目标还没追踪就先加进追踪列表(跟单靠追踪的实时动态触发)
    if (req.method === "POST" && req.url.startsWith("/api/copy")) {
      const b = await body(req);
      if (req.url === "/api/copy") return json(res, 200, copyState());
      if (req.url === "/api/copy/pause-all") return json(res, 200, copyPauseAll(!!b.paused));
      if (req.url === "/api/copy/tasks") {
        if (b.target !== undefined && !b.id) {
          if (!ethers.isAddress(b.target)) throw new Error("目标地址格式不对");
          if (!trackList().targets.some((t) => t.address === b.target.toLowerCase())) await trackAdd({ input: b.target });
          const t = trackList().targets.find((x) => x.address === b.target.toLowerCase());
          if (!b.name) b.name = t?.name || t?.handle || "";
        }
        return json(res, 200, copyTask(b));
      }
    }
    if (req.method === "GET" && req.url === "/scan") {
      const html = readFileSync(here("./scan.html"), "utf8").replace("__PANEL_TOKEN__", TOKEN);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; img-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(html);
    }
    // 本地图表库(TradingView Lightweight Charts 4.2.0,Apache-2.0,和官方发布文件逐字节一致)
    // 中英文切换(页面加载时最先执行)
    // 新版本提醒:页面脚本 + 状态(只读公开的版本号,不含任何本机信息,GET 不要令牌)
    // 三个页面共用:数字 / 时间格式、单色图标
    if (req.method === "GET" && (req.url === "/fmt.js" || req.url === "/icons.js")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(readFileSync(here("." + req.url)));
    }
    if (req.method === "GET" && req.url === "/update.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(readFileSync(here("./update.js")));
    }
    if (req.method === "GET" && req.url === "/api/update-status") return json(res, 200, updateStatus());
    if (req.method === "GET" && req.url === "/i18n.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(readFileSync(here("./i18n.js")));
    }
    // TM 图标(浏览器标签页)
    if (req.method === "GET" && (req.url === "/favicon.svg" || req.url === "/favicon.ico")) {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "private, max-age=86400" });
      return res.end(readFileSync(here("./favicon.svg")));
    }
    if (req.method === "GET" && req.url === "/vendor/lightweight-charts.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "private, max-age=86400" });
      return res.end(readFileSync(here("./vendor/lightweight-charts.js")));
    }
    const im = req.method === "GET" && req.url.match(/^\/img\/(0x[0-9a-f]{40})$/i);
    if (im) {
      const ca = im[1].toLowerCase();   // 页面可能传带大小写的地址,图片缓存按小写存
      const img = await tokenImage(ca, tokenMeta(ca)).catch(() => null);
      if (!img || !img.type) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": img.type, "cache-control": "private, max-age=86400" });
      return res.end(img.body);
    }
    // 实时推送:EventSource 不能带请求头,令牌放在查询参数里
    if (req.method === "GET" && req.url.startsWith("/api/stream")) {
      const t = new URL(req.url, "http://x").searchParams.get("t");
      if (t !== TOKEN) return json(res, 403, { error: "令牌不对" });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 3000\n\n");
      res.write("data: " + JSON.stringify({ type: "hello", live: liveStatus() }) + "\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (req.method === "GET" && req.url === "/api/live-status") return json(res, 200, liveStatus());
    if (req.method === "POST" && req.url === "/api/cache-status") return json(res, 200, await cacheStatus());
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { busy: busy.size });   // 守护进程重启前看有没有单在跑
    if (req.method === "POST" && req.url === "/api/scan") { const { force, lite } = await body(req); const d = await scan({ force: force === true }); return json(res, 200, lite === true ? scanLite(d) : d); }
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?"))) {
      const html = readFileSync(here("./index.html"), "utf8").replace("__PANEL_TOKEN__", TOKEN);
      // frame-src:K 线直接嵌 GMGN 的 gmgn.cc/kline 页面
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; img-src 'self'; frame-src https://www.gmgn.cc; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(html);
    }
    if (req.method === "POST" && req.url === "/api/trades") {
      const { ca, platform } = await body(req);
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      return json(res, 200, await recentTrades(ca, String(platform ?? "")));
    }
    // 鼠标悬停在列表里的币上:提前识别(结果缓存 4 秒,紧接着点击就不用等)
    if (req.method === "POST" && req.url === "/api/prefetch") {
      const { ca } = await body(req);
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      detectCached(ca, 4_000).then((d) => Promise.all([
        costsFor(d.ca, d.holdings),
        ["four", "gangv1", "gangv2", "gangv3"].includes(d.platform) ? recentTrades(d.ca, d.platform) : null,
      ])).catch(() => {});
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/inspect") {
      const { ca } = await body(req);
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      // 4 秒内识别过(比如鼠标悬停时预取过)就直接用:余额最多旧 4 秒,下单前还会再按链上数据校验
      const d = { ...(await detectCached(ca, 4_000)) };
      // 买入成本(从交易记录算)和最近成交(成交统计 + four 的市值)同时拉,不一个等一个
      const [costs, tr] = await Promise.all([
        costsFor(d.ca, d.holdings).catch(() => ({})),
        ["four", "gangv1", "gangv2", "gangv3"].includes(d.platform) ? recentTrades(d.ca, d.platform).catch(() => null) : null,
      ]);
      d.costs = costs;
      d.stats = tradeStats(tr?.items);
      if (d.platform === "four" || d.platform === "gangv1") d.quoteUsd = d.quoteUsd ?? (await bnbUsd());
      // Flap 内盘:市值按最新成交价 × 10 亿份额估算(和 K 线同一口径)
      if (d.platform === "idagent" && !d.mcUsd) {
        const h = await history(d).catch(() => null);
        const last = h?.points?.at(-1);
        if (last && h.supply) { d.mcUsd = last.p * h.supply; d.mcEstimated = true; }
        if (h?.trades?.[0]) d.lastTradeAt = h.trades[0].ts;
      }
      if (d.platform === "four") {
        const last = tr?.items?.[0];
        if (last && d.stage === "inner" && d.saleAmount) { d.progress = Math.min(100, ((d.saleAmount - last.remaining) / d.saleAmount) * 100); d.lastTradeAt = last.ts; }
        if (last) { d.priceQuote = last.price; d.mcUsd = last.price * d.supply * (d.quoteUsd ?? 0) || null; }
      }
      return json(res, 200, d);
    }
    // 登录:只给本机没登录的账号生成二维码;已登录的不会重新 signin
    if (req.method === "POST" && req.url.startsWith("/api/login/")) {
      const { acct } = await body(req);
      if (!["1", "2"].includes(acct)) throw new Error("账号不对");
      if (req.url === "/api/login/start") return json(res, 200, await loginStart(acct));
      if (req.url === "/api/login/status") return json(res, 200, loginStatus(acct));
      if (req.url === "/api/login/logout") return json(res, 200, await logout(acct));
      if (req.url === "/api/login/unpin") return json(res, 200, unpin(acct));   // 确实要换钱包:解除这个槽位的地址锁定
    }
    if (req.method === "POST" && req.url === "/api/quote") {
      const { ca, action, acct, arg, slip } = await body(req);
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      const d = await detectCached(ca, 10_000);   // 确认框里的报价顺便刷新识别,紧接着下单就不用再识别
      const s = Number(slip) > 0 ? Number(slip) : d.stage === "inner" ? (d.platform?.startsWith("gang") ? 5 : 30) : 10;
      return json(res, 200, { slip: s, ...(await quote(d, { action, acct: acct === "both" ? Object.keys(d.wallets)[0] : acct, arg: String(arg), slip: s })) });
    }
    // 发射后自动转出:目标地址只从本机 autotransfer.json 读,这里只能开 / 关某个币
    if (req.method === "POST" && req.url === "/api/autotransfer") return json(res, 200, atList());
    // 设 / 改 / 清空自动转出的目标地址:要两次输入一致
    if (req.method === "POST" && req.url === "/api/autotransfer/target") {
      const { to, to2 } = await body(req);
      if (String(to ?? "").trim().toLowerCase() !== String(to2 ?? "").trim().toLowerCase()) throw new Error("两次输入的地址不一致");
      const r = await atSetTarget(to, Object.values(await addresses()));
      bus.emit("event", { type: "notice", text: r.to ? `自动转出地址已设为 ${r.to.slice(0, 6)}…${r.to.slice(-4)}${r.turnedOff ? `,已关闭 ${r.turnedOff} 个开关,请重新打开` : ""}` : "自动转出地址已清空" });
      return json(res, 200, r);
    }
    // 中风险的转出是否提交去 App 确认
    if (req.method === "POST" && req.url === "/api/autotransfer/appconfirm") {
      const { on } = await body(req);
      return json(res, 200, { appConfirm: await atSetAppConfirm(on === true) });
    }
    if (req.method === "POST" && req.url === "/api/autotransfer/set") {
      const { ca, on } = await body(req);
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      if (on && !atTarget()) throw new Error("还没设目标地址:在 panel/autotransfer.json 里填 {\"to\": \"0x...\"}");
      const d = on ? await detectCached(ca) : null;
      return json(res, 200, { to: atTarget(), token: atSet(ca, on === true, d ? { symbol: d.symbol, platform: d.platform } : {}) });
    }
    // 自己画 K 线:完整成交(按美元的点)+ 外盘分钟 K 线 + 我自己的买卖点
    if (req.method === "POST" && req.url === "/api/history") {
      const { ca } = await body(req);
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      const d = await detectCached(ca);
      const h = await history(d);
      const mine = Object.fromEntries(Object.entries(await addresses()).map(([k, a]) => [a.toLowerCase(), k]));
      return json(res, 200, {
        source: h.source, partial: h.partial, quote: h.quote, quoteUsd: h.quoteUsd, supply: h.supply, supplyNote: h.supplyNote, points: h.points, dex: h.dex, total: h.trades.length,
        mine: h.trades.filter((t) => mine[t.trader]).map((t) => ({ t: t.ts, side: t.side, acct: mine[t.trader], quote: t.quote, tokens: t.tokens })),
      });
    }
    // Gang 的发币宣言 + 多空对决(交易附言):gang.fun /api/notes,30 秒缓存
    if (req.method === "POST" && req.url === "/api/notes") {
      const { ca } = await body(req);
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      return json(res, 200, await gangNotes(ca.toLowerCase()));
    }
    // 顶部收藏栏:每个币的现价市值 + 24 小时涨跌(不到 24 小时的币按开盘第一笔算),30 秒缓存
    if (req.method === "POST" && req.url === "/api/ticker") {
      const { cas } = await body(req);
      const list = (Array.isArray(cas) ? cas : []).filter((c) => ethers.isAddress(c)).slice(0, 30).map((c) => c.toLowerCase());
      const out = await Promise.all(list.map((ca) => tickerOf(ca).catch(() => null)));
      return json(res, 200, Object.fromEntries(list.map((ca, i) => [ca, out[i]])));
    }
    // 成交翻页:before = 时间戳(秒),拿比它早的 limit 笔;一直能翻到开盘第一笔
    if (req.method === "POST" && req.url === "/api/tradespage") {
      const { ca, before, limit } = await body(req);
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      const d = await detectCached(ca);
      const h = await history(d);
      const n = Math.min(500, Math.max(1, Number(limit) || 100));
      const start = before ? h.trades.findIndex((t) => t.ts < Number(before)) : 0;
      const items = start < 0 ? [] : h.trades.slice(start, start + n);
      // 没有名字的地址查一下 .ai(Agent ID 合约,有缓存)
      const need = [...new Set(items.filter((t) => !t.handle).map((t) => t.trader))];
      const names = await Promise.all(need.map((a) => handleOf(a).catch(() => null)));
      const nm = Object.fromEntries(need.map((a, i) => [a, names[i]]));
      return json(res, 200, { source: h.source, partial: h.partial, total: h.trades.length, end: start < 0 || start + n >= h.trades.length, items: items.map((t) => ({ ...t, handle: t.handle ?? nm[t.trader] ?? null })) });
    }
    if (req.method === "POST" && req.url === "/api/trader") {
      const { ca, trader } = await body(req);
      if (!ethers.isAddress(ca) || !ethers.isAddress(trader)) throw new Error("地址格式不对");
      const d = await detectCached(ca);
      const st = await traderStats(d, trader);
      st.handle ??= await handleOf(trader.toLowerCase()).catch(() => null);
      return json(res, 200, st);
    }
    // 收藏 / 屏蔽
    if (req.method === "POST" && req.url === "/api/lists") return json(res, 200, lists());
    if (req.method === "POST" && req.url === "/api/lists/op") { const b = await body(req); const v = listOp(b); bus.emit("event", { type: "lists" }); return json(res, 200, v); }
    // 设置 / 授权管理 / 底池币余额 / 耗时统计
    if (req.method === "POST" && req.url === "/api/settings") return json(res, 200, settings());
    if (req.method === "POST" && req.url === "/api/settings/set") return json(res, 200, setSettings(await body(req)));
    if (req.method === "POST" && req.url === "/api/approvals") return json(res, 200, await approvals());
    if (req.method === "POST" && req.url === "/api/approvals/revoke") {
      const { acct, token, spender, type } = await body(req);
      if (!["1", "2"].includes(acct)) throw new Error("账号不对");
      if (busy.has(acct)) throw new Error(`账号${acct} 还有一笔在跑`);
      busy.add(acct);
      try { return json(res, 200, await revoke(acct, token, spender, type)); } finally { busy.delete(acct); }
    }
    if (req.method === "POST" && req.url === "/api/quote-balances") return json(res, 200, await quoteBalances());
    if (req.method === "POST" && req.url === "/api/latency-stats") { const { days } = await body(req); return json(res, 200, latencyStats(Number(days) || 1)); }
    if (req.method === "POST" && req.url === "/api/wallets") { const { force } = await body(req); return json(res, 200, { ...(await walletsOverview({ force: force === true })), bnbUsd: await bnbUsd() }); }
    // 转账(账户总览里的转账面板):BNB 走币安钱包 send,代币走 transfer.mjs(preview 风控照常)。输出逐行流回页面
    if (req.method === "POST" && req.url === "/api/send") {
      const { acct, token, amount, to, appConfirm, dry } = await body(req);   // dry:只模拟(排查用)
      if (!["1", "2"].includes(acct)) throw new Error("账号不对");
      const isBnb = /^bnb$/i.test(String(token ?? ""));
      if (!isBnb && !ethers.isAddress(token)) throw new Error("代币地址不对");
      if (!ethers.isAddress(to)) throw new Error("收款地址不对");
      const amt = String(amount ?? "").trim();
      if (amt !== "max" && !(/^\d+(\.\d+)?$/.test(amt) && Number(amt) > 0)) throw new Error("数量不对");
      const ss = await sessions();
      if (!ss[acct]?.connected) throw new Error(`账号${acct} 在这台电脑上没登录`);
      if (busy.has(acct)) throw new Error(`账号${acct} 还有一笔在跑,等它结束`);
      const args = [isBnb ? "BNB" : token, "--to", to, "--acct", acct, "--amount", amt, ...(appConfirm === true && !isBnb ? ["--app-confirm"] : []), ...(dry === true ? ["--dry"] : [])];
      busy.add(acct);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-accel-buffering": "no" });
      res.write(`$ node transfer.mjs ${args.join(" ")}\n`);
      const ps = spawn(process.execPath, [here("../transfer.mjs"), ...args], { cwd: AGENTBUY, windowsHide: true });
      const pipe = (s) => s.on("data", (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => res.write(l + "\n")));
      pipe(ps.stdout); pipe(ps.stderr);
      ps.on("close", (code) => { busy.delete(acct); res.write(`${code === 0 ? "✔ 结束" : `✘ 退出码 ${code}`}\n__DONE__ ${code ?? 1}\n`); res.end(); });
      return;
    }
    // 打赏作者:合约地址 / 作者地址(contracts/tip.json),以及调用 tip.mjs 打赏(输出逐行流回页面)
    if (req.method === "POST" && req.url === "/api/tip-info") return json(res, 200, JSON.parse(readFileSync(here("../contracts/tip.json"), "utf8")));
    if (req.method === "POST" && req.url === "/api/tip") {
      const { acct, amount, memo, appConfirm, dry } = await body(req);
      if (!["1", "2"].includes(acct)) throw new Error("账号不对");
      const amt = String(amount ?? "").trim();
      if (!/^\d+(\.\d{1,8})?$/.test(amt) || !(Number(amt) > 0) || Number(amt) > 5) throw new Error("打赏数量要在 0–5 BNB 之间");
      const ss = await sessions();
      if (!ss[acct]?.connected) throw new Error(`账号${acct} 在这台电脑上没登录`);
      if (busy.has(acct)) throw new Error(`账号${acct} 还有一笔在跑,等它结束`);
      const args = [amt, "--acct", acct, ...(memo ? ["--memo", String(memo).slice(0, 140)] : []), ...(appConfirm === true ? ["--app-confirm"] : []), ...(dry === true ? ["--dry"] : [])];
      busy.add(acct);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-accel-buffering": "no" });
      const ps = spawn(process.execPath, [here("../tip.mjs"), ...args], { cwd: AGENTBUY, windowsHide: true });
      const pipe = (s) => s.on("data", (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => res.write(l + "\n")));
      pipe(ps.stdout); pipe(ps.stderr);
      ps.on("close", (code) => { busy.delete(acct); res.write(`__DONE__ ${code ?? 1}\n`); res.end(); });
      return;
    }
    if (req.method === "POST" && req.url === "/api/run") {
      const t0 = Date.now();
      const { ca, action, acct, arg, appConfirm, slip, clientTs } = await body(req);
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      if (!["buy", "sell"].includes(action)) throw new Error("action 不对");
      if (!["1", "2", "both"].includes(acct)) throw new Error("账号不对");
      if (action === "sell" && !(/^\d{1,3}$/.test(arg) && Number(arg) >= 1 && Number(arg) <= 100)) throw new Error("卖出比例不对(1–100 的整数)");
      if (slip !== undefined && slip !== null && slip !== "" && !(Number(slip) > 0 && Number(slip) <= 50)) throw new Error("滑点要在 0–50% 之间");
      const customPct = /^p\d+(\.\d{1,4})?$/.test(String(arg)) ? Number(String(arg).slice(1)) : null;
      if (customPct !== null && !(customPct >= 0.01 && customPct <= 1)) throw new Error("自定义比例要在 0.01%–1% 之间");
      if (action === "buy" && !(arg === "1pct" || arg === "half" || customPct !== null || (/^\d+(\.\d{1,8})?$/.test(arg) && Number(arg) > 0 && Number(arg) <= 5))) throw new Error("买入数量不对(BNB 最多 5)");
      const accts = acct === "both" ? ["1", "2"] : [acct];
      const ss = await sessions();
      for (const a of accts) if (!ss[a]?.connected) throw new Error(`账号${a} 在这台电脑上没登录`);
      for (const a of accts) if (busy.has(a)) throw new Error(`账号${a} 还有一笔在跑,等它结束`);
      // 检查完马上占住(和检查之间不能有 await,否则两个请求会同时通过);后面任何一步出错都要放开
      accts.forEach((a) => busy.add(a));
      let started = false;
      try {
      const d = await detectCached(ca);   // 20 秒内识别过就直接用
      // 单笔上限:按 BNB 买直接比;按比例买用报出来的花费(底池不是 BNB 的按美元价换算成 BNB)
      if (action === "buy") {
        let bnb = Number(arg);
        if (arg === "1pct" || arg === "half" || customPct !== null) {
          const cost = d.cost1pct ? d.cost1pct * (arg === "1pct" ? 1 : arg === "half" ? 0.5 : customPct) : null;
          const px = await bnbUsd();
          bnb = d.quote === "BNB" ? cost : cost && d.quoteUsd && px ? (cost * d.quoteUsd) / px : null;
        }
        checkMaxBuy(bnb);   // 算不出 BNB(bnb 为空)时,设了单笔上限就直接拒绝
      }
      const plans = accts.map((a) => ({ a, ...route(d, action, a, arg, appConfirm === true) }));
      // 选了滑点就加 --slip(不选用各脚本自己的默认值)
      if (Number(slip) > 0) for (const p of plans) {
        const i = p.args.indexOf("--slip");
        if (i >= 0) p.args[i + 1] = String(Number(slip)); else p.args.push("--slip", String(Number(slip)));
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-accel-buffering": "no" });
      res.write(`识别:${d.platformLabel} · ${d.stage === "inner" ? "内盘" : "外盘"} · ${d.symbol}\n`);
      started = true;
      execOrder(d, action, plans, { arg, t0, clientTs, onLine: (a, l) => res.write(`[账号${a}] ${l}\n`) })
        .then((r) => { res.write(`__DONE__ ${r.worst}\n`); res.end(); });
      return;
      } finally { if (!started) accts.forEach((a) => busy.delete(a)); }
    }
    json(res, 404, { error: "没有这个接口" });
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
    else res.end(`\n✘ ${e.message}\n__DONE__ 1\n`);
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`内盘管理面板已启动:http://127.0.0.1:${PORT}`);
  walletsOverview().catch(() => {});   // 启动就先算一遍账户总览,第一次打开页面不用等
  startAutoTransfer(busy);
  startUpdateCheck();   // 每 6 小时看一次 GitHub 上有没有重大更新
  startFlapNft().catch((e) => console.error("[Flap 门槛盘] 启动失败", e.message));   // 后台:发现门槛盘(首次往回补约 4 天)
  initCopy({ order: copyOrder, detect: (ca) => detectCached(ca, 20_000), notify: (text) => { tg(text); bus.emit("event", { type: "notice", text }); } });
  // 已登录的号掉线了:推页面(弹窗 + 提示音 + 浏览器通知)+ TG
  startDropoutWatch((acct, pin) => {
    bus.emit("event", { type: "dropout", acct, address: pin });
    tg(`⚠️ 账号${acct} 掉线了(币安钱包登录失效)${pin ? "\n<code>" + pin + "</code>" : ""}\n打开面板重新扫码登录`);
  });
  startLive().catch((e) => console.error("[实时] 启动失败", e.message)).finally(() => startTrack());   // Flap 内盘 市场表读好了再回补追踪历史
  // Flap 内盘 发射后自动领取(设置里打开才跑);结果推 TG + 页面提示
  startAutoClaim(busy, (text) => { tg(text); bus.emit("event", { type: "notice", text }); });   // 发射后自动转出(和下单共用 busy,同一个号不会同时下单和转账)
});

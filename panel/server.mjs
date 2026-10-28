#!/usr/bin/env node
// 内盘管理面板(本机网页):node panel/server.mjs  →  打开 http://127.0.0.1:4400
//   粘贴 CA → 自动识别平台(four.meme / Gang V1 / Gang V2 / Flap 内盘 / 其他)和内外盘 → 两个账号的持仓、现值、买 1% 要多少
//   → 点按钮买卖。下单全部转给已经测过的脚本(fourbuy/foursell、gangv1buy/gangv1sell、gangbuy/gangv2sell、fast/sell、dexbuy/dexsell),
//   每次下单前服务端会重新识别一次,按最新状态选脚本;脚本输出实时显示在页面上。
// 安全:只监听 127.0.0.1;校验 Host / Origin;所有 POST 要带页面里的随机令牌,别的网页没法替你下单。
//   官方网站(tigerpower.online)配对过的浏览器:由 weblink.mjs 的 webGate 验来源 + 配对令牌 + 接口白名单,下单另受网页限额约束;
//   网页请求转账 / 打赏 / 改设置 / 自动转出 / 解除地址锁定 / 改网页限额 / 开真实跟单 / 恢复跟单,要本机页面点「批准」才执行(webApprove)。
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { tradeStats, detectCached, gangNotes, tickerOf } from "./readapi.mjs";
import { startLive, bus, liveStatus } from "./live.mjs";
import { lists, op as listOp } from "./lists.mjs";
import { settings, setSettings, cleanSettings, checkMaxBuy, approvals, revoke, quoteBalances, recordLatency, latencyStats, startAutoClaim } from "./extras.mjs";
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
  // 每个推送按订阅范围过滤(weblink.mjs 的 streamSees):本机页面全看;网页看不到批准 / 配对 / 登录请求;scope=wallet 只给钱包私有事件
  for (const r of streams) if (streamSees(r.streamScope, ev.type)) r.write(line);
});
setInterval(() => { for (const r of streams) r.write(": ping\n\n"); }, 20_000);
import { addresses } from "./session.mjs";
import { sessions, loginStart, loginStatus, logout, unpin, startDropoutWatch } from "./session.mjs";
import { startTrack, trackList, trackAdd, trackUpdate, trackRemove, trackGroup, trackRebackfill, trackFeed } from "./track.mjs";
import { quote } from "./quote.mjs";
import { bnbUsd } from "./prices.mjs";
import { initCopy, copyState, copyTask, copyPauseAll, COPY_DEFAULTS } from "./copy.mjs";
import { startFlapNft } from "./flapnft.mjs";
import { cacheStatus } from "./cache.mjs";
import { startUpdateCheck, updateStatus } from "./update.mjs";
import { startAutoTransfer, list as atList, setWatch as atSet, target as atTarget, setTarget as atSetTarget, setAppConfirm as atSetAppConfirm } from "./autotransfer.mjs";
import { webGate, WEB_ORIGINS, checkWebBuy, recordWebBuy, clampWebSlip, logWebOrder, webCopyTaskPlan, checkCopyTaskUnchanged, webPausePolicy,
  webOrderPlan, webScrub, pendingPair, listPairs, revokePair, getWebLimits, setWebLimits, parseWebLimits, webSpentToday, recentWebOrders,
  approvalKind, describeApproval, webApproval, pairAlive, pendingApprovals, decideApproval, onApprovalChange, dropPairApprovals, streamSees,
  clientGone, clientGoneSignal, notApproved, APPROVAL_WAIT_TEXT, NOT_APPROVED, UNPAIRED_MSG, webLoginStatus } from "./weblink.mjs";

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
// 本机版本号(项目根目录 version.json 的 build):网页探测 /link/hello 时报给网页
const BUILD = (() => { try { return Number(JSON.parse(readFileSync(here("../version.json"), "utf8")).build) || 0; } catch { return 0; } })();
// 本机页面是哪一种(/link/hello 报给网页):full = 完整的本机面板(交易 / 扫链 / 追踪);helper = 本机助手(/ 只有扫码登录、配对码、批准框,
//   别的都在网站上做)。助手仓库里没有 index.html,自动是 helper;环境变量 PANEL_UI=helper|full 可以强制
const UI = ["helper", "full"].includes(process.env.PANEL_UI) ? process.env.PANEL_UI : existsSync(here("./index.html")) ? "full" : "helper";
// 网页请求配对:配对码只打在本机(这个窗口 / panel.log / 本机页面 /pair);实时推送只说「有人请求配对」,不带码(只推给本机页面,见 streamSees)
const onPairStart = (code, origin) => {
  console.log(`\n[网页连接] ===== 配对码:${code}(2 分钟内有效,来源 ${origin})=====\n`);
  bus.emit("event", { type: "linkpair", origin });
};
// 待批列表变了(网页新请求 / 本机点了批准或拒绝 / 超时):推给本机页面去刷新(不带内容,页面自己来取 /api/approve/pending)
onApprovalChange(() => bus.emit("event", { type: "approve" }));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const busy = new Set();   // 正在下单的账号,防止连点
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
    const vary = res.getHeader("vary");   // 网页请求闸门已经 setHeader 了 Vary: Origin,writeHead 里同名的头会盖掉它,所以合并
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-encoding": "gzip", vary: vary ? `${vary}, accept-encoding` : "accept-encoding" });
    return res.end(gzipSync(s, { level: 4 }));
  }
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(s);
};

// 下单脚本相对 agentbuy 根目录的路径(weblink.mjs 的 SCRIPT_DEFAULT_SLIP / webOrderPlan 按它认脚本;four 脚本的 SHARE 也是根目录)
const relScript = (s) => (s.startsWith(AGENTBUY) ? s.slice(AGENTBUY.length) : s).replace(/\\/g, "/");
// 发给网页的实时连接状态:lastError 里的节点网址 / key 去掉(本机页面照旧看完整的)
const webLive = () => { const l = liveStatus(); return { ...l, lastError: webScrub(l.lastError) }; };

// ---------- 网页请求要本机批准 ----------
// 哪些要批准由 weblink.mjs 的 approvalKind / webCopyTaskPlan / webPausePolicy 按「路径 + 请求体」定;本机页面的请求(req.web 没设)一律直接放行(true)。
//   params = 已经验过、马上要执行的那一份参数(批准框照它写,不用网页给的文字);onWait:进了队列之后马上调(文本流接口在这里写响应头 + 等待批准那一行)。
//   进队列走 weblink.mjs 的 webApproval:查地址的这几秒里网页连接被断开了 → 抛 401;同一个配对已经有 3 条在等 → 抛 429(这时都还没写任何响应);
//   网页断开(关页面 / 刷新)→ 这一条马上从本机待批列表撤掉;批准后配对已经断开 → 抛 401。返回 true = 批准,false = 拒绝 / 120 秒没人理 / 网页断开
async function webApprove(req, res, kind, params, onWait) {
  if (!req.web) return true;
  const ctx = { own: await addresses().catch(() => ({})), atTarget: atTarget(), limits: getWebLimits(), settings: settings(), copyDefaults: COPY_DEFAULTS };
  const { title, lines } = describeApproval(kind, params, ctx);
  const wait = webApproval({ kind, title, lines, origin: req.web.origin, pairId: req.web.pair.id }, { signal: clientGoneSignal(res) });
  onWait?.();
  return wait;
}
// JSON 接口用:本机请求或 kind 为 null(这次不用批准)→ true;没批准 → 抛 403 本机没有批准;批准了但网页已经断开 → false(调用方什么都不做)
async function webApproved(req, res, kind, params) {
  if (!req.web || !kind) return true;
  if (!(await webApprove(req, res, kind, params))) throw notApproved();
  return !clientGone(res);
}
// 文本流接口(转账 / 打赏)用,只给网页请求:先写响应头和「⏳ 等待本机助手批准…」一行,再等;没批准 → 「✘ 本机没有批准」。
//   批准后再查一遍:等的这段时间账号可能掉线了、或者被别的单占了(busy)、网页连接被断开了 → 「✘ …」;网页已经断开 → 什么都不执行。
//   返回 true = 可以开始了,而且这里已经占住了这个账号的 busy:查 busy 和占 busy 必须在同一段同步代码里 ——
//   要是留给调用方在 await 之后再占,两笔同时批准的转账会在这个空当里都通过检查(调用方再 add 一次没关系)
async function webStreamApprove(req, res, kind, params) {
  const ok = await webApprove(req, res, kind, params, () => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-accel-buffering": "no" });
    res.write(`${APPROVAL_WAIT_TEXT}\n`);
  });
  const fail = (msg) => { res.end(`✘ ${msg}\n__DONE__ 1\n`); return false; };
  if (!ok) return fail(NOT_APPROVED);
  if (clientGone(res)) return false;
  const { acct } = params;
  if (!(await sessions())[acct]?.connected) return fail(`账号${acct} 在这台电脑上没登录`);
  if (busy.has(acct)) return fail(`账号${acct} 还有一笔在跑,等它结束`);
  if (clientGone(res)) return false;
  if (!pairAlive(req.web.pair.id)) return fail(UNPAIRED_MSG);   // 查登录的这一下里网页连接被断开了
  busy.add(acct);
  return true;
}

// ---------- 代币页「我的」部分(/api/inspect、/api/history、/api/mine 共用) ----------
// 1 个底池币现在值多少 BNB:持仓盈亏统一按 BNB 显示用
async function quoteBnbOf(d) {
  const bnbPx = await bnbUsd().catch(() => null);
  return /^w?bnb$/i.test(d.quote ?? "BNB") ? 1 : d.quoteUsd && bnbPx ? d.quoteUsd / bnbPx : null;
}
// 成交里我自己账号的买卖点:[{ t, side, acct, quote, tokens }]
async function myTrades(h) {
  const mine = Object.fromEntries(Object.entries(await addresses()).map(([k, a]) => [a.toLowerCase(), k]));
  return h.trades.filter((t) => mine[t.trader]).map((t) => ({ t: t.ts, side: t.side, acct: mine[t.trader], quote: t.quote, tokens: t.tokens }));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // 网页闸门:官方网站发来的请求在这里验完来源 / 配对令牌 / 白名单(配对接口、预检、拒绝它自己回);本机请求原样交给 guard
  const w = await webGate(req, res, { port: PORT, build: BUILD, onPairStart, kind: UI });
  if (w.handled) return;
  if (w.web) req.web = w;   // { origin, pair }:跳过 guard(来源不是本机、也没有页面令牌)
  else try { guard(req); } catch (e) { return json(res, 403, { error: e.message }); }
  try {
    // 本机助手界面:/ 是助手页面(两个账号的扫码登录 + 配对码 / 批准框);交易 / 扫链 / 追踪页不提供,转回 /
    if (UI === "helper" && req.method === "GET") {
      if (req.url === "/" || req.url.startsWith("/?")) {
        const html = readFileSync(here("./helper.html"), "utf8").replace("__PANEL_TOKEN__", TOKEN);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; img-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
        return res.end(html);
      }
      if (/^\/(trade|scan|track)(\?|$)/.test(req.url)) { res.writeHead(302, { location: "/" }); return res.end(); }
    }
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
      let b = await body(req);
      if (req.url === "/api/copy") return json(res, 200, copyState());
      if (req.url === "/api/copy/pause-all") {
        // 网页:暂停随时可以;恢复(真实任务会接着用真钱下单)要本机批准
        if (req.web && webPausePolicy(b).approve && !(await webApproved(req, res, "copy-resume", {}))) return;
        return json(res, 200, copyPauseAll(!!b.paused));
      }
      if (req.url === "/api/copy/tasks") {
        // 网页:模拟任务随便建 / 改;开真实下单、改真实任务(只暂停 / 关闭 / 删除除外)要本机批准。
        //   webCopyTaskPlan 定要不要批准、批准框写什么、批准后执行什么:执行的就是批准框里那份完整参数(不再合到等批准期间被改过的任务上);
        //   改已有任务时,批准后 checkCopyTaskUnchanged 再核对一次任务没被改过(和 copyTask 之间没有 await),改过就报错不执行
        if (b.target !== undefined && !b.id && !ethers.isAddress(b.target)) throw new Error("目标地址格式不对");
        let plan = null;
        if (req.web) {
          plan = webCopyTaskPlan(b, copyState().tasks, { trackOf: (a) => trackList().targets.find((x) => x.address === a) });
          if (plan.approve && !(await webApproved(req, res, "copy-real", plan.card))) return;
          b = plan.execBody;
        }
        if (b.target !== undefined && !b.id) {
          if (!trackList().targets.some((t) => t.address === b.target.toLowerCase())) await trackAdd({ input: b.target });
          const t = trackList().targets.find((x) => x.address === b.target.toLowerCase());
          if (!b.name) b.name = t?.name || t?.handle || "";
        }
        if (plan) checkCopyTaskUnchanged(plan, copyState().tasks);
        return json(res, 200, copyTask(b));
      }
    }
    // 网页配对码(只在本机看;网页请求到不了这里:闸门对 /pair 回 404)。2 秒自动刷新,不许被别的网页嵌进框里
    if (req.method === "GET" && req.url === "/pair" && !req.web) {
      const p = pendingPair(), n = listPairs().length;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
      return res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>本地小助手 · 配对</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d12;color:#e8ebf0;font:15px system-ui,'Microsoft YaHei',sans-serif">
<div style="text-align:center"><div style="color:#f0b90b;font-weight:800;margin-bottom:10px">TIGER POWER 本地小助手</div>
${p ? `<div style="color:#9aa3b2">${esc(p.origin)} 请求配对,把这个码输进网页:</div><div style="font-size:48px;letter-spacing:10px;font-weight:800;margin:12px 0">${esc(p.code)}</div><div style="color:#9aa3b2;font-size:12px">${esc(p.expiresIn)} 秒内有效</div><div style="color:#f6465d;font-size:12px;margin-top:10px">不是你自己在网站上点的「连接本机助手」,就别把这个码给任何人</div>`
  : `<div style="color:#9aa3b2">现在没有配对请求。在网页上点「连接本机助手」后,配对码会显示在这里。</div>`}
${n ? `<div style="color:#16c784;margin-top:16px">已配对的浏览器:${n} 个</div>` : ""}</div>`);
    }
    // 网页连接管理:待配对的码 / 已配对的浏览器 + 限额 + 今天已用 + 最近网页下单 / 断开 / 改限额。
    //   待配对的码只在本机(闸门对网页 403,这里也不认网页);查状态 / 断开网页也能调;网页改限额要本机批准
    if (req.method === "POST" && req.url.startsWith("/api/link/")) {
      if (req.url === "/api/link/pending" && !req.web) return json(res, 200, pendingPair());
      if (req.url === "/api/link/state") return json(res, 200, { pairs: listPairs(), limits: getWebLimits(), spentToday: webSpentToday(), orders: recentWebOrders(30) });
      if (req.url === "/api/link/revoke") {
        const { id } = await body(req);
        // 先关掉这个浏览器开着的实时推送(它 3 秒后重连时令牌已作废,会被拒);写盘失败 revokePair 会抛错 → 下面的 catch 把错误报回页面
        for (const r of streams) if (r.webPairId && r.webPairId === id) { streams.delete(r); r.end(); }
        const ok = revokePair(id);
        if (ok) dropPairApprovals(id);   // 它还在等的批准一起作废(当作拒绝)
        return json(res, 200, { ok });
      }
      if (req.url === "/api/link/limits") {
        const b = await body(req);
        if (!req.web) return json(res, 200, setWebLimits(b));
        const p = parseWebLimits(b);   // 网页:先验好、转成数字,批准框和执行的是同一份
        if (!(await webApproved(req, res, approvalKind(req.url, b), p))) return;
        return json(res, 200, setWebLimits(p));
      }
    }
    // 网页请求的批准:待批列表 / 批准或拒绝(只在本机页面点;闸门对网页 403,这里也不认网页)
    if (req.method === "POST" && req.url === "/api/approve/pending" && !req.web) return json(res, 200, pendingApprovals());
    if (req.method === "POST" && req.url === "/api/approve/decide" && !req.web) {
      const { id, ok } = await body(req);
      return json(res, 200, { ok: decideApproval(String(id ?? ""), ok === true) });
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
    // 本机弹窗(配对码 / 网页请求的批准框 / 网页请求登录):本机页面共用,网站的页面里没有
    if (req.method === "GET" && req.url === "/localpop.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(readFileSync(here("./localpop.js")));
    }
    if (req.method === "GET" && req.url === "/api/update-status") {
      if (!req.web) return json(res, 200, updateStatus());
      const { dir, ...u } = updateStatus();   // 网页:不给本机的安装目录(带用户名)
      return json(res, 200, u);
    }
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
      const q = new URL(req.url, "http://x").searchParams;
      if (!req.web && q.get("t") !== TOKEN) return json(res, 403, { error: "令牌不对" });   // 网页的配对令牌闸门已经验过
      if (req.web) res.webPairId = req.web.pair.id;   // 断开这个网页连接时要把它的推送一起关掉
      // 订阅范围(bus 循环按它过滤):本机页面 local;网页 web,带 scope=wallet 的只要钱包私有事件(成交 / 新盘网页从网站服务器拿)
      res.streamScope = !req.web ? "local" : q.get("scope") === "wallet" ? "wallet" : "web";
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 3000\n\n");
      res.write("data: " + JSON.stringify({ type: "hello", live: req.web ? webLive() : liveStatus() }) + "\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (req.method === "GET" && req.url === "/api/live-status") return json(res, 200, req.web ? webLive() : liveStatus());
    if (req.method === "POST" && req.url === "/api/cache-status") {
      const cs = await cacheStatus();   // 网页:出错信息和数据库地址(带用户名 / 主机)都去掉网址
      return json(res, 200, req.web ? { ...cs, lastError: webScrub(cs.lastError), mysql: webScrub(cs.mysql) } : cs);
    }
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { busy: busy.size });   // 守护进程重启前看有没有单在跑
    if (req.method === "POST" && req.url === "/api/scan") { const { force, lite } = await body(req); const d = await scan({ force: force === true }); return json(res, 200, lite === true ? scanLite(d) : d); }
    // 交易页:/ 和 /trade 都是(页面里的链接用 /trade,和网站一致;网站的 / 是扫链页)
    if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?") || req.url === "/trade" || req.url.startsWith("/trade?"))) {
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
      d.quoteBnb = await quoteBnbOf(d);
      // 买入成本(从交易记录算)和最近成交(成交统计 + four 的市值)同时拉,不一个等一个
      const [costs, tr] = await Promise.all([
        costsFor(d.ca, d.holdings, d.quoteBnb).catch(() => ({})),
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
    // 网页代币页的「我的」部分:/api/inspect 里只和钱包有关的字段 + /api/history 的 mine(代币本身的数据网页从网站服务器拿)。
    //   trades: false = 只要持仓(网页合进 /api/inspect 用):不拉完整成交,冷门币也不用等,回的里面没有 mine。
    //   买卖点拉不到(成交接口出错)就给空的,持仓照样显示
    if (req.method === "POST" && req.url === "/api/mine") {
      const { ca, trades } = await body(req);
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      const d = await detectCached(ca, 4_000);   // 和 /api/inspect 一样:余额最多旧 4 秒
      const quoteBnb = await quoteBnbOf(d);
      const withTrades = trades !== false;
      const [costs, mine] = await Promise.all([
        costsFor(d.ca, d.holdings, quoteBnb).catch(() => ({})),
        withTrades ? history(d).then(myTrades).catch(() => []) : null,
      ]);
      const out = { ca: d.ca, wallets: d.wallets, holdings: d.holdings, costs, quoteBnb, nftGate: d.nftGate ? { wallets: d.nftGate.wallets } : null };
      if (withTrades) out.mine = mine;
      return json(res, 200, out);
    }
    // 登录:只给本机没登录的账号生成二维码;已登录的不会重新 signin
    if (req.method === "POST" && req.url.startsWith("/api/login/")) {
      const { acct } = await body(req);
      if (!["1", "2"].includes(acct)) throw new Error("账号不对");
      // 网页发不起登录:/api/login/start 在 weblink.mjs 的 LOCAL_ONLY 里,二维码只在本机面板显示(网页只能查状态 / 退出 / 请本机弹登录)
      if (req.url === "/api/login/start") return json(res, 200, await loginStart(acct));
      if (req.url === "/api/login/status") return json(res, 200, req.web ? webLoginStatus(loginStatus(acct)) : loginStatus(acct));   // 网页:不给二维码 / 扫码链接 / 配对码
      if (req.url === "/api/login/logout") return json(res, 200, await logout(acct));
      if (req.url === "/api/login/unpin") {   // 确实要换钱包:解除这个槽位的地址锁定(网页请求要本机批准)
        if (!(await webApproved(req, res, approvalKind(req.url), { acct }))) return;
        return json(res, 200, unpin(acct));
      }
      // 请本机页面弹出这个账号的扫码登录(只推「账号 N」给本机页面,二维码不回网页);helperPage = 有没有开着的本机页面(没开网页就提示去打开)
      if (req.url === "/api/login/request") {
        bus.emit("event", { type: "loginreq", acct });
        return json(res, 200, { ok: true, helperPage: [...streams].some((r) => r.streamScope === "local") });
      }
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
      const b = await body(req);
      const { to, to2 } = b;
      if (String(to ?? "").trim().toLowerCase() !== String(to2 ?? "").trim().toLowerCase()) throw new Error("两次输入的地址不一致");
      if (req.web) {
        // 网页:先验地址格式,再请本机批准(批准框写要设的地址,并标出是不是自己的;空 = 清空)
        const v = String(to ?? "").trim();
        if (v && !ethers.isAddress(v)) throw new Error("地址格式不对");
        if (!(await webApproved(req, res, approvalKind(req.url, b), { to: v }))) return;
      }
      const r = await atSetTarget(to, Object.values(await addresses()));
      bus.emit("event", { type: "notice", text: r.to ? `自动转出地址已设为 ${r.to.slice(0, 6)}…${r.to.slice(-4)}${r.turnedOff ? `,已关闭 ${r.turnedOff} 个开关,请重新打开` : ""}` : "自动转出地址已清空" });
      return json(res, 200, r);
    }
    // 中风险的转出是否提交去 App 确认(网页:打开要本机批准,关掉不用)
    if (req.method === "POST" && req.url === "/api/autotransfer/appconfirm") {
      const b = await body(req);
      const { on } = b;
      if (!(await webApproved(req, res, approvalKind(req.url, b), { on: on === true }))) return;
      return json(res, 200, { appConfirm: await atSetAppConfirm(on === true) });
    }
    // 某个币发射后自动转出的开关(网页:打开要本机批准,关掉不用)
    if (req.method === "POST" && req.url === "/api/autotransfer/set") {
      const b = await body(req);
      const { ca, on } = b;
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      if (on && !atTarget()) throw new Error("还没设目标地址:在 panel/autotransfer.json 里填 {\"to\": \"0x...\"}");
      if (!(await webApproved(req, res, approvalKind(req.url, b), { ca }))) return;
      const d = on ? await detectCached(ca) : null;
      return json(res, 200, { to: atTarget(), token: atSet(ca, on === true, d ? { symbol: d.symbol, platform: d.platform } : {}) });
    }
    // 自己画 K 线:完整成交(按美元的点)+ 外盘分钟 K 线 + 我自己的买卖点
    if (req.method === "POST" && req.url === "/api/history") {
      const { ca } = await body(req);
      if (!ethers.isAddress(ca)) throw new Error("CA 格式不对");
      const d = await detectCached(ca);
      const h = await history(d);
      const mine = await myTrades(h);
      return json(res, 200, {
        source: h.source, partial: h.partial, quote: h.quote, quoteUsd: h.quoteUsd, supply: h.supply, supplyNote: h.supplyNote, points: h.points, dex: h.dex, total: h.trades.length,
        mine,
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
    if (req.method === "POST" && req.url === "/api/settings/set") {
      const b = await body(req);
      if (!req.web) return json(res, 200, setSettings(b));
      const p = cleanSettings(b);   // 网页:先验好、转成数字,批准框和执行的是同一份
      if (!(await webApproved(req, res, approvalKind(req.url, b), p))) return;
      return json(res, 200, setSettings(p));
    }
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
      // 网页请求:先等本机批准(批准框照上面 args 用的同一份参数写);等完再查一遍登录和 busy,通过时已经占住 busy
      if (req.web && !(await webStreamApprove(req, res, "send", { acct, token: isBnb ? "BNB" : token, amount: amt, to, appConfirm: appConfirm === true && !isBnb, dry: dry === true }))) return;
      busy.add(acct);
      if (!res.headersSent) res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-accel-buffering": "no" });
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
      const note = memo ? String(memo).slice(0, 140) : null;   // 留言
      const args = [amt, "--acct", acct, ...(note !== null ? ["--memo", note] : []), ...(appConfirm === true ? ["--app-confirm"] : []), ...(dry === true ? ["--dry"] : [])];
      // 网页请求:先等本机批准(留言、App 确认也写进批准框);等完再查一遍登录和 busy,通过时已经占住 busy
      if (req.web && !(await webStreamApprove(req, res, "tip", { acct, amount: amt, ...(note !== null ? { memo: note } : {}), appConfirm: appConfirm === true, dry: dry === true }))) return;
      busy.add(acct);
      if (!res.headersSent) res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-accel-buffering": "no" });
      const ps = spawn(process.execPath, [here("../tip.mjs"), ...args], { cwd: AGENTBUY, windowsHide: true });
      const pipe = (s) => s.on("data", (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => res.write(l + "\n")));
      pipe(ps.stdout); pipe(ps.stderr);
      ps.on("close", (code) => { busy.delete(acct); res.write(`__DONE__ ${code ?? 1}\n`); res.end(); });
      return;
    }
    if (req.method === "POST" && req.url === "/api/run") {
      const t0 = Date.now();
      const { ca, action, acct, arg, appConfirm, slip, clientTs } = await body(req);
      if (req.web) clampWebSlip(slip, action);   // 网页下单:选的滑点超过本机设的上限(买 / 卖各一个)直接拒绝(不偷偷改小);webOrderPlan 里还会再验
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
      let started = false, webBnbEach = null, wp = null;   // 网页买入每个号的金额(单笔上限按它比);wp = webOrderPlan 的结果
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
        if (req.web) webBnbEach = bnb;
      }
      let plans = accts.map((a) => ({ a, ...route(d, action, a, arg, appConfirm === true) }));
      if (req.web) {
        // 网页下单:滑点上限(买 / 卖)、单笔 / 每日上限、Gang 按比例买的 --max-bnb、Gang 第一代按比例买拒绝,都由 webOrderPlan 定(纯函数,有单元测试)。
        //   --max-bnb 用的「今天已用」是记这一单之前的;webOrderPlan → checkWebBuy → recordWebBuy 之间没有 await(两单同时来也不会一起超额);
        //   放在脚本都选好之后,选不出脚本的单不占额度;下单本身失败不退回,偏保守
        wp = webOrderPlan({ action, arg, slip, accounts: accts.length, plans, scriptOf: (p) => relScript(p.script), bnbEach: webBnbEach, limits: getWebLimits(), spentToday: webSpentToday() });
        plans = wp.plans;
        if (wp.charge !== null) { checkWebBuy(webBnbEach, undefined, accts.length); recordWebBuy(wp.charge); }
      } else if (Number(slip) > 0) {
        // 本机下单:选了滑点就加 --slip(不选用各脚本自己的默认值)
        for (const p of plans) {
          const i = p.args.indexOf("--slip");
          if (i >= 0) p.args[i + 1] = String(Number(slip)); else p.args.push("--slip", String(Number(slip)));
        }
      }
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-accel-buffering": "no" });
      res.write(`识别:${d.platformLabel} · ${d.stage === "inner" ? "内盘" : "外盘"} · ${d.symbol}\n`);
      started = true;
      execOrder(d, action, plans, { arg, t0, clientTs, onLine: (a, l) => res.write(`[账号${a}] ${l}\n`) })
        .then((r) => { res.write(`__DONE__ ${r.worst}\n`); res.end(); });
      // 网页下单记录(本机面板「网页连接」里看):单已经发出去了,记录写不进去也不能影响这一单
      if (req.web) {
        try {
          // slip = 每个号实际传给脚本的滑点({ 账号: 数字 | "脚本默认" }),bnb = 记账的合计(卖出 null)
          logWebOrder({ origin: req.web.origin, pairId: req.web.pair.id, ca, symbol: d.symbol, action, acct, arg, slip: wp.slipLog, bnb: wp.charge, ...(wp.maxBnb !== null ? { maxBnb: wp.maxBnb } : {}) });
        }
        catch (e) { console.error("[网页连接] 网页下单记录写不进去:", e?.message ?? e); }
      }
      return;
      } finally { if (!started) accts.forEach((a) => busy.delete(a)); }
    }
    json(res, 404, { error: "没有这个接口" });
  } catch (e) {
    let msg = e.message;
    // 网页请求:带 code 的系统错误(ENOENT / EACCES / EPERM …,消息里常带本机路径)不发给网页,完整错误打在本机窗口(路径不带 ?查询串,里面可能有令牌)
    if (req.web && e?.code) { console.error(`[网页连接] ${req.method} ${String(req.url).split(/[?#]/, 1)[0]} 出错:`, e); msg = "本机出错了,详情看本机面板窗口"; }
    // 网页请求:等批准时配对被断开(401)/ 本机没批准(403)/ 等批准的请求太多(429)按原状态码回;其余一律 400(本机请求照旧)
    const status = req.web && [401, 403, 429].includes(e?.status) ? e.status : 400;
    if (!res.headersSent) json(res, status, { error: msg });
    else res.end(`\n✘ ${msg}\n__DONE__ 1\n`);
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(UI === "helper" ? `TIGER POWER 本机助手已启动:http://127.0.0.1:${PORT}(界面:本机助手 helper,交易请到网站 tigerpower.online)` : `内盘管理面板已启动:http://127.0.0.1:${PORT}(界面:完整面板 full)`);
  console.log(`网页连接:只认 ${[...WEB_ORIGINS].join(", ")};配对码会打在这里,也可以打开 http://127.0.0.1:${PORT}/pair 看`);
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

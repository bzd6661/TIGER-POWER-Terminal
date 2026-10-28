// 本地小助手的测试夹具:真的 webGate + 真的批准队列 + 假的业务接口(不碰任何钱包、不下单、不 import server.mjs)
//   用在测试里:  const fx = await startFixture({ port: 0, origins: "https://tigerpower.online" });  …  await fx.close();
//                now:时钟(默认 Date.now),交给 webGate;测配对间隔 / 锁定时传一个能拨的
//                api / kind:/link/hello 报的接口版本(默认 2)和助手种类(默认 helper);approvalTimeoutMs:批准等多久算拒绝(默认 120 秒)
//                fx.emit(事件):推给开着的事件流(按各自的 scope 过滤);fx.stats:{ sent: 批准后执行了几笔模拟转账, dropped: 批准了但网页已断开、没执行的 }
//   网页接口:改设置(/api/settings/set,要批准)、转账(/api/send,文本流,要批准,批准后只写一行「模拟转账」)、/api/mine、/api/login/request 都是桩
//   本机直接访问(没有 Origin)的夹具专用路由:GET /fixture/pending(配对码)、GET /fixture/revoke-all、
//                GET /fixture/approvals(待批列表)、POST /fixture/decide {id, ok}(批准 / 拒绝)
//   本机预览(preview: true;单独运行时默认打开):浏览器直接打开夹具地址 / 就是 panel/helper.html(本机助手页面,令牌换成 fx.previewToken),
//                页面要的 /localpop.js、/i18n.js、/update.js、/favicon.svg 照真文件给;本机接口是桩(POST 要带页面令牌,和真服务器的 guard 一样):
//                /api/wallets(账号 1 已登录、账号 2 没登录)、/api/login/start|status|logout|unpin(假的待扫码二维码)、GET /api/update-status、
//                /api/link/state、/api/link/revoke、/api/link/pending、/api/approve/pending、/api/approve/decide(接真的配对 / 批准队列)、GET /api/stream?t=(本机事件流,收得到批准 / 配对 / 登录请求)。
//                演示用(GET,只在本机预览):/fixture/demo/approve?kind=send|tip|settings|at-target|at-appconfirm|at-on|unpin|limits|copy-real|copy-resume(塞一条批准请求),
//                /fixture/demo/pair(模拟网站请求配对,弹配对码)、/fixture/demo/loginreq?acct=2(模拟网站请求登录)、
//                /fixture/demo/login?acct=2&state=ok|wrong|expired|fail(让页面上正在扫的码变成这个结果)
//   单独运行:    node tests/helper-fixture.mjs   → 默认 127.0.0.1:4411,拿官方网页 / 本地网页去连它做联调;浏览器打开 http://127.0.0.1:4411/ 看本机助手页面
//                环境变量:FIXTURE_PORT(4411)、FIXTURE_ORIGINS(https://tigerpower.online,http://localhost:8080)、FIXTURE_API(2)、FIXTURE_KIND(helper)、FIXTURE_PREVIEW(默认开,0 = 关掉本机预览)
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEAD = "0x000000000000000000000000000000000000dEaD";
const normOrigins = (s) => String(s).split(/[\s,]+/).map((x) => x.replace(/\/+$/, "")).filter(Boolean);

// 业务接口的桩:形状照真接口的样子给,这样真网页页面能直接渲染(见计划里的联调步骤)
const STUBS = {
  "/api/wallets": () => ({
    accounts: [{ acct: "1", address: DEAD, bnb: 1.23 }],
    sessions: [{ acct: "1", connected: true, installed: true }],
    tokens: [],
    bnbUsd: 600,
  }),
  "/api/inspect": (b) => ({
    ca: b.ca, symbol: "FIX", name: "Fixture", platform: "gangv3", platformLabel: "夹具 · 测试", stage: "inner",
    quote: "BNB", quoteBnb: 1, quoteUsd: 600, supply: 1e9, progress: 10, cost1pct: 0.01, costHalfPct: 0.005,
    holdings: { 1: { tokens: 1000000, value: 0.01 } }, costs: {}, wallets: { 1: DEAD }, stats: null,
  }),
  "/api/history": () => ({ source: "夹具", partial: false, quote: "BNB", quoteUsd: 600, supply: 1e9, points: [], dex: null, total: 0, mine: [] }),
  // 代币页「我的」部分:/api/inspect 里只有钱包相关的字段 + /api/history 的 mine;trades: false = 只要持仓(和 server.mjs 一样不带 mine)
  "/api/mine": (b) => ({
    ca: b.ca, wallets: { 1: DEAD }, holdings: { 1: { tokens: 1000000, value: 0.01 } }, costs: {}, quoteBnb: 1, nftGate: null, ...(b.trades === false ? {} : { mine: [] }),
  }),
  "/api/tradespage": () => ({ source: "夹具", total: 0, end: true, items: [] }),
  "/api/trades": () => ({ source: null, items: [] }),
  "/api/scan": () => ({ tokens: [] }),
  "/api/lists": () => ({ groups: [{ id: "default", name: "默认" }], favs: {}, blockTokens: {}, blockDevs: {} }),
  "/api/settings": () => ({ maxBuyBnb: 0, autoClaim: false }),
  "/api/autotransfer": () => ({ to: null, appConfirm: false, tokens: {} }),
  "/api/copy": () => ({ tasks: [], paused: false, log: [], defaults: {} }),
  // 这三个真接口回的是数组(extras.mjs);给成对象的话账户总览的设置区块会渲染失败
  "/api/approvals": () => [],
  "/api/quote-balances": () => [],
  "/api/latency-stats": () => [],
  "/api/track": () => ({ targets: [], groups: ["默认"], status: { running: false, last: null, queued: [] } }),
  "/api/notes": () => ({ manifesto: null, notes: [] }),
};

// ── 本机预览(preview: true)用的 ──
const PANEL = (f) => fileURLToPath(new URL(`../panel/${f}`, import.meta.url));
const PREVIEW_TOKEN = "f1c7f1c7f1c7f1c7f1c7f1c7f1c7f1c7f1c7f1c7f1c7f1c7";   // 固定的假页面令牌(48 位十六进制,和真令牌同一个格式)
// 和 server.mjs 给 helper.html 的同一个 CSP:预览时页面要是违反了,浏览器控制台里看得到
const HELPER_CSP = "default-src 'self'; img-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";
const PREVIEW_FILES = { "/localpop.js": "localpop.js", "/i18n.js": "i18n.js", "/update.js": "update.js" };
const OWN2 = "0x2222222222222222222222222222222222222222";
// 假的二维码(只是个格子图案,扫不出东西)
const FAKE_QR = (() => {
  let s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25" shape-rendering="crispEdges"><rect width="25" height="25" fill="#fff"/>';
  for (let y = 0; y < 25; y++) for (let x = 0; x < 25; x++) if ((x * 7 + y * 13 + x * y) % 5 < 2) s += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  return s + "</svg>";
})();
// 演示批准:每种批准框一份样例参数(批准框文字照真的 describeApproval 生成)
const DEMO_APPROVALS = {
  send: { acct: "1", token: "BNB", amount: "0.25", to: "0x9999999999999999999999999999999999999999", appConfirm: false, dry: false },
  tip: { acct: "1", amount: "0.05", memo: "辛苦了 thanks", appConfirm: true, dry: false },
  settings: { maxBuyBnb: 0.3, autoClaim: true },
  "at-target": { to: DEAD },
  "at-appconfirm": { on: true },
  "at-on": { ca: "0x5555555555555555555555555555555555555555" },
  unpin: { acct: "2" },
  limits: { webMaxBuyBnb: 1, webDailyBnb: 5 },
  "copy-real": { target: "0x7777777777777777777777777777777777777777", name: "大户", params: { maxPerTrade: 0.1, dailyCap: 0.5 } },
  "copy-resume": {},
};

async function readBody(req, max = 8192) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > max) break; }
  try { const j = JSON.parse(s || "{}"); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return {}; }
}

const OWN_DIRS = new Set(); // 本进程里 startFixture 建过的临时数据目录

export async function startFixture({ port, origins, api = 2, kind = "helper", log = false, now = Date.now, approvalTimeoutMs, preview = false } = {}) {
  // 先设环境再加载 weblink.mjs:白名单和数据目录都是加载时读的。数据目录用临时的,绝不写进真实的 panel 目录
  process.env.AGENTBUY_WEB_ORIGINS = origins;
  const tmp = mkdtempSync(join(tmpdir(), "helper-fixture-"));
  process.env.AGENTBUY_DATA_DIR = tmp;
  const w = await import("../panel/weblink.mjs");
  const { dataFile } = await import("../panel/datadir.mjs");
  const dataDir = dirname(dataFile("web-pairs.json"));
  // 数据目录必须是夹具自己的临时目录(这次建的,或同进程里更早一次 startFixture 建的)。
  // 否则说明 weblink.mjs / datadir.mjs 在 startFixture 之前就被加载了,目录早已定死(默认是真实的 panel/):
  // 继续跑会把配对写进真实的 web-pairs.json,/fixture/revoke-all 还会清掉真实配对,所以直接拒绝启动。
  if (dataDir === tmp) OWN_DIRS.add(tmp);
  else {
    rmSync(tmp, { recursive: true, force: true }); // 这个新目录没人用
    if (!OWN_DIRS.has(dataDir)) throw new Error(`夹具拒绝启动:weblink.mjs 在 startFixture 之前就加载了,数据目录是 ${dataDir},不是夹具的临时目录。要先调 startFixture,再动态 import("../panel/weblink.mjs")`);
  }
  const want = normOrigins(origins).sort().join(",");
  if ([...w.WEB_ORIGINS].sort().join(",") !== want) throw new Error(`weblink.mjs 已经用别的来源白名单加载过了(${[...w.WEB_ORIGINS].join(",")}),同一进程里不能换`);

  const say = (...a) => { if (log) console.log("[fixture]", ...a); };
  const sse = new Set(); // 开着的事件流,关闭时要主动收掉;每个 res 上记着 fixtureScope
  let actualPort = port;
  const stats = { sent: 0, dropped: 0 };

  // 推一条事件:按各个事件流的订阅范围过滤(和 server.mjs 的 bus 循环同一个 streamSees)
  const emit = (ev) => {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const r of sse) if (w.streamSees(r.fixtureScope, ev?.type)) r.write(line);
  };
  const offApprove = w.onApprovalChange(() => emit({ type: "approve" })); // 同 server.mjs:批准队列一变就推(只有本机页面看得到)
  // 网页请求放进真的批准队列,和 server.mjs 一样走 webApproval:配对已经断开 → 同步抛 401,同一个配对已经有 3 条在等 → 同步抛 429;
  //   网页断开(res 关闭)→ 这一条马上撤掉。批准框的上下文是假的
  const ctxOf = () => ({ own: { 1: DEAD }, atTarget: null, limits: w.getWebLimits(), settings: STUBS["/api/settings"](), copyDefaults: {} });
  const ask = (g, res, kind, params) => {
    const { title, lines } = w.describeApproval(kind, params, ctxOf());
    return w.webApproval({ kind, title, lines, origin: g.origin, pairId: g.pair.id }, { timeoutMs: approvalTimeoutMs, signal: w.clientGoneSignal(res) });
  };

  // 本机预览:两个账号登录了没有、锁定的地址、正在扫的码(只在内存里)
  const pv = { conn: { 1: true, 2: false }, pin: { 1: DEAD, 2: OWN2 }, login: {} };
  // 本机预览的路由(本机直接访问才会到这里):处理了返回 true
  async function previewRoute(req, res, path, json) {
    const q = new URL(req.url, "http://x").searchParams;
    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": HELPER_CSP });
      res.end(readFileSync(PANEL("helper.html"), "utf8").replace("__PANEL_TOKEN__", PREVIEW_TOKEN));
      return true;
    }
    if (req.method === "GET" && PREVIEW_FILES[path]) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      res.end(readFileSync(PANEL(PREVIEW_FILES[path])));
      return true;
    }
    if (req.method === "GET" && (path === "/favicon.svg" || path === "/favicon.ico")) {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end(readFileSync(PANEL("favicon.svg")));
      return true;
    }
    if (req.method === "GET" && path === "/api/update-status") { json(200, { local: { version: "0.0.0", build: 0 }, remote: null, major: false }); return true; }
    // 本机事件流:令牌放在查询参数里(同 server.mjs);本机范围,收得到批准 / 配对 / 登录请求
    if (req.method === "GET" && path === "/api/stream") {
      if (q.get("t") !== PREVIEW_TOKEN) { json(403, { error: "令牌不对" }); return true; }
      res.fixtureScope = "local";
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 3000\n\n");
      res.write('data: {"type":"hello"}\n\n');
      const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
      sse.add(res);
      res.once("close", () => { clearInterval(beat); sse.delete(res); });
      return true;
    }
    // ── 演示:塞批准请求 / 模拟网站请求配对、请求登录 / 让正在扫的码出结果 ──
    if (req.method === "GET" && path === "/fixture/demo/approve") {
      const kind = q.get("kind") || "send";
      if (!Object.hasOwn(DEMO_APPROVALS, kind)) { json(400, { error: "没有这种批准", kinds: Object.keys(DEMO_APPROVALS) }); return true; }
      const { title, lines } = w.describeApproval(kind, DEMO_APPROVALS[kind], ctxOf());
      w.requestApproval({ kind, title, lines, origin: normOrigins(origins)[0], pairId: "demo" }, { timeoutMs: approvalTimeoutMs })   // 已经有 3 条在等 → 同步抛 429
        .then((ok) => say(`演示批准 ${kind}:${ok ? "批准了" : "拒绝 / 超时"}`));
      json(200, { ok: true, kind });
      return true;
    }
    if (req.method === "GET" && path === "/fixture/demo/pair") {
      const origin = normOrigins(origins)[0];
      w.startPair(origin, now());   // 太频繁 / 被锁 → 抛 429(外面的 catch 按 status 回)
      emit({ type: "linkpair", origin });
      json(200, { ok: true, code: w.pendingPair(now())?.code });
      return true;
    }
    if (req.method === "GET" && path === "/fixture/demo/loginreq") {
      emit({ type: "loginreq", acct: q.get("acct") === "1" ? "1" : "2" });
      json(200, { ok: true });
      return true;
    }
    if (req.method === "GET" && path === "/fixture/demo/login") {
      const acct = q.get("acct") === "1" ? "1" : "2", L = pv.login[acct], state = q.get("state");
      if (!L) { json(400, { error: `账号${acct} 没有在扫的码,先在页面上点「扫码登录」` }); return true; }
      if (!["ok", "wrong", "expired", "fail"].includes(state)) { json(400, { error: "state 要是 ok / wrong / expired / fail" }); return true; }
      L.state = state;
      if (state === "ok") { L.address = pv.pin[acct] ?? (acct === "1" ? DEAD : OWN2); pv.conn[acct] = true; pv.pin[acct] = L.address; }
      if (state === "wrong") { L.address = "0x8888888888888888888888888888888888888888"; L.error = `扫错账号了:账号${acct} 锁定的是 ${L.pin ?? OWN2},刚登录的是 ${L.address},已自动退出。请用对应的币安账号重新扫码;确实要换钱包,先点「解除锁定」`; }
      if (state === "fail") L.error = "夹具:模拟登录失败";
      json(200, { ok: true });
      return true;
    }
    if (req.method !== "POST" || !path.startsWith("/api/")) return false;
    // ── 本机接口的桩:和真服务器一样要页面令牌 ──
    if (req.headers["x-panel-token"] !== PREVIEW_TOKEN) { json(403, { error: "令牌不对" }); return true; }
    const b = await readBody(req);
    const no = (msg) => Object.assign(new Error(msg), { status: 400 });   // 业务错误:真服务器回本机页面 400
    if (path.startsWith("/api/login/") && !["1", "2"].includes(b.acct)) throw no("账号不对");
    const reply = (obj) => { json(200, obj); return true; };
    switch (path) {
      case "/api/wallets":
        return reply({
          accounts: ["1", "2"].filter((a) => pv.conn[a]).map((a) => ({ acct: a, address: a === "1" ? DEAD : OWN2, bnb: a === "1" ? 1.23 : 0.5 })),
          sessions: ["1", "2"].map((a) => ({ acct: a, installed: true, status: pv.conn[a] ? "CONNECTED" : null, connected: pv.conn[a], error: null })),
          tokens: [], bnbUsd: 600,
        });
      case "/api/login/start":
        if (pv.conn[b.acct]) throw no(`账号${b.acct} 已经登录了`);
        pv.login[b.acct] = { state: "pending", url: "https://example.com/tiger-power-fixture-login", code: "FX24", expireAt: Date.now() + 300_000, svg: FAKE_QR, pin: pv.pin[b.acct] ?? null };
        return reply(pv.login[b.acct]);
      case "/api/login/status": return reply(pv.login[b.acct] ?? { state: "none", pin: null });
      case "/api/login/logout": pv.conn[b.acct] = false; delete pv.login[b.acct]; return reply({ ok: true });
      case "/api/login/unpin": delete pv.pin[b.acct]; if (pv.login[b.acct]) pv.login[b.acct].pin = null; return reply({ ok: true });
      case "/api/link/state": return reply({ pairs: w.listPairs(), limits: w.getWebLimits(), spentToday: w.webSpentToday(), orders: w.recentWebOrders(30) });
      case "/api/link/revoke": {   // 同 server.mjs:断开配对,它在等的批准一起作废(夹具的网页事件流不按配对记,不用另外关)
        const id = String(b.id ?? "");
        const ok = w.revokePair(id);
        if (ok) w.dropPairApprovals(id);
        return reply({ ok });
      }
      case "/api/link/pending": return reply(w.pendingPair(now()));
      case "/api/approve/pending": return reply(w.pendingApprovals());
      case "/api/approve/decide": return reply({ ok: w.decideApproval(String(b.id ?? ""), b.ok === true) });
      default: json(404, { error: "夹具没有这个接口" }); return true;
    }
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    res.once("close", () => say(new Date().toTimeString().slice(0, 8), req.method, req.url.replace(/([?&]t=)[^&#]*/, "$1***"), `origin=${req.headers.origin ?? "-"}`, `-> ${res.statusCode}`, `(${Date.now() - t0}ms)`));
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
    try {
      const g = await w.webGate(req, res, { port: actualPort, build: 1, api, kind, now, onPairStart: (code, origin) => { say(`配对码 ${code}(来源 ${origin})`); emit({ type: "linkpair", origin }); } });
      if (g.handled) return;
      const path = req.url.split(/[?#]/, 1)[0];

      if (!g.web) { // 本机直接访问:只开放夹具专用路由(开了本机预览再加上助手页面和它要的本机接口)
        if (preview && (await previewRoute(req, res, path, json))) return;
        if (req.method === "GET" && path === "/fixture/pending") return json(200, w.pendingPair(now()));
        if (req.method === "GET" && path === "/fixture/revoke-all") {
          const ids = w.listPairs().map((p) => p.id);
          for (const id of ids) { w.revokePair(id); w.dropPairApprovals(id); } // 同 server.mjs:断开配对时它在等的批准一起作废
          return json(200, { revoked: ids.length });
        }
        if (req.method === "GET" && path === "/fixture/approvals") return json(200, w.pendingApprovals());
        if (req.method === "POST" && path === "/fixture/decide") {
          const b = await readBody(req);
          return json(200, { ok: w.decideApproval(String(b.id ?? ""), b.ok === true) });
        }
        return json(404, { error: "夹具没有这个路由" });
      }

      // 网页请求:到这里已经过了来源 / 令牌 / 白名单
      if (req.method === "GET" && path === "/api/stream") {
        res.fixtureScope = new URL(req.url, "http://x").searchParams.get("scope") === "wallet" ? "wallet" : "web";
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        res.write('data: {"type":"hello"}\n\n');
        const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
        sse.add(res);
        res.once("close", () => { clearInterval(beat); sse.delete(res); });
        return;
      }
      // 改设置:要不要批准按 approvalKind;批准框照规整过的参数写(同 extras.mjs 的 cleanSettings;夹具不 import 它:会连带加载钱包 / 链上模块)
      if (req.method === "POST" && path === "/api/settings/set") {
        const b = await readBody(req);
        const p = {};
        if (b.maxBuyBnb !== undefined) p.maxBuyBnb = Number(b.maxBuyBnb);
        if (b.autoClaim !== undefined) p.autoClaim = b.autoClaim === true;
        const k = w.approvalKind(path, b);
        if (k && !(await ask(g, res, k, p))) return json(403, { error: w.NOT_APPROVED });
        if (w.clientGone(res)) return;
        return json(200, { ...STUBS["/api/settings"](), ...p });
      }
      // 转账:先进批准队列(满了 → 429,这时还没写响应头),再写「等待批准」一行;批准后只写一行模拟结果,绝不动钱
      if (req.method === "POST" && path === "/api/send") {
        const b = await readBody(req);
        const isBnb = /^bnb$/i.test(String(b.token ?? ""));
        const wait = ask(g, res, "send", { acct: String(b.acct ?? ""), token: isBnb ? "BNB" : String(b.token ?? ""), amount: String(b.amount ?? "").trim(), to: String(b.to ?? ""), appConfirm: b.appConfirm === true && !isBnb, dry: b.dry === true });
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
        res.write(`${w.APPROVAL_WAIT_TEXT}\n`);
        if (!(await wait)) return res.end(`✘ ${w.NOT_APPROVED}\n__DONE__ 1\n`);
        if (w.clientGone(res)) { stats.dropped++; return; }
        stats.sent++;
        say("/api/send 批准了(模拟,没有真的转) body =", JSON.stringify(b));
        return res.end("模拟转账(没有真的转)\n__DONE__ 0\n");
      }
      // 网页请本机弹出扫码登录:推 loginreq(网页的事件流看不到);helperPage = 有没有开着的本机页面(只有本机预览才会有)
      if (req.method === "POST" && path === "/api/login/request") {
        const b = await readBody(req);
        emit({ type: "loginreq", acct: String(b.acct ?? "") });
        return json(200, { ok: true, helperPage: [...sse].some((r) => r.fixtureScope === "local") });
      }
      if (req.method === "POST" && path === "/api/run") {
        const b = await readBody(req);
        say("/api/run body =", JSON.stringify(b));
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
        res.write("识别:夹具\n");
        res.write("[账号1] 模拟成交(没有真的下单)\n");
        res.end("__DONE__ 0\n");
        return;
      }
      if (req.method === "POST") {
        const stub = STUBS[path];
        return json(200, stub ? stub(await readBody(req)) : {});
      }
      return json(200, {});
    } catch (e) {
      // 带 status 的是业务拒绝(等批准的太多 429 …),原样回;其余 500
      if (!res.headersSent) json(e?.status ?? 500, { error: String(e?.message ?? e) });
      else res.end();
    }
  });

  await new Promise((ok, bad) => { server.once("error", bad); server.listen(port, "127.0.0.1", ok); });
  actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;

  return {
    url,
    port: actualPort,
    dataDir,
    previewToken: preview ? PREVIEW_TOKEN : null,
    emit,
    stats,
    async close() {
      offApprove();
      for (const r of sse) r.end();
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
    },
  };
}

// 直接运行:起一个常驻夹具,每个请求打一行日志(被 node --test 当成测试文件扫到时不启动,免得挂住)
if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fx = await startFixture({
    port: Number(process.env.FIXTURE_PORT || 4411),
    origins: process.env.FIXTURE_ORIGINS || "https://tigerpower.online,http://localhost:8080",
    api: Number(process.env.FIXTURE_API ?? 2),
    kind: process.env.FIXTURE_KIND || "helper",
    log: true,
    preview: process.env.FIXTURE_PREVIEW !== "0",
  });
  console.log(`[fixture] 本地小助手夹具已启动:${fx.url}(只认 ${process.env.FIXTURE_ORIGINS || "https://tigerpower.online,http://localhost:8080"},api=${process.env.FIXTURE_API ?? 2},kind=${process.env.FIXTURE_KIND || "helper"};假数据,不会下单)`);
  console.log("[fixture] 配对码:网页点「开始配对」后,用 GET /fixture/pending 取(本机直接访问)");
  console.log("[fixture] 批准:GET /fixture/approvals 看待批列表,POST /fixture/decide {\"id\":\"…\",\"ok\":true} 批准(本机直接访问)");
  if (fx.previewToken) {
    console.log(`[fixture] 本机预览:浏览器打开 ${fx.url}/ 就是本机助手页面(假数据)`);
    console.log(`[fixture] 演示:${fx.url}/fixture/demo/approve?kind=send(或 settings / tip / limits …)弹批准框;${fx.url}/fixture/demo/pair 弹配对码;${fx.url}/fixture/demo/loginreq?acct=2 网站请求登录;页面上点了扫码登录后 ${fx.url}/fixture/demo/login?acct=2&state=wrong 或 ok 出结果`);
  }
  const stop = async () => { await fx.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

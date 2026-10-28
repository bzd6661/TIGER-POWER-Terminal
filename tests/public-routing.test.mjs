// 网站(panel/public.js)连着本机助手时请求分两路:钱包相关的发本机助手(HELPER_PATHS),代币页的数据问网站、再合上本机的「我的」部分,其余和没连时一样
//   1. 静态:两个集合按名字从源码里抠出来,和本机助手的接口白名单(weblink.mjs 的 webPolicy)、批准规则(approvalKind)对得上
//   2. 在 vm 里真跑 public.js(假的 window / document / fetch / EventSource,不连任何真服务):分流、令牌只发本机、/api/mine 合并和 3 秒缓存、
//      两条实时推送、等批准的提示条、登录请求
//   3. 英文:public.js 里写死的中文在词典里都有整句
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "public-routing-"));
process.env.AGENTBUY_DATA_DIR = dir;   // weblink.mjs 只拿来查白名单 / 批准规则,不写盘;数据目录也指到临时目录
const w = await import("../panel/weblink.mjs");
after(() => rmSync(dir, { recursive: true, force: true }));

const panel = (f) => readFileSync(new URL(`../panel/${f}`, import.meta.url), "utf8");
const SRC = panel("public.js");

// 按名字找 const NAME = new Set([...]):里面只许有字符串字面量(不许拼接 / 变量),不然这里读到的和页面真用的会对不上
function setOf(name) {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(SRC);
  assert.ok(m, `public.js 里没有 const ${name} = new Set([...])`);
  assert.equal(m[1].replace(/"[^"\r\n]*"/g, "").replace(/[\s,]/g, ""), "", `${name} 里只能是字符串字面量`);
  const list = [...m[1].matchAll(/"([^"\r\n]*)"/g)].map((x) => x[1]);
  assert.equal(new Set(list).size, list.length, `${name} 里有重复`);
  return new Set(list);
}
const HELPER_PATHS = setOf("HELPER_PATHS"), APPROVE_PATHS = setOf("APPROVE_PATHS");
const EXPECTED = ("/api/wallets /api/quote /api/run /api/send /api/tip /api/settings /api/settings/set /api/approvals /api/approvals/revoke " +
  "/api/quote-balances /api/latency-stats /api/autotransfer /api/autotransfer/target /api/autotransfer/set /api/autotransfer/appconfirm " +
  "/api/login/status /api/login/logout /api/login/unpin /api/login/request /api/copy /api/copy/tasks /api/copy/pause-all " +
  "/api/link/state /api/link/revoke /api/link/limits /api/mine").split(" ");

test("HELPER_PATHS 正好是这些钱包相关的接口", () => {
  assert.deepEqual([...HELPER_PATHS].sort(), [...EXPECTED].sort());
});

test("HELPER_PATHS 每一个本机助手都放行网页 POST(webPolicy)", () => {
  for (const p of HELPER_PATHS) assert.ok(w.webPolicy("POST", p).ok, p);
});

test("APPROVE_PATHS 是 HELPER_PATHS 的子集,并且盖住所有可能要本机批准的接口", () => {
  for (const p of APPROVE_PATHS) assert.ok(HELPER_PATHS.has(p), p);
  for (const p of HELPER_PATHS) if (w.approvalKind(p, { on: true }) !== null) assert.ok(APPROVE_PATHS.has(p), p);
  // 跟单:开真实任务 / 恢复全部要批准(webCopyTaskPolicy / webPausePolicy,不在 approvalKind 里)
  for (const p of ["/api/copy/tasks", "/api/copy/pause-all"]) assert.ok(APPROVE_PATHS.has(p), p);
});

test("网站要求的助手接口版本是 2;等批准那一行和本机助手写的一字不差", () => {
  assert.match(SRC, /\bHELPER_API = 2;/);
  assert.equal(w.HELPER_API, 2);
  const m = /const APPROVAL_WAIT_TEXT = "([^"]*)"/.exec(SRC);
  assert.ok(m, "public.js 里没有 APPROVAL_WAIT_TEXT");
  assert.equal(m[1], w.APPROVAL_WAIT_TEXT);
});

// ════════ 在 vm 里跑 public.js ════════
const SITE = "https://tigerpower.online", HB = "http://127.0.0.1:4400", TOK = "tok_0123456789abcdef";
const CA = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", TRADER = "0x1111111111111111111111111111111111111111";
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const enc = (s) => new TextEncoder().encode(s);

// 假 DOM:够 public.js 跑就行。querySelector 同一个选择器回同一个假元素(测试能拿到对话框里那一块看内容)
function fakeEl(tag = "div") {
  const q = new Map(), attrs = {};
  const e = {
    tagName: tag.toUpperCase(), hidden: false, className: "", innerHTML: "", textContent: "", children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { e.children.push(c); return c; }, before() {}, after() {}, remove() {},
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: (k) => attrs[k] ?? null,
    addEventListener() {}, contains: () => false, closest: () => null,
    querySelector(sel) { if (!q.has(sel)) q.set(sel, fakeEl()); return q.get(sel); },
    querySelectorAll: () => [],
  };
  return e;
}
// 假 EventSource:onmessage / onerror / onopen 和浏览器一样也是事件监听(dispatchEvent 会调到);开过的都记在 list 里
function fakeES(list) {
  return class extends EventTarget {
    #on = {};
    constructor(url) {
      super();
      this.url = String(url); this.closed = false; list.push(this);
      for (const t of ["message", "error", "open"]) this.addEventListener(t, (ev) => this.#on[t]?.call(this, ev));
    }
    set onmessage(f) { this.#on.message = f; } get onmessage() { return this.#on.message ?? null; }
    set onerror(f) { this.#on.error = f; } get onerror() { return this.#on.error ?? null; }
    set onopen(f) { this.#on.open = f; } get onopen() { return this.#on.open ?? null; }
    close() { this.closed = true; }
  };
}
const store = (init) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};

// paired:浏览器里有配对令牌(window.TP_HELPER);route(call) 回假响应,没回就是 /link/hello(已配对)或 404
// fastTimers:1 秒以上的定时器缩成 1/100(登录轮询 2 秒一次,测试不用真等)
function boot({ paired = true, route = () => null, ls = {}, fastTimers = false } = {}) {
  const calls = [], streams = [];
  const body = fakeEl("body");
  const document = {
    readyState: "complete", documentElement: fakeEl("html"), head: fakeEl("head"), body,
    createElement: (t) => fakeEl(t), querySelector: () => null, getElementById: () => null, addEventListener() {},
  };
  const ctx = {
    document, console, URL, Headers, Response, ReadableStream, TextDecoder, TextEncoder, AbortSignal, MessageEvent, CustomEvent, clearTimeout,
    setTimeout: fastTimers ? (f, ms, ...a) => setTimeout(f, ms >= 1000 ? ms / 100 : ms, ...a) : setTimeout,
    navigator: { userAgent: "node-test" }, reloads: 0,
    location: { href: SITE + "/trade", origin: SITE, hostname: "tigerpower.online", reload() { ctx.reloads++; } },
    localStorage: store(paired ? { tp_helper_token: TOK, ...ls } : ls), sessionStorage: store({}),
    addEventListener() {}, dispatchEvent: () => true,
    EventSource: fakeES(streams),
  };
  ctx.window = ctx;
  ctx.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.href ?? input.url, SITE).href;
    const call = { url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body ?? null };
    calls.push(call);
    const r = await route(call);
    if (r) return r;
    if (url === HB + "/link/hello") return json({ app: "tigerpower-helper", api: 2, kind: "helper", build: "t", paired: true });
    return json({ error: "没有这个接口" }, 404);
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "public.js" });
  const post = (p, b = {}) => ctx.fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { ctx, calls, streams, body, post };
}

test("连着助手:钱包接口带令牌发本机助手;扫链 / 成交这些问网站,收藏 / 追踪名单在浏览器里;令牌不出本机", async () => {
  const { calls, post } = boot({ route: (c) => (c.url.startsWith(HB + "/api/") ? json({ via: "helper" }) : c.url.startsWith(SITE + "/api/") ? json({ via: "site", tokens: [] }) : null) });
  for (const p of HELPER_PATHS) {
    const r = await post(p, { acct: "1" });
    assert.deepEqual(await r.json(), { via: "helper" }, p);
    const c = calls.at(-1);
    assert.equal(c.url, HB + p);
    assert.equal(c.method, "POST");
    assert.equal(c.headers.get("authorization"), "Bearer " + TOK, p);
    assert.deepEqual(JSON.parse(c.body), { acct: "1" }, p);
  }
  await post("/api/scan", { lite: true });
  assert.equal(calls.at(-1).url, SITE + "/api/scan?lite=1");
  for (const p of ["/api/trader", "/api/tradespage", "/api/notes", "/api/ticker", "/api/trades", "/api/tip-info", "/api/cache-status"]) {
    assert.equal((await (await post(p, { ca: CA })).json()).via, "site", p);
    assert.equal(calls.at(-1).url, SITE + p);
  }
  const n = calls.length;
  await post("/api/lists");
  await post("/api/lists/op", { op: "fav", ca: CA, on: true });
  await post("/api/track");
  await post("/api/track/add", { input: TRADER });
  assert.equal(calls.length, n, "收藏 / 追踪名单在浏览器里处理,不发请求");
  // 连着助手还走到「只能在本机做」那一类的(比如直接发起登录):不发给网站,也不发本机助手
  const r = await post("/api/login/start", { acct: "1" });
  assert.equal(r.status, 400);
  assert.equal(calls.length, n);
  // 令牌只给本机助手
  for (const c of calls) {
    if (c.url.startsWith(HB + "/")) continue;
    assert.equal(c.headers.get("authorization"), null, c.url);
    assert.ok(!c.url.includes(TOK) && !String(c.body ?? "").includes(TOK), c.url);
  }
});

test("没连助手:钱包接口一律不发本机,弹连接对话框", async () => {
  const { calls, post } = boot({ paired: false });
  const r = await post("/api/run", { ca: CA });
  assert.equal(r.status, 400);
  assert.ok(!calls.some((c) => c.url.startsWith(HB)), "没配对就不碰 127.0.0.1");
});

test("连着助手:代币页数据问网站,合上本机 /api/mine 的持仓 / 成本 / 买卖点;inspect 只要持仓(trades:false),history 要买卖点,各自 3 秒内只问一次", async () => {
  const web = { ca: CA, symbol: "FIX", platform: "four", holdings: {}, costs: {}, nftGate: { collection: "x", wallets: {} }, public: true };
  const pos = { ca: CA, wallets: { 1: TRADER }, holdings: { 1: { tokens: 5 } }, costs: { 1: { bnb: 0.1 } }, quoteBnb: 1, nftGate: { wallets: { 1: { ok: true } } } };
  const mine = { ...pos, mine: [{ t: 1, side: "buy", acct: "1" }] };
  // 本机照 server.mjs:trades: false 不带 mine
  const { calls, post } = boot({
    route: (c) => (c.url === HB + "/api/mine" ? json(JSON.parse(c.body).trades === false ? pos : mine) : c.url === SITE + "/api/inspect" ? json(web) : c.url === SITE + "/api/history" ? json({ points: [1], mine: [] }) : null),
  });
  const [ri, rh] = await Promise.all([post("/api/inspect", { ca: CA }), post("/api/history", { ca: CA })]);
  const d = await ri.json();
  assert.equal(d.symbol, "FIX");
  assert.deepEqual(d.wallets, mine.wallets);
  assert.deepEqual(d.holdings, mine.holdings);
  assert.deepEqual(d.costs, mine.costs);
  assert.equal(d.quoteBnb, 1);
  assert.deepEqual(d.nftGate, { collection: "x", wallets: { 1: { ok: true } } });
  const h = await rh.json();
  assert.deepEqual(h.points, [1]);
  assert.deepEqual(h.mine, mine.mine);
  await post("/api/history", { ca: CA.toUpperCase().replace("0X", "0x") });
  await post("/api/inspect", { ca: CA });
  const m = calls.filter((c) => c.url === HB + "/api/mine");
  assert.equal(m.length, 2, "持仓、买卖点各问一次,3 秒内不再问");
  for (const c of m) assert.equal(c.headers.get("authorization"), "Bearer " + TOK);
  assert.deepEqual(m.map((c) => JSON.parse(c.body)).sort((a, b) => Object.keys(a).length - Object.keys(b).length), [{ ca: CA }, { ca: CA, trades: false }]);
  for (const c of calls.filter((x) => x.url.startsWith(SITE))) assert.equal(c.headers.get("authorization"), null);
});

test("连着助手:预取(/api/prefetch)照旧问网站,同时不等结果地让本机助手也识别一下;本机出错不影响", async () => {
  let helperDown = false;
  const { calls, post } = boot({
    route: (c) => {
      if (c.url === HB + "/api/prefetch") { if (helperDown) throw new TypeError("Failed to fetch"); return json({ ok: true, via: "helper" }); }
      if (c.url === SITE + "/api/prefetch") return json({ ok: true, via: "site" });
      return null;
    },
  });
  const r = await post("/api/prefetch", { ca: CA });
  assert.equal((await r.json()).via, "site", "页面拿到的是网站的回应");
  await sleep(10);
  const h = calls.filter((c) => c.url === HB + "/api/prefetch");
  assert.equal(h.length, 1);
  assert.deepEqual(JSON.parse(h[0].body), { ca: CA });
  assert.equal(h[0].headers.get("authorization"), "Bearer " + TOK);
  assert.equal(calls.find((c) => c.url === SITE + "/api/prefetch").headers.get("authorization"), null);
  helperDown = true;
  assert.equal((await (await post("/api/prefetch", { ca: CA })).json()).via, "site");
  await sleep(10);
  // 没连助手:只问网站
  const u = boot({ paired: false, route: (c) => (c.url === SITE + "/api/prefetch" ? json({ ok: true }) : null) });
  await u.post("/api/prefetch", { ca: CA });
  await sleep(10);
  assert.ok(!u.calls.some((c) => c.url.startsWith(HB)));
});

test("代币页合并:网站给了 quoteBnb 就用网站的;本机回的不是这个币就不合", async () => {
  const CA2 = "0x2222222222222222222222222222222222222222";
  const { post } = boot({
    // 本机不管问哪个币都回 CA 的数据:问 CA2 时对不上
    route: (c) => (c.url === HB + "/api/mine" ? json({ ca: CA, wallets: { 1: TRADER }, holdings: { 1: { tokens: 9 } }, costs: {}, quoteBnb: 2, nftGate: null, mine: [] })
      : c.url === SITE + "/api/inspect" ? json({ ca: JSON.parse(c.body).ca, quoteBnb: 0.5, holdings: {}, costs: {}, nftGate: null }) : null),
  });
  const d = await (await post("/api/inspect", { ca: CA })).json();
  assert.equal(d.quoteBnb, 0.5);
  assert.deepEqual(d.holdings, { 1: { tokens: 9 } });
  assert.equal(d.nftGate, null);
  const d2 = await (await post("/api/inspect", { ca: CA2 })).json();
  assert.deepEqual(d2.holdings, {}, "本机回的 ca 对不上:不合");
});

test("本机 /api/mine 出错 / 连不上:代币页照样拿到网站的原样数据", async () => {
  const web = { ca: CA, symbol: "FIX", holdings: {}, costs: {} };
  let mode = "500";
  const { post } = boot({
    route: (c) => {
      if (c.url === HB + "/api/mine") { if (mode === "500") return json({ error: "坏了" }, 500); throw new TypeError("Failed to fetch"); }
      if (c.url === SITE + "/api/inspect") return json(web);
      if (c.url === SITE + "/api/history") return json({ points: [], mine: [] });
      return null;
    },
  });
  assert.deepEqual(await (await post("/api/inspect", { ca: CA })).json(), web);
  mode = "down";
  assert.deepEqual(await (await post("/api/history", { ca: CA })).json(), { points: [], mine: [] }, "出错不进缓存,下一次再问;连不上也照样回网站的");
});

test("连着助手:实时推送两条 —— 网站的照旧,本机助手的只要钱包事件;本机的消息交给页面同一个处理函数,close 两条都关;追踪照旧从网站的成交补", async () => {
  const track = JSON.stringify({ targets: [{ address: TRADER, name: "", group: "默认" }], groups: ["默认"] });
  const { ctx, streams } = boot({ ls: { tp_track: track }, route: (c) => (c.url === SITE + "/api/scan" ? json({ tokens: [] }) : null) });
  const es = new ctx.EventSource("/api/stream?t=public");
  const got = [];
  es.onmessage = (m) => got.push(JSON.parse(m.data));
  assert.equal(streams.length, 2);
  assert.equal(streams[0], es);
  assert.equal(es.url, "/api/stream?t=public");
  assert.equal(streams[1].url, `${HB}/api/stream?scope=wallet&t=${TOK}`);
  streams[1].dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "copy-log", id: 1 }) }));
  es.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "trade", trader: TRADER, ca: CA, tx: "0x1", side: "buy", ts: 1, platform: "four" }) }));
  await sleep(30);
  assert.deepEqual(got.map((e) => e.type), ["copy-log", "trade", "track"], "浏览器追踪名单里的地址:连着助手也补「追踪」");
  assert.equal(got[2].target, TRADER);
  // 本机那条转过来的消息不拿来补追踪(就算混进一条成交)
  got.length = 0;
  streams[1].dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "trade", trader: TRADER, ca: CA, tx: "0x2", side: "sell", ts: 2, platform: "four" }) }));
  await sleep(30);
  assert.deepEqual(got.map((e) => e.type), ["trade"]);
  es.close();
  assert.ok(streams.every((s) => s.closed), "两条都关了");
  // 别的地址的推送(不是 /api/stream)不动
  const other = new ctx.EventSource("/other");
  assert.equal(streams.length, 3);
  assert.equal(other.url, "/other");
});

test("没连助手:只有网站一条推送,追踪名单里的地址成交照旧补成「追踪」事件", async () => {
  const track = JSON.stringify({ targets: [{ address: TRADER, name: "", group: "默认" }], groups: ["默认"] });
  const { ctx, streams } = boot({ paired: false, ls: { tp_track: track }, route: (c) => (c.url === SITE + "/api/scan" ? json({ tokens: [{ ca: CA, symbol: "FIX" }] }) : null) });
  const es = new ctx.EventSource("/api/stream?t=public");
  const got = [];
  es.onmessage = (m) => got.push(JSON.parse(m.data));
  assert.equal(streams.length, 1);
  es.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "trade", trader: TRADER, ca: CA, tx: "0x1", side: "buy", ts: 1, platform: "four" }) }));
  await sleep(30);
  assert.deepEqual(got.map((e) => e.type), ["trade", "track"]);
  assert.equal(got[1].symbol, "FIX");
});

const barOf = (body) => body.children.find((e) => /\btp-apbar\b/.test(e.className));

test("要批准的请求 0.4 秒还没回来:页面顶上挂「等待本机助手批准」+ 打开本机助手的链接,回来了就收起;很快回来的不挂", async () => {
  let release;
  const { body, post } = boot({
    route: async (c) => {
      if (c.url === HB + "/api/settings/set") { await new Promise((ok) => (release = ok)); return json({ error: "本机没有批准" }, 403); }
      if (c.url === HB + "/api/autotransfer/set") return json({ to: null, token: null });
      return null;
    },
  });
  await post("/api/autotransfer/set", { ca: CA, on: false });
  await sleep(450);
  assert.equal(barOf(body), undefined, "很快回来的不挂");
  const p = post("/api/settings/set", { maxBuyBnb: 1 });
  await sleep(150);
  assert.equal(barOf(body), undefined, "0.4 秒之前不挂");
  await sleep(350);
  const bar = barOf(body);
  assert.ok(bar && !bar.hidden, "0.4 秒后挂出来");
  assert.match(bar.innerHTML, /等待本机助手批准… 请到本机助手页面点「批准」/);
  assert.match(bar.innerHTML, new RegExp(`href="${HB}/"[^>]*>打开本机助手 →<`));
  release();
  const r = await p;
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "本机没有批准");
  assert.equal(bar.hidden, true, "回来了就收起");
});

test("转账是文本流:第一行是「⏳ 等待本机助手批准…」时挂提示条,等后面的结果到了才收起;页面读到的内容原样", async () => {
  let push;
  const stream = (first) => new Response(new ReadableStream({ start(ctl) { ctl.enqueue(enc(first)); push = (s) => { ctl.enqueue(enc(s)); ctl.close(); }; } }), { headers: { "content-type": "text/plain; charset=utf-8" } });
  let first = w.APPROVAL_WAIT_TEXT + "\n";
  const { body, post } = boot({ route: (c) => (c.url === HB + "/api/send" || c.url === HB + "/api/tip" ? stream(first) : null) });
  const r = await post("/api/send", { acct: "1", token: "BNB", amount: "0.1", to: TRADER });
  assert.equal(r.status, 200);
  const reading = r.text();
  await sleep(500);
  const bar = barOf(body);
  assert.ok(bar && !bar.hidden, "还在等批准:挂着");
  push("✘ 本机没有批准\n__DONE__ 1\n");
  assert.equal(await reading, `${w.APPROVAL_WAIT_TEXT}\n✘ 本机没有批准\n__DONE__ 1\n`);
  assert.equal(bar.hidden, true, "结果到了:收起");
  // 第一行不是等批准(已经开始执行了):不挂
  first = "→ 开始\n";
  const r2 = await post("/api/tip", { acct: "1", amount: "0.01" });
  const reading2 = r2.text();
  await sleep(500);
  assert.equal(bar.hidden, true);
  push("__DONE__ 0\n");
  assert.equal(await reading2, "→ 开始\n__DONE__ 0\n");
});

test("连着助手点「登录」:请本机助手页面弹出这个账号的二维码(只发本机),看到「待扫码」再「成功」才自动刷新", async () => {
  let page = true;
  const states = ["ok", "pending", "ok"];   // 第一个 ok 是之前登录留下的旧状态,不算
  const { ctx, calls, body } = boot({
    fastTimers: true,
    route: (c) => (c.url === HB + "/api/login/request" ? json({ ok: true, helperPage: page }) : c.url === HB + "/api/login/status" ? json({ state: states.shift() ?? "ok" }) : null),
  });
  await ctx.tpLocalLogin("2");
  const req = calls.filter((c) => c.url === HB + "/api/login/request");
  assert.equal(req.length, 1);
  assert.deepEqual(JSON.parse(req[0].body), { acct: "2" });
  assert.equal(req[0].headers.get("authorization"), "Bearer " + TOK);
  const dlg = body.children.find((e) => /\btp-lm\b/.test(e.className) && /请在本机助手页面扫码登录/.test(e.innerHTML));
  assert.ok(dlg && !dlg.hidden);
  assert.match(dlg.querySelector(".tp-st").innerHTML, /已在本机助手页面弹出账号 2 的二维码,用 Binance App 扫码;扫完这里会自动刷新/);
  await sleep(250);
  assert.equal(calls.filter((c) => c.url === HB + "/api/login/status").length, 3);
  assert.equal(ctx.reloads, 1, "待扫码 → 成功:刷新一次");
  page = false;
  await ctx.tpLocalLogin("1");
  assert.match(dlg.querySelector(".tp-st").innerHTML, /本机助手页面没开着:点下面打开,再点「扫码登录」/);
  dlg.hidden = true;   // 关掉对话框:轮询停下
  assert.ok(!calls.some((c) => c.url.startsWith(SITE + "/api/login")), "登录请求不经过网站");
});

// ════════ 交易页(index.html,网站和本地共用)和本机助手配合的两处:把那段代码抠出来在 vm 里跑 ════════
const INDEX = panel("index.html");

test("交易页:转账 / 打赏日志里本机助手的「⏳ 等待本机助手批准…」不提示去 Binance App;真要 App 确认的 ⏳ 照旧提示;两处都用同一个判断", () => {
  const m = /^const appApproveLine = (.+);\r?$/m.exec(INDEX);
  assert.ok(m, "index.html 里没有 const appApproveLine = …");
  const appApproveLine = vm.runInNewContext(m[1]);
  assert.equal(appApproveLine(w.APPROVAL_WAIT_TEXT), false, "等本机助手批准:不是 App");
  assert.equal(appApproveLine("⏳ 账号1 卖出 已提交,请在 Binance App 里确认(orderId 1),最多等 5 分钟…"), true);
  assert.equal(appApproveLine("✓ 已转出"), false);
  const all = INDEX.match(/toast\("请打开 Binance App 批准/g) ?? [];
  const guarded = INDEX.match(/if \(appApproveLine\(l\)\) toast\("请打开 Binance App 批准/g) ?? [];
  assert.equal(all.length, 2, "打赏、转出各一处");
  assert.equal(guarded.length, all.length, "每一处都先过 appApproveLine");
});

test("交易页:网站上拨「自动领取」没批准(403 本机没有批准)→ 报错、开关拨回去,不把 { error } 当设置存;批准了才存", async () => {
  const m = /^ {2}\$\("xClaim"\)\.onchange = async \(\) => \{\r?\n[\s\S]*?\r?\n {2}\};/m.exec(INDEX);
  assert.ok(m, "index.html 里没找到 xClaim 开关的处理");
  let reply;
  const els = { xClaim: { checked: true } }, toasts = [];
  const plain = (o) => JSON.parse(JSON.stringify(o));   // vm 里的对象原型不同,比内容
  const ctx = vm.createContext({ $: (id) => els[id], askConfirm: async () => true, toast: (msg, kind) => toasts.push([msg, kind]), post: async () => reply, Error });
  vm.runInContext("var xSettings = { maxBuyBnb: 0, autoClaim: false };\n" + m[0], ctx);
  reply = json({ error: "本机没有批准" }, 403);
  await els.xClaim.onchange();
  assert.equal(els.xClaim.checked, false, "拨回关");
  assert.deepEqual(toasts, [["本机没有批准", "err"]]);
  assert.deepEqual(plain(ctx.xSettings), { maxBuyBnb: 0, autoClaim: false }, "设置没被 { error } 盖掉");
  els.xClaim.checked = true; toasts.length = 0;
  reply = json({ maxBuyBnb: 0, autoClaim: true });
  await els.xClaim.onchange();
  assert.equal(els.xClaim.checked, true);
  assert.deepEqual(toasts, [["已开启自动领取", "ok"]]);
  assert.deepEqual(plain(ctx.xSettings), { maxBuyBnb: 0, autoClaim: true });
});

// 交易页首页的「网页连接」卡片(限额 / 已连接的浏览器 / 网页下单记录):本机面板和连着助手的网站页面都有,没连助手的网站页面没有。
//   把 helperless 和卡片那一段(let xLink … renderLink)抠出来,配上假的 $ / post / toast 在 vm 里跑
function linkCard(win) {
  const hl = /^const helperless = (.+);\r?$/m.exec(INDEX);
  const a = INDEX.indexOf("let xLink = null;"), b = INDEX.indexOf("// ---------- 一键买卖浮窗");
  assert.ok(hl && a > 0 && b > a, "index.html 里没找到 helperless / 网页连接卡片那一段");
  const els = {}, toasts = [], posts = [];
  const el = () => ({ innerHTML: "", value: "", disabled: false, onclick: null, querySelectorAll: () => [] });
  let reply = () => json({});
  const ctx = vm.createContext({
    window: win, $: (id) => (els[id] ??= el()), toast: (msg, kind) => toasts.push([msg, kind]),
    post: async (path, body) => { posts.push({ path, body, saveDisabled: els.lkSave?.disabled }); return reply(path, body); },
    esc: (s) => String(s ?? ""), num: (n) => String(n), ago: () => "1分", short: (s) => s, Error, Date, String,
  });
  vm.runInContext(`const helperless = ${hl[1]};\n${INDEX.slice(a, b)}`, ctx);
  return { ctx, els, toasts, posts, setReply: (f) => (reply = f), xLink: () => JSON.parse(JSON.stringify(vm.runInContext("xLink", ctx))) };
}
const LIM = { webMaxBuyBnb: 0.5, webDailyBnb: 2, webMaxSlip: 25, webMaxSellSlip: 10 };
const STATE = { pairs: [{ id: "p1", label: "Chrome", origin: SITE, lastUsed: 1 }], limits: LIM, spentToday: 0.1, orders: [] };

test("网页连接卡片:连着助手的网站页面、本机面板都显示并读取;没连助手的网站页面不显示,也不碰 /api/link/*", async () => {
  assert.match(INDEX, /\$\{helperless\(\) \? "" : '<div class="hcard" id="secLink">/, "卡片按 helperless() 决定画不画");
  assert.doesNotMatch(INDEX, /TP_PUBLIC \? "" : '<div class="hcard" id="secLink">/);
  for (const [win, shown] of [[{ TP_PUBLIC: true, TP_HELPER: true }, true], [{}, true], [{ TP_PUBLIC: true, TP_HELPER: false }, false]]) {
    const c = linkCard(win);
    c.setReply(() => json(STATE));
    assert.equal(!!vm.runInContext("helperless()", c.ctx), !shown, JSON.stringify(win));
    await vm.runInContext("loadLink()", c.ctx);
    assert.deepEqual(c.posts.map((p) => p.path), shown ? ["/api/link/state"] : [], JSON.stringify(win));
    if (shown) assert.match(c.els.lkBody.innerHTML, /id="lkMax" class="xin" inputmode="decimal" value="0.5"/);
  }
});

test("网页连接卡片(网站上):改限额等本机批准时保存按钮先锁住;没批准(403)→ 报错,限额保持原样(不把 { error } 存进去);批准了才更新", async () => {
  const c = linkCard({ TP_PUBLIC: true, TP_HELPER: true });
  c.setReply(() => json(STATE));
  await vm.runInContext("loadLink()", c.ctx);
  Object.assign(c.els, { lkMax: { value: "1" }, lkDay: { value: "5" }, lkSlip: { value: "30" }, lkSellSlip: { value: "15" } });
  c.setReply((path) => (path === "/api/link/limits" ? json({ error: "本机没有批准" }, 403) : json(STATE)));
  await c.els.lkSave.onclick();
  const save = c.posts.find((p) => p.path === "/api/link/limits");
  assert.deepEqual(JSON.parse(JSON.stringify(save.body)), { webMaxBuyBnb: "1", webDailyBnb: "5", webMaxSlip: "30", webMaxSellSlip: "15" });
  assert.equal(save.saveDisabled, true, "等批准时保存按钮锁住");
  assert.deepEqual(c.toasts, [["本机没有批准", "err"]]);
  assert.deepEqual(c.xLink().limits, LIM, "限额保持原样");
  assert.match(c.els.lkBody.innerHTML, /id="lkMax" class="xin" inputmode="decimal" value="0.5"/, "卡片按原来的限额重画");
  // 批准了
  const next = { ...LIM, webMaxBuyBnb: 1 };
  c.setReply((path) => (path === "/api/link/limits" ? json(next) : json(STATE)));
  c.toasts.length = 0;
  await c.els.lkSave.onclick();
  assert.deepEqual(c.toasts, [["网页连接限额已保存", "ok"]]);
  assert.deepEqual(c.xLink().limits, next);
});

test("网站上在网页连接卡片里断开这个浏览器自己的配对:之后的请求 401 → 删掉令牌、刷新回「已断开」", async () => {
  let revoked = false;
  const { ctx, post } = boot({
    route: (c) => {
      if (c.url === HB + "/api/link/revoke") { revoked = true; return json({ ok: true }); }
      if (c.url === HB + "/api/link/state") return revoked ? json({ error: "没配对或已断开,请重新连接本机助手" }, 401) : json(STATE);
      return null;
    },
  });
  assert.deepEqual(await (await post("/api/link/revoke", { id: "p1" })).json(), { ok: true });
  const r = await post("/api/link/state");
  assert.equal(r.status, 401);
  assert.equal(ctx.localStorage.getItem("tp_helper_token"), null, "令牌删掉了");
  assert.equal(ctx.sessionStorage.getItem("tp_helper_why"), "gone", "刷新后顶上提示「已断开」");
  assert.equal(ctx.reloads, 1, "刷新一次,回到没连助手的样子");
});

// ════════ 英文:public.js 里写死的中文在词典里都有整句 ════════
const I18N = panel("i18n.js");
const DICT = JSON.parse(/^ {2}const DICT = (\{.*\});\r?$/m.exec(I18N)[1]);
const CJK = /[㐀-鿿＀-￯　-〿]/;

test("英文:public.js 弹窗 / 提示里的每段中文在词典里都有整句(账号 N 两种都有)", () => {
  const noComments = SRC.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  const missing = new Set();
  const need = (s) => { s = s.trim(); if (s && CJK.test(s) && DICT[s] === undefined) missing.add(s); };
  // 标签之间的文字(模板字符串里的 HTML)
  for (const m of noComments.matchAll(/>([^<>`$"'\r\n]+)</g)) need(m[1]);
  // 普通字符串:按钮文字、提示、报错
  for (const m of noComments.matchAll(/"([^"\\\r\n]*)"/g)) if (!m[1].includes("<")) need(m[1]);   // 带标签的是 HTML 片段,上面已经按标签拆开查过
  // 带账号号码的那一句:1 和 2 都要有
  for (const acct of ["1", "2"]) need(`已在本机助手页面弹出账号 ${acct} 的二维码,用 Binance App 扫码;扫完这里会自动刷新`);
  // 本机助手发来、网站上显示的(等批准那一行 / 没批准 / 排队太多)
  for (const s of [w.APPROVAL_WAIT_TEXT, "✘ " + w.NOT_APPROVED, w.NOT_APPROVED, "等待批准的请求太多,先在本机助手页面处理"]) need(s);
  assert.deepEqual([...missing], []);
});

// 网页 ⇄ 本地小助手:请求闸门 webGate(panel/weblink.mjs 第三部分),通过测试夹具走真实 HTTP
// 夹具先设好 AGENTBUY_WEB_ORIGINS / AGENTBUY_DATA_DIR(临时目录)再加载 weblink.mjs;测试里再 import 到的是同一个模块实例
import http from "node:http";
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFixture } from "./helper-fixture.mjs";

const O = "https://tigerpower.online";
let fx, fxOld, fxFast, port, w, token, pairId;
const dataDirs = new Set();
// 配对有防爆破(两次开始至少隔 10 秒、失败太多锁 15 分钟):夹具和这里自己起的闸门都用这个能拨的时钟,开始配对前先拨过 10 秒
let clock = Date.now();
const now = () => clock;
const tick = (ms = 11_000) => { clock += ms; };

// Host 头 fetch 设不了(也不该设),要手动拼的请求走 node:http
const raw = ({ host, method = "GET", path = "/link/hello", headers = {} }) => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port, method, path, headers: { ...(host ? { host } : {}), ...headers }, agent: false }, (res) => {
    let s = "";
    res.on("data", (c) => (s += c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: s }));
  });
  r.on("error", reject);
  r.end();
});

const call = async (path, { method = "GET", origin = O, token: tok, body, headers = {}, base = fx.url } = {}) => {
  const h = { ...headers };
  if (origin) h.origin = origin;
  if (tok) h.authorization = `Bearer ${tok}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON(比如文本流) */ }
  return { status: r.status, headers: r.headers, text, json };
};

// 走完一轮配对,返回 { token, id }
async function pairNow() {
  tick();
  assert.equal((await call("/link/pair/start", { method: "POST" })).status, 200);
  const { code } = (await call("/fixture/pending", { origin: null })).json;
  const r = await call("/link/pair/finish", { method: "POST", body: { code, label: "测试浏览器" } });
  assert.equal(r.status, 200);
  return r.json;
}

before(async () => {
  fx = await startFixture({ port: 0, origins: O, now });
  port = Number(new URL(fx.url).port);
  assert.ok(port > 0);
  // 必须动态 import 且排在 startFixture 之后:weblink.mjs / datadir.mjs 加载时就定死数据目录,抢在夹具前加载会落到真实的 panel/ 上(夹具会拒绝启动)
  w = await import("../panel/weblink.mjs");
  if (fx.dataDir) dataDirs.add(fx.dataDir);
});
after(async () => {
  await fx?.close();
  await fxOld?.close();
  await fxFast?.close();
  for (const d of dataDirs) rmSync(d, { recursive: true, force: true });
});

test("Host 不是 127.0.0.1:端口 / localhost:端口 → 421(DNS 重绑定)", async () => {
  assert.equal((await raw({ host: `evil.com:${port}` })).status, 421);
  assert.equal((await raw({ host: "127.0.0.1:1" })).status, 421);
  assert.equal((await raw({ host: "127.0.0.1" })).status, 421);
  // 就算带着官方 Origin,Host 不对也先被挡
  assert.equal((await raw({ host: `evil.com:${port}`, headers: { origin: O } })).status, 421);
  // localhost 也认
  const ok = await raw({ host: `localhost:${port}`, headers: { origin: O } });
  assert.equal(ok.status, 200);
});

test("Origin 不在白名单 → 403 来源不允许,且不给跨域头", async () => {
  for (const origin of ["https://evil.com", "http://localhost:8080", "null", "https://tigerpower.online.evil.com"]) {
    const r = await call("/link/hello", { origin });
    assert.equal(r.status, 403, origin);
    assert.deepEqual(r.json, { error: "来源不允许" });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  }
  // 预检也一样
  assert.equal((await call("/api/wallets", { method: "OPTIONS", origin: "https://evil.com" })).status, 403);
});

test("预检:官方 Origin → 204 + 跨域头 + Private Network", async () => {
  const r = await call("/api/wallets", { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), O);
  assert.equal(r.headers.get("access-control-allow-private-network"), "true");
  assert.equal(r.headers.get("access-control-allow-methods"), "GET, POST");
  assert.equal(r.headers.get("access-control-allow-headers"), "content-type, authorization, x-panel-token");
  assert.equal(r.headers.get("access-control-max-age"), "600");
  assert.match(r.headers.get("vary"), /Origin/i);
});

test("GET /link/hello 不需要令牌:app / api / build / kind / paired:false(夹具默认 api 2、kind helper)", async () => {
  const r = await call("/link/hello");
  assert.equal(r.status, 200);
  assert.equal(r.json.app, "tigerpower-helper");
  assert.equal(r.json.api, 2);
  assert.equal(r.json.kind, "helper");
  assert.equal(typeof r.json.build, "number");
  assert.equal(r.json.paired, false);
  assert.equal(r.headers.get("access-control-allow-origin"), O);
  // 带了不认识的令牌也只是 paired:false,不报错
  assert.equal((await call("/link/hello", { token: "nope" })).json.paired, false);
});

test("夹具的 api 参数控制 hello 返回的版本号(模拟旧版助手)", async () => {
  fxOld = await startFixture({ port: 0, origins: O, api: 0, now });
  if (fxOld.dataDir) dataDirs.add(fxOld.dataDir);
  const r = await fetch(fxOld.url + "/link/hello", { headers: { origin: O } });
  assert.equal((await r.json()).api, 0);
});

test("配对:没有进行中的配对 → 400;start → 夹具取码 → finish 错码 400、对码拿到令牌", async () => {
  let r = await call("/link/pair/finish", { method: "POST", body: { code: "123456" } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "没有进行中的配对或已过期" });

  tick();
  r = await call("/link/pair/start", { method: "POST" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, expiresIn: 120 });
  assert.equal(r.headers.get("access-control-allow-origin"), O);

  const pend = await call("/fixture/pending", { origin: null });
  assert.equal(pend.status, 200);
  assert.match(pend.json.code, /^\d{6}$/);
  assert.equal(pend.json.origin, O);

  const wrong = pend.json.code === "000000" ? "000001" : "000000";
  r = await call("/link/pair/finish", { method: "POST", body: { code: wrong, label: "x" } });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error: "配对码不对" });

  r = await call("/link/pair/finish", { method: "POST", body: { code: pend.json.code, label: "测试浏览器" } });
  assert.equal(r.status, 200);
  assert.ok(r.json.token.length >= 32);
  assert.match(r.json.id, /^[0-9a-f]{16}$/);
  assert.equal(r.headers.get("access-control-allow-origin"), O);
  ({ token, id: pairId } = r.json);

  // 配对成功后码作废
  assert.equal((await call("/link/pair/finish", { method: "POST", body: { code: pend.json.code } })).status, 400);
  assert.equal((await call("/link/hello", { token })).json.paired, true);
  assert.ok(w.listPairs().some((p) => p.id === pairId && p.label === "测试浏览器"));
});

test("配对:坏 JSON → 400;错码试太多次 → 429", async () => {
  const bad = await fetch(fx.url + "/link/pair/finish", { method: "POST", headers: { origin: O, "content-type": "application/json" }, body: "{不是json" });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).error);

  tick();
  assert.equal((await call("/link/pair/start", { method: "POST" })).status, 200);
  const { code } = (await call("/fixture/pending", { origin: null })).json;
  const wrong = code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await call("/link/pair/finish", { method: "POST", body: { code: wrong } })).status, 400);
  const r = await call("/link/pair/finish", { method: "POST", body: { code: wrong } });
  assert.equal(r.status, 429);
  assert.match(r.json.error, /试太多次/);
});

test("带令牌调白名单接口 → 200 + 跨域头;不带令牌 → 401", async () => {
  const ok = await call("/api/wallets", { method: "POST", token, body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), O);
  assert.equal(ok.json.accounts[0].acct, "1");
  assert.equal(ok.json.accounts[0].address, "0x000000000000000000000000000000000000dEaD");
  assert.equal(ok.json.accounts[0].bnb, 1.23);
  assert.deepEqual(ok.json.sessions, [{ acct: "1", connected: true, installed: true }]);
  assert.deepEqual(ok.json.tokens, []);
  assert.equal(ok.json.bnbUsd, 600);

  const no = await call("/api/wallets", { method: "POST", body: {} });
  assert.equal(no.status, 401);
  assert.deepEqual(no.json, { error: "没配对或已断开,请重新连接本机助手" });
  assert.equal(no.headers.get("access-control-allow-origin"), O, "401 也要带跨域头,网页才读得到错误");

  assert.equal((await call("/api/wallets", { method: "POST", token: "bad", body: {} })).status, 401);
  // 令牌只认 Authorization 头(/api/stream 除外):查询参数里的不算
  assert.equal((await call(`/api/wallets?t=${token}`, { method: "POST", body: {} })).status, 401);
  // 不带 Bearer 前缀 / 别的方案 → 401
  assert.equal((await call("/api/wallets", { method: "POST", body: {}, headers: { authorization: token } })).status, 401);
  assert.equal((await call("/api/wallets", { method: "POST", body: {}, headers: { authorization: `Basic ${token}` } })).status, 401);
});

test("白名单之外:只能本机的接口 403 只能在本机助手页面(带 ?查询串也一样)、未知接口 404、方法不对 404", async () => {
  for (const p of ["/api/link/pending", "/api/link/pending?x=1", "/api/approve/pending", "/api/approve/decide", "/api/link/anything"]) {
    const r = await call(p, { method: "POST", token, body: {} });
    assert.equal(r.status, 403, p);
    assert.match(r.json.error, /只能在本机助手页面/);
    assert.equal(r.headers.get("access-control-allow-origin"), O);
  }
  assert.equal((await call("/api/nope", { method: "POST", token, body: {} })).status, 404);
  assert.equal((await call("/api/wallets", { token })).status, 404, "白名单里 /api/wallets 只给 POST");
  assert.equal((await call("/", { token })).status, 404);
});

test("钱包登录:网页发起(/api/login/start)→ 403 只能在本机助手页面(二维码只在本机显示);查状态 / 退出照常能调", async () => {
  for (const [p, method] of [["/api/login/start", "POST"], ["/api/login/start?acct=1", "POST"], ["/api/login/start", "GET"]]) {
    const r = await call(p, { method, token, ...(method === "POST" ? { body: { acct: "1" } } : {}) });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.match(r.json.error, /只能在本机助手页面/, `${method} ${p}`);
    assert.equal(r.headers.get("access-control-allow-origin"), O, "403 也要带跨域头,网页才读得到错误");
  }
  // 没令牌的 /api/login/start 先被令牌闸门拦下(401),不会漏出任何登录信息
  assert.equal((await call("/api/login/start", { method: "POST", body: { acct: "1" } })).status, 401);
  for (const p of ["/api/login/status", "/api/login/logout"]) {
    const r = await call(p, { method: "POST", token, body: { acct: "1" } });
    assert.equal(r.status, 200, p);
  }
});

test("GET /api/stream?t=<令牌> → 200 text/event-stream 先发 hello;t 错 → 401;Authorization 头也行", async () => {
  const open = async (path, headers = {}) => {
    const ac = new AbortController();
    const r = await fetch(fx.url + path, { headers: { origin: O, ...headers }, signal: ac.signal });
    return { r, ac };
  };
  const good = await open(`/api/stream?t=${token}`);
  assert.equal(good.r.status, 200);
  assert.match(good.r.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(good.r.headers.get("access-control-allow-origin"), O);
  const reader = good.r.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /data: \{"type":"hello"\}/);
  good.ac.abort();
  await reader.cancel().catch(() => {});

  const bad = await open("/api/stream?t=bad");
  assert.equal(bad.r.status, 401);
  await bad.r.body.cancel();
  const none = await open("/api/stream");
  assert.equal(none.r.status, 401);
  await none.r.body.cancel();

  const viaHeader = await open("/api/stream", { authorization: `Bearer ${token}` });
  assert.equal(viaHeader.r.status, 200);
  viaHeader.ac.abort();
  await viaHeader.r.body.cancel().catch(() => {});
});

test("夹具桩接口:/api/run 文本流、其余白名单接口给带形状的假数据", async () => {
  const run = await call("/api/run", { method: "POST", token, body: { ca: "0x0", action: "buy", acct: "1", arg: "0.01" } });
  assert.equal(run.status, 200);
  assert.equal(run.text, "识别:夹具\n[账号1] 模拟成交(没有真的下单)\n__DONE__ 0\n");

  const ca = "0x1111111111111111111111111111111111111111";
  const ins = await call("/api/inspect", { method: "POST", token, body: { ca } });
  assert.equal(ins.status, 200);
  assert.equal(ins.json.ca, ca);
  assert.equal(ins.json.symbol, "FIX");
  assert.equal(ins.json.stage, "inner");
  assert.deepEqual(ins.json.holdings, { 1: { tokens: 1000000, value: 0.01 } });

  const shapes = {
    "/api/history": ["source", "points", "mine", "total"],
    "/api/tradespage": ["source", "total", "end", "items"],
    "/api/trades": ["source", "items"],
    "/api/scan": ["tokens"],
    "/api/lists": ["groups", "favs", "blockTokens", "blockDevs"],
    "/api/settings": ["maxBuyBnb", "autoClaim"],
    "/api/autotransfer": ["to", "appConfirm", "tokens"],
    "/api/copy": ["tasks", "paused", "log", "defaults"],
    "/api/track": ["targets", "groups", "status"],
    "/api/notes": ["manifesto", "notes"],
  };
  for (const [p, keys] of Object.entries(shapes)) {
    const r = await call(p, { method: "POST", token, body: {} });
    assert.equal(r.status, 200, p);
    for (const k of keys) assert.ok(k in r.json, `${p} 缺 ${k}`);
  }
  // 这三个真接口回的是数组(panel/extras.mjs),账户总览直接对它们 .filter / .length
  for (const p of ["/api/approvals", "/api/quote-balances", "/api/latency-stats"]) assert.deepEqual((await call(p, { method: "POST", token, body: {} })).json, [], p);
  assert.deepEqual((await call("/api/lists", { method: "POST", token, body: {} })).json.groups, [{ id: "default", name: "默认" }]);
  // 没有专门桩的白名单接口 → {}
  assert.deepEqual((await call("/api/ticker", { method: "POST", token, body: {} })).json, {});
  assert.deepEqual((await call("/health", { token })).json, {});
});

test("撤销配对后,同一个令牌立刻 401", async () => {
  assert.equal((await call("/api/wallets", { method: "POST", token, body: {} })).status, 200);
  assert.equal(w.revokePair(pairId), true);
  assert.equal((await call("/api/wallets", { method: "POST", token, body: {} })).status, 401);
  assert.equal((await call("/link/hello", { token })).json.paired, false);
});

test("夹具 /fixture/revoke-all 撤销全部配对", async () => {
  const a = await pairNow();
  const b = await pairNow();
  assert.ok(w.listPairs().length >= 2);
  const r = await call("/fixture/revoke-all", { origin: null });
  assert.equal(r.status, 200);
  assert.deepEqual(w.listPairs(), []);
  for (const t of [a.token, b.token]) assert.equal((await call("/api/wallets", { method: "POST", token: t, body: {} })).status, 401);
});

test("没有 Origin(本机直接访问)不受闸门影响:夹具路由可用,别的路径 404", async () => {
  assert.equal((await call("/fixture/pending", { origin: null })).status, 200);
  // 同源(Origin 就是 http://自己的 Host)也交回原来的 guard
  assert.equal((await call("/fixture/pending", { origin: fx.url })).status, 200);
  assert.equal((await call("/fixture/pending", { origin: null })).headers.get("access-control-allow-origin"), null);
  const r = await call("/api/wallets", { method: "POST", origin: null, body: {} });
  assert.equal(r.status, 404, "夹具不接管本机面板的接口");
});

test("webGate 契约:交回 {web:false} / {web:true,...} 时响应原封不动(只多了跨域头);onPairStart 收到配对码", async () => {
  const started = [];
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    try {
      const g = await w.webGate(req, res, { port: srv.address().port, build: 7, now, onPairStart: (code, origin) => started.push({ code, origin }) });
      if (g.handled) return;
      seen.push({ ...g, headersSent: res.headersSent, acao: res.getHeader("access-control-allow-origin") ?? null, vary: res.getHeader("vary") ?? null });
      res.writeHead(204); res.end();
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    // 本机请求
    assert.equal((await fetch(base + "/anything", { signal: AbortSignal.timeout(10_000) })).status, 204);
    // 配对 → 令牌 → 通过白名单
    tick();
    assert.equal((await fetch(base + "/link/pair/start", { method: "POST", headers: { origin: O } })).status, 200);
    assert.equal(started.length, 1);
    assert.match(started[0].code, /^\d{6}$/);
    assert.equal(started[0].origin, O);
    assert.equal(started[0].code, w.pendingPair(now()).code);
    const fin = await fetch(base + "/link/pair/finish", { method: "POST", headers: { origin: O, "content-type": "application/json" }, body: JSON.stringify({ code: started[0].code, label: "契约" }) });
    const { token: tok, id } = await fin.json();
    const hello = await (await fetch(base + "/link/hello", { headers: { origin: O, authorization: `Bearer ${tok}` } })).json();
    assert.deepEqual(hello, { app: "tigerpower-helper", api: 2, build: 7, kind: "full", paired: true });
    assert.equal((await fetch(base + "/api/scan", { method: "POST", headers: { origin: O, authorization: `Bearer ${tok}` } })).status, 204);

    assert.equal(seen.length, 2);
    assert.deepEqual({ ...seen[0] }, { web: false, headersSent: false, acao: null, vary: null });
    assert.equal(seen[1].web, true);
    assert.equal(seen[1].origin, O);
    assert.equal(seen[1].pair.id, id);
    assert.equal(seen[1].pair.label, "契约");
    assert.equal(seen[1].pair.hash, undefined, "不把令牌哈希交给调用方");
    assert.equal(seen[1].headersSent, false);
    assert.equal(seen[1].acao, O);
    assert.match(seen[1].vary, /Origin/i);
    w.revokePair(id);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
});

test("夹具守卫:weblink.mjs 抢在 startFixture 之前加载 → 拒绝启动,真实 panel/ 目录里什么都不写", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const panelDir = join(here, "..", "panel");
  const before = readdirSync(panelDir).sort();
  const code = [
    `import ${JSON.stringify(pathToFileURL(join(panelDir, "weblink.mjs")).href)};`, // 静态 import:先于 startFixture 加载,数据目录被定成 panel/
    `import { startFixture } from ${JSON.stringify(pathToFileURL(join(here, "helper-fixture.mjs")).href)};`,
    `const fx = await startFixture({ port: 0, origins: "https://tigerpower.online" });`,
    `console.log("STARTED " + fx.dataDir); await fx.close();`,
  ].join("\n");
  const env = { ...process.env };
  for (const k of ["AGENTBUY_DATA_DIR", "AGENTBUY_WEB_ORIGINS", "NODE_TEST_CONTEXT"]) delete env[k]; // 子进程要像一个干净的新进程
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 20_000 });
  assert.notEqual(r.status, 0, `应当非 0 退出,实际 ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /STARTED/);
  assert.match(r.stderr, /夹具拒绝启动/);
  assert.deepEqual(readdirSync(panelDir).sort(), before, "panel/ 里不能多出任何文件(web-pairs.json 等)");
});

// ── 配对防爆破(HTTP):开始配对的间隔、失败太多锁 15 分钟 ──
const wrongOf = (c) => (c === "000000" ? "000001" : "000000");
const pending = async () => (await call("/fixture/pending", { origin: null })).json;
const startStatus = async () => (await call("/link/pair/start", { method: "POST" })).status;

test("HTTP:开始配对太频繁 → 429 配对太频繁(带跨域头,进行中的这一轮不受影响);过 10 秒可以", async () => {
  tick(3_600_000); // 和前面的用例隔开
  assert.equal(await startStatus(), 200);
  const { code } = await pending();
  tick(5_000);
  const r = await call("/link/pair/start", { method: "POST" });
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, { error: "配对太频繁,稍等几秒" });
  assert.equal(r.headers.get("access-control-allow-origin"), O, "429 也要带跨域头,网页才看得到原因");
  assert.equal((await pending()).code, code, "被拒的这一下没有顶掉进行中的配对");
  tick(5_000);
  assert.equal(await startStatus(), 200);
  // 配成一次:失败计数清零,不影响后面的用例
  const fin = await call("/link/pair/finish", { method: "POST", body: { code: (await pending()).code, label: "间隔" } });
  assert.equal(fin.status, 200);
  w.revokePair(fin.json.id);
});

test("HTTP:10 分钟内 3 轮没配成 → 开始配对 429 锁 15 分钟(本机日志一笔),到点恢复;错码 10 次也锁", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const LOCKED = { error: "配对尝试太多,请 15 分钟后再试" };
  tick(3_600_000);
  for (let i = 0; i < 3; i++) { tick(); assert.equal(await startStatus(), 200, `第 ${i + 1} 轮`); } // 每开一轮就顶掉上一轮
  tick();
  let r = await call("/link/pair/start", { method: "POST" });
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, LOCKED);
  assert.equal(r.headers.get("access-control-allow-origin"), O);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /配对失败太多/);
  assert.equal(await pending(), null);
  tick(14 * 60_000);
  assert.equal(await startStatus(), 429, "15 分钟内还锁着");
  tick(60_000);
  assert.equal(await startStatus(), 200, "到点放开");

  // 错码:这一轮试 5 次,换一轮再试 → 第 10 个错码就锁(finish 回 429),对的码也换不到令牌
  let { code } = await pending();
  for (let i = 0; i < 5; i++) assert.equal((await call("/link/pair/finish", { method: "POST", body: { code: wrongOf(code) } })).status, 400);
  tick();
  assert.equal(await startStatus(), 200);
  ({ code } = await pending());
  for (let i = 0; i < 4; i++) assert.equal((await call("/link/pair/finish", { method: "POST", body: { code: wrongOf(code) } })).status, 400);
  r = await call("/link/pair/finish", { method: "POST", body: { code: wrongOf(code) } });
  assert.equal(r.status, 429);
  assert.deepEqual(r.json, LOCKED);
  assert.equal(warn.mock.callCount(), 2);
  assert.equal((await call("/link/pair/finish", { method: "POST", body: { code } })).status, 400, "锁了以后对的码也没用");
  tick();
  assert.equal(await startStatus(), 429);
  tick(15 * 60_000);
  assert.equal(await startStatus(), 200);
  const fin = await call("/link/pair/finish", { method: "POST", body: { code: (await pending()).code, label: "解锁后" } });
  assert.equal(fin.status, 200, "解锁后正常配对");
  w.revokePair(fin.json.id);
});

// ── 网页请求要本机批准(API 2):夹具用真的批准队列,假的业务接口 ──
const WAIT = "⏳ 等待本机助手批准…(请在本机助手页面点「批准」)\n";
const TO = "0x2222222222222222222222222222222222222222";
const approvals = async () => (await call("/fixture/approvals", { origin: null })).json;
const decide = async (id, ok) => (await call("/fixture/decide", { method: "POST", origin: null, body: { id, ok } })).json;
// 反复查,直到 fn() 给出真值(本机这边的批准队列要等请求真的到了夹具才有东西)
async function until(fn, what = "条件", ms = 5_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等不到${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const firstPending = () => until(async () => (await approvals())[0], "待批的请求");
// 文本流:一段一段读,直到读到的内容满足 re(或流结束)
const textStream = (r) => ({ reader: r.body.getReader(), dec: new TextDecoder(), text: "", done: false });
async function readUntil(s, re) {
  while (!re.test(s.text) && !s.done) {
    const { value, done } = await s.reader.read();
    if (done) s.done = true; else s.text += s.dec.decode(value, { stream: true });
  }
  return s.text;
}
const sendReq = (tok, extra = {}) => fetch(fx.url + "/api/send", {
  method: "POST", headers: { origin: O, authorization: `Bearer ${tok}`, "content-type": "application/json" },
  body: JSON.stringify({ acct: "1", token: "BNB", amount: "0.1", to: TO }), signal: AbortSignal.timeout(10_000), ...extra,
});

test("网页改设置要本机批准:待批列表里出现「改设置」(参数已转成数字);批准 → 200,拒绝 → 403 本机没有批准", async () => {
  const { token: tok } = await pairNow();
  const ok = call("/api/settings/set", { method: "POST", token: tok, body: { maxBuyBnb: "3e-1" } });
  const a = await firstPending();
  assert.equal(a.title, "改设置");
  assert.equal(a.kind, "settings");
  assert.equal(a.origin, O);
  assert.deepEqual(a.lines, ["单笔买入上限(BNB):不限 → 0.3"], "批准框照校验后的数字写,不是原样的 \"3e-1\"");
  assert.equal(a.pairId, undefined, "待批列表不带配对 id");
  assert.deepEqual(await decide(a.id, true), { ok: true });
  const r1 = await ok;
  assert.equal(r1.status, 200);
  assert.equal(r1.json.maxBuyBnb, 0.3);
  assert.deepEqual(await approvals(), []);

  const no = call("/api/settings/set", { method: "POST", token: tok, body: { autoClaim: true } });
  const b = await firstPending();
  assert.deepEqual(b.lines, ["Flap 内盘开盘后自动领取:关 → 开"]);
  assert.deepEqual(await decide(b.id, false), { ok: true });
  const r2 = await no;
  assert.equal(r2.status, 403);
  assert.deepEqual(r2.json, { error: "本机没有批准" });
  assert.equal(r2.headers.get("access-control-allow-origin"), O, "403 也要带跨域头,网页才看得到原因");
  assert.deepEqual(await decide(b.id, true), { ok: false }, "处理过的不能再改");
  assert.deepEqual(await decide("nope", true), { ok: false });
});

test("没人批准:超时(夹具 approvalTimeoutMs: 50)→ 403 本机没有批准,队列清空", async () => {
  fxFast = await startFixture({ port: 0, origins: O, now, approvalTimeoutMs: 50 });
  if (fxFast.dataDir) dataDirs.add(fxFast.dataDir);
  const { token: tok } = await pairNow(); // 配对存在 weblink.mjs 里,同一进程的夹具共用
  const r = await call("/api/settings/set", { method: "POST", token: tok, body: { autoClaim: true }, base: fxFast.url });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: "本机没有批准" });
  assert.deepEqual(await approvals(), []);
});

test("网页转账:文本流先写「⏳ 等待本机助手批准…」;拒绝 → ✘ 本机没有批准 + __DONE__ 1;批准 → 执行 + __DONE__ 0", async () => {
  const { token: tok } = await pairNow();
  const r = await sendReq(tok);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/plain/);
  assert.equal(r.headers.get("access-control-allow-origin"), O);
  const s = textStream(r);
  assert.equal(await readUntil(s, /\n/), WAIT, "第一行就是等待批准");
  const a = await firstPending();
  assert.equal(a.title, "转账");
  assert.ok(a.lines.some((l) => l.includes(TO)), a.lines.join("|"));
  assert.ok(a.lines.some((l) => l.startsWith("⚠")), "收款不是自己的地址要警告");
  await decide(a.id, false);
  assert.equal(await readUntil(s, /__DONE__/), `${WAIT}✘ 本机没有批准\n__DONE__ 1\n`);

  const sent = fx.stats.sent;
  const s2 = textStream(await sendReq(tok));
  await readUntil(s2, /\n/);
  await decide((await firstPending()).id, true);
  assert.equal(await readUntil(s2, /__DONE__/), `${WAIT}模拟转账(没有真的转)\n__DONE__ 0\n`);
  assert.equal(fx.stats.sent, sent + 1);
});

test("等批准时网页断开(转账文本流):这一条马上从本机待批列表撤掉,批准不了,也不执行", async () => {
  const { token: tok } = await pairNow();
  const ac = new AbortController();
  const s = textStream(await sendReq(tok, { signal: ac.signal }));
  assert.equal(await readUntil(s, /\n/), WAIT);
  const a = await firstPending();
  const { sent } = fx.stats;
  ac.abort();
  await s.reader.cancel().catch(() => {});
  await until(async () => (await approvals()).length === 0, "网页断开后待批列表里没有这一条了");
  assert.deepEqual(await decide(a.id, true), { ok: false }, "已经撤掉,点批准也没用");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fx.stats.sent, sent, "网页已经断开,不执行");
});

test("等批准时网页断开(JSON 接口):撤掉、腾出名额 —— 连着刷新 3 次也不会把 3 个名额占满(第 4 个照样进队列,不是 429)", async () => {
  const { token: tok } = await pairNow();
  for (let i = 0; i < 3; i++) {
    const ac = new AbortController();
    const p = fetch(fx.url + "/api/settings/set", {
      method: "POST", headers: { origin: O, authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ autoClaim: true }), signal: ac.signal,
    }).catch((e) => e);
    await firstPending();
    ac.abort();
    await p;
    await until(async () => (await approvals()).length === 0, `第 ${i + 1} 次断开后撤掉`);
  }
  const next = call("/api/settings/set", { method: "POST", token: tok, body: { autoClaim: true } });
  const a = await firstPending();
  assert.equal(a.title, "改设置");
  await decide(a.id, false);
  assert.equal((await next).status, 403);
});

test("同一个配对最多 3 个在等:并发 4 个 → 一个 429(带跨域头),其余 3 个拒绝后 403", async () => {
  const { token: tok } = await pairNow();
  const settled = [];
  const reqs = [1, 2, 3, 4].map(() => call("/api/settings/set", { method: "POST", token: tok, body: { autoClaim: true } }).then((r) => (settled.push(r), r)));
  // 先等第 4 个被 429 拒掉、3 个都进了队列,再去处理(提前处理会腾出位子,就测不到 429 了)
  const list = await until(async () => { const l = await approvals(); return settled.length === 1 && l.length === 3 ? l : null; }, "3 个在等 + 1 个被拒");
  assert.equal(settled[0].status, 429);
  assert.deepEqual(settled[0].json, { error: "等待批准的请求太多,先在本机助手页面处理" });
  assert.equal(settled[0].headers.get("access-control-allow-origin"), O);
  for (const a of list) await decide(a.id, false);
  assert.deepEqual((await Promise.all(reqs)).map((r) => r.status).sort(), [403, 403, 403, 429]);
});

test("撤销配对:它在等的批准一起作废(当作拒绝)", async () => {
  const { token: tok } = await pairNow();
  const p = call("/api/settings/set", { method: "POST", token: tok, body: { autoClaim: true } });
  await firstPending();
  assert.equal((await call("/fixture/revoke-all", { origin: null })).status, 200);
  const r = await p;
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { error: "本机没有批准" });
  assert.deepEqual(await approvals(), []);
});

test("事件流:scope=wallet 只给钱包私有事件(收不到成交 / 追踪);默认 scope 看得到成交;两者都收不到批准 / 配对 / 登录请求", async () => {
  const { token: tok } = await pairNow();
  const open = async (q) => {
    const ac = new AbortController();
    const r = await fetch(`${fx.url}/api/stream?t=${tok}${q}`, { headers: { origin: O }, signal: ac.signal });
    assert.equal(r.status, 200);
    return { ...textStream(r), ac };
  };
  const wal = await open("&scope=wallet");
  const web = await open("");
  await readUntil(wal, /"hello"/);
  await readUntil(web, /"hello"/);
  // 一次批准(夹具会推两次 approve:进队列、处理完)+ 登录请求(夹具推 loginreq)+ 成交 / 配对 / 最后一条通知
  const pend = call("/api/settings/set", { method: "POST", token: tok, body: { autoClaim: true } });
  await decide((await firstPending()).id, false);
  assert.equal((await pend).status, 403);
  const lr = await call("/api/login/request", { method: "POST", token: tok, body: { acct: "1" } });
  assert.deepEqual(lr.json, { ok: true, helperPage: false });
  fx.emit({ type: "trade", ca: TO });
  fx.emit({ type: "track", target: TO });
  fx.emit({ type: "track-list" });
  fx.emit({ type: "linkpair", origin: O });
  fx.emit({ type: "notice", text: "完" });
  await readUntil(wal, /"notice"/);
  await readUntil(web, /"notice"/);
  assert.doesNotMatch(wal.text, /"trade"/, "wallet 收不到成交");
  assert.doesNotMatch(wal.text, /"track"|"track-list"/, "wallet 收不到追踪(网页的追踪名单在浏览器里,自己从网站的成交里补)");
  assert.match(web.text, /"track"/);
  assert.match(web.text, /"trade"/, "web 看得到成交");
  for (const s of [wal, web]) {
    assert.doesNotMatch(s.text, /"approve"|"linkpair"|"loginreq"/);
    s.ac.abort();
    await s.reader.cancel().catch(() => {});
  }
});

test("夹具桩:/api/mine 回钱包那部分(持仓 / 成本 / 我的买卖点);trades: false 只回持仓,不带 mine", async () => {
  const { token: tok } = await pairNow();
  const ca = "0x1111111111111111111111111111111111111111";
  const r = await call("/api/mine", { method: "POST", token: tok, body: { ca } });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["ca", "costs", "holdings", "mine", "nftGate", "quoteBnb", "wallets"]);
  assert.equal(r.json.ca, ca);
  assert.ok(Array.isArray(r.json.mine));
  const p = await call("/api/mine", { method: "POST", token: tok, body: { ca, trades: false } });
  assert.equal(p.status, 200);
  assert.deepEqual(Object.keys(p.json).sort(), ["ca", "costs", "holdings", "nftGate", "quoteBnb", "wallets"]);
});

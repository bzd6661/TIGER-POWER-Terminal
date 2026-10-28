// 本机助手页面(panel/helper.html)+ 本机弹窗(panel/localpop.js):夹具的本机预览模式,和三个本机页面的接入
// 夹具先设好 AGENTBUY_WEB_ORIGINS / AGENTBUY_DATA_DIR(临时目录)再加载 weblink.mjs;这里再 import 到的是同一个模块实例
import { readFileSync, rmSync } from "node:fs";
import vm from "node:vm";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFixture } from "./helper-fixture.mjs";

const O = "https://tigerpower.online";
const panel = (f) => readFileSync(new URL(`../panel/${f}`, import.meta.url), "utf8");
let fx, w;

before(async () => {
  fx = await startFixture({ port: 0, origins: O, preview: true });
  w = await import("../panel/weblink.mjs");
});
after(async () => {
  await fx?.close();
  if (fx?.dataDir) rmSync(fx.dataDir, { recursive: true, force: true });
});

// 本机页面发的请求:POST 带页面令牌(同 index.html 的 post())
const post = (path, body = {}, token = fx.previewToken) => fetch(fx.url + path, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-panel-token": token } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
});

// 打开本机事件流,收到满足 until 的事件(或超时)就关掉,返回收到的全部事件
async function streamUntil(token, until, act = () => {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5_000);
  const r = await fetch(`${fx.url}/api/stream?t=${token}`, { signal: ac.signal });
  const evs = [];
  if (r.status !== 200) { clearTimeout(t); ac.abort(); return { status: r.status, evs }; }
  const rd = r.body.getReader();
  let buf = "", acted = false;
  try {
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += Buffer.from(value).toString("utf8");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /^data: (.*)$/m.exec(chunk);
        if (m) evs.push(JSON.parse(m[1]));
      }
      if (!acted && evs.some((e) => e.type === "hello")) { acted = true; await act(); }
      if (until(evs)) break;
    }
  } catch (e) { if (e.name !== "AbortError") throw e; }
  clearTimeout(t); ac.abort();
  return { status: r.status, evs };
}

test("本机预览:GET / 是本机助手页面(令牌已换成夹具的,带 localpop.js / i18n.js / update.js)", async () => {
  const r = await fetch(fx.url + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.match(r.headers.get("content-security-policy"), /default-src 'self'/);
  const html = await r.text();
  assert.ok(html.includes("TIGER POWER 本机助手"));
  assert.ok(html.includes('<script src="/localpop.js"></script>'));
  assert.ok(html.includes('<script src="/i18n.js"></script>'));
  assert.ok(html.includes('<script src="/update.js" defer></script>'));
  assert.ok(!html.includes("__PANEL_TOKEN__"), "令牌占位要换掉");
  assert.match(fx.previewToken, /^[0-9a-f]{48}$/);
  assert.ok(html.includes(fx.previewToken));
  assert.ok(html.includes("window.tpLoginRequested = openLogin"));
  // 带查询串也一样
  assert.equal((await fetch(fx.url + "/?x=1")).status, 200);
});

test("本机预览:页面要的脚本都给;没开预览的夹具不接管本机页面", async () => {
  for (const p of ["/localpop.js", "/i18n.js", "/update.js"]) {
    const r = await fetch(fx.url + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get("content-type"), /javascript/, p);
  }
  assert.match(await (await fetch(fx.url + "/localpop.js")).text(), /window\.tpLocalPop\s*=/);
  assert.equal((await fetch(fx.url + "/favicon.svg")).status, 200);
  const plain = await startFixture({ port: 0, origins: O });
  try {
    assert.equal((await fetch(plain.url + "/")).status, 404);
  } finally { await plain.close(); }
});

test("本机预览:POST 要页面令牌;/api/wallets 账号 1 已登录、账号 2 没登录", async () => {
  assert.equal((await post("/api/wallets", {}, null)).status, 403);
  assert.equal((await post("/api/wallets", {}, "0".repeat(48))).status, 403);
  const r = await post("/api/wallets", { force: true });
  assert.equal(r.status, 200);
  const d = await r.json();
  const s = Object.fromEntries(d.sessions.map((x) => [x.acct, x]));
  assert.equal(s["1"].connected, true);
  assert.equal(s["2"].connected, false);
  assert.ok(d.accounts.find((a) => a.acct === "1")?.address);
  // 扫码登录:已登录的号不给码;没登录的给一个假的待扫码二维码
  assert.equal((await post("/api/login/start", { acct: "1" })).status, 400);
  const L = await (await post("/api/login/start", { acct: "2" })).json();
  assert.equal(L.state, "pending");
  assert.match(L.svg, /^<svg/);
  assert.equal((await (await post("/api/login/status", { acct: "2" })).json()).state, "pending");
  // 网页连接状态
  const st = await (await post("/api/link/state")).json();
  assert.ok(Array.isArray(st.pairs));
  assert.equal(await (await post("/api/link/pending")).json(), null);
});

test("本机预览:批准列表 / 批准决定接的是真的批准队列", async () => {
  const wait = w.requestApproval({ kind: "send", title: "转账", lines: ["从账号 1 转出"], origin: O, pairId: "t-approve" });
  const list = await (await post("/api/approve/pending")).json();
  const a = list.find((x) => x.title === "转账");
  assert.ok(a, "待批列表里有这一条");
  assert.deepEqual(a.lines, ["从账号 1 转出"]);
  assert.equal(a.origin, O);
  assert.equal((await post("/api/approve/decide", { id: a.id, ok: true }, null)).status, 403, "没令牌不能批准");
  assert.deepEqual(await (await post("/api/approve/decide", { id: a.id, ok: true })).json(), { ok: true });
  assert.equal(await wait, true);
  assert.deepEqual(await (await post("/api/approve/decide", { id: a.id, ok: true })).json(), { ok: false }, "处理过的不能再处理");
});

test("本机预览:事件流要令牌;本机流收得到批准 / 配对 / 登录请求", async () => {
  assert.equal((await streamUntil("bad", () => true)).status, 403);
  let wait;
  const { status, evs } = await streamUntil(fx.previewToken, (e) => e.some((x) => x.type === "loginreq"), async () => {
    wait = w.requestApproval({ kind: "settings", title: "改设置", lines: ["没有要改的项"], origin: O, pairId: "t-stream" });
    fx.emit({ type: "linkpair", origin: O });
    fx.emit({ type: "loginreq", acct: "2" });
  });
  assert.equal(status, 200);
  assert.ok(evs.some((e) => e.type === "approve"));
  assert.ok(evs.some((e) => e.type === "linkpair" && e.origin === O));
  assert.ok(evs.some((e) => e.type === "loginreq" && e.acct === "2"));
  const id = w.pendingApprovals().find((x) => x.title === "改设置").id;
  w.decideApproval(id, false);
  assert.equal(await wait, false);
});

test("三个本机页面都加载 localpop.js(紧跟 i18n.js),用页面令牌初始化,推送用页面自己那条(不另开连接);index.html 里原来的配对码弹窗删掉了", () => {
  const INIT = "window.tpLocalPop?.init(() => TOKEN, { stream: false });";
  for (const f of ["index.html", "scan.html", "track.html"]) {
    const html = panel(f);
    assert.match(html, /<script src="\/i18n\.js"><\/script>\r?\n<script src="\/localpop\.js"><\/script>\r?\n/, f);
    assert.ok(html.includes(INIT), f);
    assert.ok(html.indexOf("let TOKEN = TOKEN_INIT;") < html.indexOf(INIT), `${f}:TOKEN 定义之后才 init`);
    // 页面自己的事件流:每条事件先交给本机弹窗;整页只有一个 EventSource
    assert.ok(html.includes("window.tpLocalPop?.event(ev);"), `${f}:转发事件`);
    assert.equal(html.match(/new EventSource\(/g).length, 1, `${f}:只开一条推送`);
  }
  // 本机助手页面没有自己的推送:用 localpop.js 的
  const helper = panel("helper.html");
  assert.ok(helper.includes("window.tpLocalPop?.init(() => TOKEN);"));
  assert.ok(!helper.includes("new EventSource("));
  const idx = panel("index.html");
  for (const gone of ["onLinkPair", "showLinkPair", "closeLinkPair", "linkModal"]) assert.ok(!idx.includes(gone), gone);
  // 网站的页面去掉 localpop.js 那一行(CRLF / LF 都认)
  const src = panel("public-server.mjs");
  assert.ok(src.includes(String.raw`.replace(/<script src="\/localpop\.js"><\/script>\r?\n/, "")`));
});

// 本机预览的网页连接接口:网站配对 → /api/link/state 里有它 → /api/link/revoke 断开 → 列表里没了、它的令牌立刻 401
test("本机预览:/api/link/revoke 断开一个网站(要页面令牌);断开后它的令牌 401", async () => {
  const web = (path, init = {}) => fetch(fx.url + path, { ...init, headers: { origin: O, "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
  assert.equal((await web("/link/pair/start", { method: "POST" })).status, 200);
  const { code } = await (await fetch(fx.url + "/fixture/pending")).json();
  const { token, id } = await (await web("/link/pair/finish", { method: "POST", body: JSON.stringify({ code, label: "Chrome 测试" }) })).json();
  const st = await (await post("/api/link/state")).json();
  const p = st.pairs.find((x) => x.id === id);
  assert.equal(p.label, "Chrome 测试");
  assert.equal(p.origin, O);
  assert.equal((await post("/api/link/revoke", { id }, null)).status, 403, "没页面令牌不能断开");
  assert.deepEqual(await (await post("/api/link/revoke", { id })).json(), { ok: true });
  assert.ok(!(await (await post("/api/link/state")).json()).pairs.some((x) => x.id === id));
  assert.deepEqual(await (await post("/api/link/revoke", { id })).json(), { ok: false }, "已经断开的再断开:ok false");
  assert.equal((await web("/api/wallets", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).status, 401);
});

// ── helper.html 的页面脚本放进 vm 里跑(很小的假 DOM / fetch;定时器不跑):已连接的网站列表、「断开」 ──
class El {
  constructor(tag, id) { this.tag = tag; this.id = id; this.kids = []; this.dataset = {}; this.hidden = false; this.className = ""; this.title = ""; this.disabled = false; }
  append(...ks) { for (const k of ks) this.kids.push(typeof k === "string" ? { text: k } : k); }
  replaceChildren(...ks) { this.kids = []; this.append(...ks); }
  set textContent(v) { this.kids = [{ text: String(v) }]; }
  get textContent() { return this.kids.map((k) => (k instanceof El ? k.textContent : k.text)).join(""); }
  all() { return this.kids.filter((k) => k instanceof El).flatMap((k) => [k, ...k.all()]); }
  removeAttribute() {}
}
// answers:路径 → (请求体) => 回答;返回 { $, calls, flush }
function helperScript(answers) {
  const html = panel("helper.html");
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, new El("div", id)); return els.get(id); };
  const calls = [];
  const fetch = async (path, opt) => {
    const body = opt?.body ? JSON.parse(opt.body) : null;
    calls.push({ path, body, token: opt?.headers?.["x-panel-token"] });
    const v = answers[path]?.(body) ?? {};
    return { ok: true, status: 200, json: async () => v, clone: () => ({ text: async () => "" }) };
  };
  const ctx = { window: {}, document: { getElementById: $, createElement: (t) => new El(t) }, fetch, console, JSON, Date, Math, Number, String, Array, Object, Promise, Error, TypeError,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, location: { pathname: "/" } };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  return { $, calls, flush };
}

test("helper.html:列出已连接的网站(浏览器名 / 来源 / 上次使用,网页给的文字不翻译);点「断开」确认后 POST /api/link/revoke 再刷新;没有了就收起", async () => {
  const LAST = Date.UTC(2026, 9, 28, 12, 0, 0);
  let pairs = [
    { id: "p1", origin: O, label: "Chrome · Windows", createdAt: LAST - 1000, lastUsed: LAST },
    { id: "p2", origin: O, label: "Edge", createdAt: LAST - 2000, lastUsed: null },
  ];
  const pg = helperScript({
    "/api/link/state": () => ({ pairs, limits: {}, spentToday: 0, orders: [] }),
    "/api/link/revoke": (b) => { const n = pairs.length; pairs = pairs.filter((p) => p.id !== b.id); return { ok: pairs.length < n }; },
    "/api/wallets": () => ({ accounts: [], sessions: [], tokens: [] }),
  });
  await pg.flush();
  assert.equal(pg.$("pairN").textContent, "2");
  assert.equal(pg.$("links").hidden, false);
  const rows = pg.$("linkList").kids;
  assert.equal(rows.length, 2);
  const t0 = rows[0].textContent;
  for (const s of ["Chrome · Windows", O, "上次使用", "断开"]) assert.ok(t0.includes(s), `第一行缺「${s}」:${t0}`);
  const raw = rows[0].all().filter((e) => e.dataset.notr === "1").map((e) => e.textContent);
  assert.ok(raw.includes("Chrome · Windows") && raw.includes(O), `浏览器名、来源不翻译:${raw.join("|")}`);
  assert.ok(rows[1].textContent.includes("—"), "没用过的显示 —");
  // 点第一行的「断开」:先弹确认,取消就什么都不发
  const btn = rows[0].all().find((e) => e.tag === "button" && e.textContent === "断开");
  btn.onclick();
  await pg.flush();
  assert.equal(pg.$("askModal").hidden, false, "先确认");
  pg.$("askNo").onclick();
  await pg.flush();
  assert.ok(!pg.calls.some((c) => c.path === "/api/link/revoke"), "取消了不断开");
  btn.onclick();
  await pg.flush();
  pg.$("askYes").onclick();
  await pg.flush();
  const rv = pg.calls.filter((c) => c.path === "/api/link/revoke");
  assert.deepEqual(rv.map((c) => c.body), [{ id: "p1" }]);
  assert.equal(rv[0].token, "__PANEL_TOKEN__", "带页面令牌(源文件里还是占位)");
  assert.equal(pg.$("pairN").textContent, "1", "断开后刷新");
  assert.equal(pg.$("linkList").kids.length, 1);
  // 最后一个也断开:列表收起,状态行 0 个
  pg.$("linkList").kids[0].all().find((e) => e.tag === "button").onclick();
  await pg.flush();
  pg.$("askYes").onclick();
  await pg.flush();
  assert.equal(pg.$("pairN").textContent, "0");
  assert.equal(pg.$("links").hidden, true);
});

// 本机弹窗 panel/localpop.js:在 vm 里配一个很小的假 DOM / fetch / EventSource / 时钟跑真脚本
//   (批准框渲染和批准请求、「批准」的 1 秒解锁、配对码和批准框的摆放、网站请求登录、网站页面不启动)
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

const SRC = readFileSync(new URL("../panel/localpop.js", import.meta.url), "utf8");
const O = "https://tigerpower.online";
const DELAY = 1000;   // localpop.js 的 APPROVE_DELAY_MS

// 假元素:只实现 localpop.js 用到的那几样
class El {
  constructor(tag) { this.tag = tag; this.kids = []; this.dataset = {}; this.parent = null; this.className = ""; this.hidden = false; }
  append(...ks) { for (const k of ks) { const n = typeof k === "string" ? { text: k, parent: null } : k; if (n.parent?.kids) n.parent.kids = n.parent.kids.filter((x) => x !== n); n.parent = this; this.kids.push(n); } }
  prepend(...ks) { const old = this.kids; this.kids = []; this.append(...ks); this.kids.push(...old); }
  appendChild(k) { this.append(k); return k; }
  after(...ks) {
    const p = this.parent; if (!p) return;
    const ns = ks.map((k) => (typeof k === "string" ? { text: k } : k));
    for (const n of ns) { if (n.parent?.kids) n.parent.kids = n.parent.kids.filter((x) => x !== n); n.parent = p; }
    p.kids.splice(p.kids.indexOf(this) + 1, 0, ...ns);
  }
  remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((x) => x !== this); this.parent = null; }
  replaceChildren(...ks) { this.kids = []; this.append(...ks); }
  set textContent(v) { this.kids = [{ text: String(v), parent: this }]; }
  get textContent() { return this.kids.map((k) => (k instanceof El ? k.textContent : k.text)).join(""); }
  all() { return this.kids.filter((k) => k instanceof El).flatMap((k) => [k, ...k.all()]); }
}

// 假时钟:setTimeout / setInterval 只排队,advance(ms) 才往前走(「批准」的解锁时间要精确地测)
function fakeClock() {
  let now = 0, seq = 0;
  const q = new Map();
  const add = (fn, ms, every) => { const id = ++seq; q.set(id, { fn, at: now + Math.max(0, Number(ms) || 0), every }); return id; };
  return {
    setTimeout: (fn, ms) => add(fn, ms, 0),
    setInterval: (fn, ms) => add(fn, ms, Math.max(1, Number(ms) || 1)),
    clear: (id) => { q.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let id = null, t = null;
        for (const [k, v] of q) if (v.at <= end && (!t || v.at < t.at)) { id = k; t = v; }
        if (!t) break;
        now = t.at;
        if (t.every) t.at += t.every; else q.delete(id);
        t.fn();
      }
      now = end;
    },
    clearAll: () => q.clear(),
  };
}
// 能挂事件、能手动触发(focus / visibilitychange)
const evented = (o) => {
  const ls = {};
  o.addEventListener = (type, fn) => { (ls[type] ??= []).push(fn); };
  o.fire = (type) => { for (const fn of ls[type] ?? []) fn({ type }); };
  return o;
};

// 起一个页面:pending = /api/approve/pending 的回答,pair = /api/link/pending 的回答;返回 { win, doc, calls, es, flush, advance }
function page({ pending = [], pair = null, win: extra = {} } = {}) {
  const calls = [];
  const clock = fakeClock();
  const doc = evented({ body: new El("body"), head: new El("head"), hidden: false, createElement: (t) => new El(t) });
  let es = null;
  class FakeES { constructor(url) { this.url = url; this.readyState = 1; es = this; } close() { this.readyState = 2; } }
  // 批准 / 拒绝了就从待批列表里拿掉(和真服务器一样)
  const answers = { "/api/approve/pending": () => pending, "/api/link/pending": () => pair,
    "/api/approve/decide": (b) => { const i = pending.findIndex((x) => x.id === b.id); if (i >= 0) pending.splice(i, 1); return { ok: i >= 0 }; } };
  const fetch = async (path, opt) => {
    const body = opt?.body ? JSON.parse(opt.body) : null;
    calls.push({ path, headers: opt?.headers ?? {}, body });
    const v = answers[path]?.(body) ?? {};
    return { ok: true, status: 200, json: async () => v };
  };
  const win = evented({ ...extra });
  const ctx = { window: win, document: doc, fetch, EventSource: FakeES, console, JSON, Date, Math, Number, String, Array, Set, Map,
    setTimeout: clock.setTimeout, setInterval: clock.setInterval, clearTimeout: clock.clear, clearInterval: clock.clear, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const flush = () => new Promise((r) => setImmediate(r));
  return { win, doc, calls, get es() { return es; }, flush, advance: clock.advance, stop: clock.clearAll };
}
const card = (id, extra = {}) => ({ id, kind: "send", title: "转账", lines: ["从账号 1 转出"], origin: O, at: Date.now(), expiresAt: Date.now() + 90_000, ...extra });
const buttons = (p, text) => p.doc.body.all().filter((e) => e.tag === "button" && e.textContent === text);
const byText = (root, text) => root.all().findLast((e) => e.textContent === text);   // 最里面的那个(按钮,不是只装着它的那一行)

test("localpop:init 后马上取待批列表,每条一张卡片(标题 / 来源 / 每一行 / 倒计时),请求都带页面令牌", async () => {
  const a = { id: "a1", kind: "send", title: "转账", lines: ["从账号 1 转出", "数量:0.5 BNB", "⚠ 这个地址不是你的账号,也不是自动转出地址"], origin: O, at: Date.now(), expiresAt: Date.now() + 90_000 };
  const p = page({ pending: [a] });
  try {
    p.win.tpLocalPop.init(() => "tok123");
    await p.flush();
    assert.match(p.es.url, /^\/api\/stream\?t=tok123$/);
    assert.ok(p.calls.some((c) => c.path === "/api/approve/pending" && c.headers["x-panel-token"] === "tok123"));
    assert.ok(p.calls.some((c) => c.path === "/api/link/pending"));
    const txt = p.doc.body.textContent;
    for (const s of ["网站请求你批准", "转账", O, "从账号 1 转出", "数量:0.5 BNB", "秒后自动拒绝", "拒绝", "批准"]) assert.ok(txt.includes(s), s);
    assert.match(txt, /(89|90) 秒后自动拒绝/);
    assert.equal(byText(p.doc.body, "⚠ 这个地址不是你的账号,也不是自动转出地址").className, "tplp-warn");
    // 点「批准」(露出来 1 秒之后):带令牌 POST /api/approve/decide {id, ok:true},卡片拿掉
    p.advance(DELAY);
    await byText(p.doc.body, "批准").onclick();
    await p.flush();
    const d = p.calls.find((c) => c.path === "/api/approve/decide");
    assert.deepEqual(d.body, { id: "a1", ok: true });
    assert.equal(d.headers["x-panel-token"], "tok123");
    assert.ok(!p.doc.body.textContent.includes("从账号 1 转出"));
  } finally { p.stop(); }
});

test("localpop:「批准」刚出现是禁用的,露出来 1 秒才能点;页面拿到焦点 / 回到前台 / 卡片增减都重新等 1 秒;「拒绝」一直能点", async () => {
  const pending = [card("a1")];
  const p = page({ pending });
  try {
    p.win.tpLocalPop.init(() => "t");
    await p.flush();
    const [yes] = buttons(p, "批准"), [no] = buttons(p, "拒绝");
    assert.equal(yes.disabled, true, "刚出现:批准禁用");
    assert.ok(!no.disabled, "拒绝马上能点");
    await yes.onclick();   // 禁用时就算点到(浏览器本来不会触发),也不算批准
    assert.ok(!p.calls.some((c) => c.path === "/api/approve/decide"));
    p.advance(DELAY - 1);
    assert.equal(yes.disabled, true, "不到 1 秒还是禁用");
    p.advance(1);
    assert.equal(yes.disabled, false, "1 秒后能点");
    // 页面回到前台 / 拿到焦点:重新等 1 秒
    p.doc.fire("visibilitychange");
    assert.equal(yes.disabled, true, "visibilitychange 后重新禁用");
    p.advance(DELAY);
    assert.equal(yes.disabled, false);
    p.win.fire("focus");
    assert.equal(yes.disabled, true, "focus 后重新禁用");
    p.advance(DELAY);
    assert.equal(yes.disabled, false);
    // 页面在后台:一直禁用,回到前台才开始计时
    p.doc.hidden = true; p.doc.fire("visibilitychange");
    p.advance(10 * DELAY);
    assert.equal(yes.disabled, true, "后台时一直禁用");
    p.doc.hidden = false; p.doc.fire("visibilitychange");
    assert.equal(yes.disabled, true);
    p.advance(DELAY);
    assert.equal(yes.disabled, false);
    // 来了新卡片:新卡片和旧卡片都要重新等 1 秒
    pending.push(card("a2"));
    p.es.onmessage({ data: JSON.stringify({ type: "approve" }) });
    await p.flush();
    const ys = buttons(p, "批准");
    assert.equal(ys.length, 2);
    assert.deepEqual(ys.map((b) => b.disabled), [true, true], "插进新卡片后都禁用");
    p.advance(DELAY);
    assert.deepEqual(ys.map((b) => b.disabled), [false, false]);
    // 拒绝第一张(马上能点):第二张往上挪了,它的「批准」重新等 1 秒
    await buttons(p, "拒绝")[0].onclick();
    await p.flush();
    assert.deepEqual(p.calls.filter((c) => c.path === "/api/approve/decide").map((c) => c.body), [{ id: "a1", ok: false }]);
    const left = buttons(p, "批准");
    assert.equal(left.length, 1);
    assert.equal(left[0].disabled, true, "卡片挪了位置:重新禁用");
    p.advance(DELAY);
    assert.equal(left[0].disabled, false);
  } finally { p.stop(); }
});

test("localpop:「批准」还没解锁时,在批准框上按下鼠标(连点)会重新等 1 秒;解锁之后按下不影响", async () => {
  const p = page({ pending: [card("a1")] });
  try {
    p.win.tpLocalPop.init(() => "t");
    await p.flush();
    const [yes] = buttons(p, "批准");
    const box = yes.parent.parent;   // 这张批准卡片(按钮在 .tplp-row 里)
    assert.equal(typeof box.onpointerdown, "function", "卡片上要有按下鼠标的处理");
    // 网站弹出本机页面、骗人连点:每次按下都在 1 秒之内 → 一直解不了锁
    for (let i = 0; i < 10; i++) {
      p.advance(DELAY - 100);
      assert.equal(yes.disabled, true, `第 ${i + 1} 下之前还是禁用`);
      box.onpointerdown({ type: "pointerdown" });
    }
    p.advance(DELAY - 1);
    assert.equal(yes.disabled, true, "最后一下之后还不到 1 秒");
    p.advance(1);
    assert.equal(yes.disabled, false, "停手 1 秒后才能点");
    // 已经解锁:按下不会重新禁用(不然人永远点不到)
    box.onpointerdown({ type: "pointerdown" });
    assert.equal(yes.disabled, false);
    // 禁用的按钮不接鼠标事件(pointer-events:none),按在它上面的那一下落到卡片上,同样会重新计时
    assert.match(SRC, /button:disabled\s*\{[^}]*pointer-events:\s*none/);
  } finally { p.stop(); }
});

test("localpop:配对码和批准框在同一个容器里,批准框永远排第一个;页面上没有整页遮罩盖住批准框", async () => {
  const stackOf = (p) => p.doc.body.kids.filter((k) => k instanceof El);
  const pair = { code: "123456", origin: O, expiresIn: 100 };
  // 批准框先有、配对码后来
  const p = page({ pending: [card("a1")], pair });
  try {
    p.win.tpLocalPop.init(() => "t");
    await p.flush();
    const top = stackOf(p);
    assert.deepEqual(top.map((e) => e.className), ["tplp-stack"], "body 里只有这一个容器(配对码不是整页遮罩)");
    const kids = top[0].kids.filter((k) => k instanceof El);
    assert.equal(kids[0].className, "tplp-card tplp-ask", "批准框排第一个");
    assert.equal(kids[1].className, "tplp-card tplp-pair");
    assert.ok(kids[1].textContent.includes("123456"));
    // 配对码开着,批准照样能点
    p.advance(DELAY);
    await buttons(p, "批准")[0].onclick();
    assert.ok(p.calls.some((c) => c.path === "/api/approve/decide" && c.body.ok === true));
  } finally { p.stop(); }
  // 配对码先有、批准框后来:批准框插到配对码前面
  const pending = [];
  const q = page({ pending, pair });
  try {
    q.win.tpLocalPop.init(() => "t");
    await q.flush();
    pending.push(card("b1"));
    q.es.onmessage({ data: JSON.stringify({ type: "approve" }) });
    await q.flush();
    const kids = stackOf(q)[0].kids.filter((k) => k instanceof El);
    assert.deepEqual(kids.map((e) => e.className), ["tplp-card tplp-ask", "tplp-card tplp-pair"]);
  } finally { q.stop(); }
  // 样式里没有铺满整页的层(position:fixed + inset:0 之类)
  assert.doesNotMatch(SRC, /inset:\s*0/);
});

test("localpop:留言 / 名称的值放在不翻译的节点里(网页给的原文,英文界面照原样显示)", async () => {
  const a = { id: "t1", kind: "tip", title: "打赏作者", lines: ["账号 1 打赏作者 0.05 BNB", "留言:辛苦了"], origin: O, at: Date.now(), expiresAt: Date.now() + 60_000 };
  const p = page({ pending: [a] });
  try {
    p.win.tpLocalPop.init(() => "t");
    await p.flush();
    const v = byText(p.doc.body, "辛苦了");
    assert.equal(v.dataset.notr, "1");
    assert.equal(byText(p.doc.body, "留言").dataset.notr, undefined);
  } finally { p.stop(); }
});

test("localpop:事件 approve 重新取列表;linkpair 弹配对码;loginreq 交给页面的 tpLoginRequested / openLogin", async () => {
  const asked = [];
  const p = page({ win: { tpLoginRequested: (acct) => asked.push(acct) } });
  try {
    p.win.tpLocalPop.init(() => "t");
    await p.flush();
    const before = p.calls.filter((c) => c.path === "/api/approve/pending").length;
    p.es.onmessage({ data: JSON.stringify({ type: "approve" }) });
    await p.flush();
    assert.equal(p.calls.filter((c) => c.path === "/api/approve/pending").length, before + 1);
    // 配对:事件里没有码,向本机取
    const q = page({ pair: { code: "123456", origin: O, expiresIn: 100 } });
    q.win.tpLocalPop.init(() => "t");
    await q.flush();   // init 时就有进行中的配对 → 直接弹
    const t = q.doc.body.textContent;
    for (const s of ["123456", O, "请求连接你的钱包助手", "把这个码输进网页上的配对框", "秒内有效", "不是你自己在网站上点的「连接」,就别把这个码给任何人"]) assert.ok(t.includes(s), s);
    byText(q.doc.body, "关闭").onclick();
    assert.ok(!q.doc.body.textContent.includes("123456"));
    q.es.onmessage({ data: JSON.stringify({ type: "linkpair", origin: O }) });
    await q.flush();
    assert.ok(q.doc.body.textContent.includes("123456"), "linkpair 事件再弹一次");
    q.stop();
    // 登录请求
    p.es.onmessage({ data: JSON.stringify({ type: "loginreq", acct: "2" }) });
    p.es.onmessage({ data: JSON.stringify({ type: "loginreq", acct: "9" }) });   // 不认识的账号不理
    assert.deepEqual(asked, ["2"]);
  } finally { p.stop(); }
});

test("localpop:页面没有登录函数 → 小卡片「网站请求登录账号 N」链到 /", async () => {
  const p = page();
  try {
    p.win.tpLocalPop.init(() => "t");
    await p.flush();
    p.es.onmessage({ data: JSON.stringify({ type: "loginreq", acct: "1" }) });
    assert.ok(p.doc.body.textContent.includes("网站请求登录账号 1"));
    assert.equal(byText(p.doc.body, "去扫码登录 →").href, "/");
  } finally { p.stop(); }
});

test("localpop:stream: false 时不开自己的推送,页面转来的事件照样处理(hello = 重新连上,补取一次)", async () => {
  const asked = [];
  const p = page({ win: { tpLoginRequested: (acct) => asked.push(acct) } });
  try {
    p.win.tpLocalPop.event({ type: "loginreq", acct: "1" });   // init 之前转来的:不理
    p.win.tpLocalPop.init(() => "t", { stream: false });
    await p.flush();
    assert.equal(p.es, null, "不另开 EventSource");
    const n = (path) => p.calls.filter((c) => c.path === path).length;
    const a0 = n("/api/approve/pending"), l0 = n("/api/link/pending");
    assert.ok(a0 >= 1 && l0 >= 1, "init 时先取一次");
    p.win.tpLocalPop.event({ type: "approve" });
    p.win.tpLocalPop.event({ type: "trade", ca: "0x1" });   // 别的类型不管
    await p.flush();
    assert.equal(n("/api/approve/pending"), a0 + 1);
    p.win.tpLocalPop.event({ type: "hello" });
    await p.flush();
    assert.equal(n("/api/approve/pending"), a0 + 2);
    assert.equal(n("/api/link/pending"), l0 + 1);
    p.win.tpLocalPop.event({ type: "loginreq", acct: "2" });
    assert.deepEqual(asked, ["2"]);
  } finally { p.stop(); }
});

test("localpop:网站页面(window.TP_PUBLIC)上 init 什么都不做", async () => {
  const p = page({ win: { TP_PUBLIC: true } });
  try {
    p.win.tpLocalPop.init(() => "t");
    p.win.tpLocalPop.event({ type: "approve" });
    await p.flush();
    assert.equal(p.calls.length, 0);
    assert.equal(p.es, null);
    assert.equal(p.doc.body.kids.length, 0);
  } finally { p.stop(); }
});

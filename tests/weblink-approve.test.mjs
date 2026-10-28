// 网页 ⇄ 本地小助手:网页请求要本机批准(panel/weblink.mjs 第四部分)——批准队列、需批准的类型、批准文案、事件流可见范围、接口白名单
import http from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { COPY_DEFAULTS, newCopyTask, applyCopyEdit } from "../panel/copyparams.mjs";

const dir = mkdtempSync(join(tmpdir(), "weblink-approve-"));
process.env.AGENTBUY_DATA_DIR = dir;
delete process.env.AGENTBUY_WEB_ORIGINS;
const w = await import("../panel/weblink.mjs");

const LOCAL_ONLY = "这个操作只能在本机助手页面里做(http://127.0.0.1:4400)";
const OWN1 = "0x1111111111111111111111111111111111111111";
const OWN2 = "0xAbCdEf0000000000000000000000000000000002";
const AT = "0x3333333333333333333333333333333333333333";
const STRANGER = "0x9999999999999999999999999999999999999999";
const LIMITS = { webMaxBuyBnb: 0.5, webDailyBnb: 2, webMaxSlip: 25, webMaxSellSlip: 10 };
const ctx = (o = {}) => ({
  own: { 1: OWN1, 2: OWN2 }, atTarget: AT, limits: LIMITS, settings: { maxBuyBnb: 0, autoClaim: false },
  copyDefaults: { maxPerTrade: 0.05, dailyCap: 0.2 }, ...o,
});
// 批准的定时器是 unref 的(不拖住进程退出),测超时时要有个别的东西让事件循环别提前结束(真服务器里是 HTTP 服务器在撑着)
const keepAlive = () => { const t = setInterval(() => {}, 1000); return () => clearInterval(t); };
const req = (pairId = "p1", extra = {}) => ({ kind: "send", title: "转账", lines: ["a", "b"], origin: "https://tigerpower.online", pairId, ...extra });

test("HELPER_API 是 2", () => {
  assert.equal(w.HELPER_API, 2);
});

// ── 批准队列 ──

test("requestApproval:decideApproval(id, true) → 解析 true,队列清空", async () => {
  const p = w.requestApproval(req());
  const [it] = w.pendingApprovals();
  assert.equal(w.pendingApprovals().length, 1);
  assert.match(it.id, /^[0-9a-f]{12}$/);
  assert.equal(w.decideApproval(it.id, true), true);
  assert.equal(await p, true);
  assert.deepEqual(w.pendingApprovals(), []);
});

test("requestApproval:decideApproval(id, false) → 解析 false,队列清空", async () => {
  const p = w.requestApproval(req());
  const [it] = w.pendingApprovals();
  assert.equal(w.decideApproval(it.id, false), true);
  assert.equal(await p, false);
  assert.deepEqual(w.pendingApprovals(), []);
});

test("requestApproval:超时没人批准 → 当作拒绝(false),队列清空", async () => {
  const stop = keepAlive();
  try {
    const p = w.requestApproval(req(), { timeoutMs: 30 });
    assert.equal(w.pendingApprovals().length, 1);
    assert.equal(await p, false);
    assert.deepEqual(w.pendingApprovals(), []);
  } finally { stop(); }
});

test("pendingApprovals 的形状:id / kind / title / lines / origin / at / expiresAt,不带 pairId 和内部句柄", async () => {
  const p = w.requestApproval(req("p1", { kind: "tip", title: "打赏作者", lines: ["x"] }), { timeoutMs: 5000, now: () => 1_000_000 });
  const [it] = w.pendingApprovals();
  assert.deepEqual(Object.keys(it).sort(), ["at", "expiresAt", "id", "kind", "lines", "origin", "title"]);
  assert.equal(it.kind, "tip");
  assert.equal(it.title, "打赏作者");
  assert.deepEqual(it.lines, ["x"]);
  assert.equal(it.origin, "https://tigerpower.online");
  assert.equal(it.at, 1_000_000);
  assert.equal(it.expiresAt, 1_005_000);
  it.lines.push("改了返回值");
  assert.deepEqual(w.pendingApprovals()[0].lines, ["x"], "返回的是副本");
  w.decideApproval(it.id, false);
  await p;
});

test("同一个配对最多 3 个在等,第 4 个同步抛 429;别的配对不受影响", async () => {
  const ps = [1, 2, 3].map(() => w.requestApproval(req("pA")));
  assert.throws(() => w.requestApproval(req("pA")), (e) => e instanceof Error && e.status === 429 && /等待批准的请求太多/.test(e.message));
  assert.equal(w.pendingApprovals().length, 3, "被拒的不进队列");
  const other = w.requestApproval(req("pB")); // 别的配对照样能请求
  assert.equal(w.pendingApprovals().length, 4);
  // 处理掉一个后,pA 又能请求
  const first = w.pendingApprovals()[0];
  w.decideApproval(first.id, false);
  const again = w.requestApproval(req("pA"));
  for (const it of w.pendingApprovals()) w.decideApproval(it.id, false);
  assert.deepEqual(await Promise.all([...ps, other, again]), [false, false, false, false, false]);
  assert.deepEqual(w.pendingApprovals(), []);
});

test("已处理的请求,它的定时器不会再来改结果或通知", async () => {
  const stop = keepAlive();
  try {
    let n = 0;
    const off = w.onApprovalChange(() => { n++; });
    const p = w.requestApproval(req(), { timeoutMs: 30 });
    w.decideApproval(w.pendingApprovals()[0].id, true);
    assert.equal(n, 2);
    await new Promise((r) => setTimeout(r, 80)); // 过了原定的超时时间
    assert.equal(await p, true);
    assert.equal(n, 2, "定时器已清掉,不会再通知");
    off();
  } finally { stop(); }
});

test("decideApproval:没有这个 id → false;已经处理过的再处理 → false", async () => {
  assert.equal(w.decideApproval("nope", true), false);
  const p = w.requestApproval(req());
  const [it] = w.pendingApprovals();
  assert.equal(w.decideApproval(it.id, true), true);
  assert.equal(w.decideApproval(it.id, false), false);
  assert.equal(await p, true, "第二次不会把结果改掉");
});

test("decideApproval:只有明确的 true 才算批准(1 / \"true\" / undefined 都算拒绝)", async () => {
  for (const v of [1, "true", undefined, null, "yes"]) {
    const p = w.requestApproval(req());
    w.decideApproval(w.pendingApprovals()[0].id, v);
    assert.equal(await p, false, String(v));
  }
});

test("onApprovalChange:新增和处理(批准 / 拒绝 / 超时)都会通知;取消订阅后不再通知", async () => {
  let n = 0;
  const seen = [];
  const off = w.onApprovalChange((list) => { n++; seen.push(list.length); });
  const p = w.requestApproval(req());
  assert.equal(n, 1, "新增通知一次");
  w.decideApproval(w.pendingApprovals()[0].id, true);
  assert.equal(n, 2, "处理通知一次");
  await p;
  assert.deepEqual(seen, [1, 0], "回调拿到的是当时的待批列表");
  const stop = keepAlive();
  const t = w.requestApproval(req(), { timeoutMs: 20 });
  assert.equal(n, 3);
  await t;
  stop();
  assert.equal(n, 4, "超时也通知");
  off();
  const p2 = w.requestApproval(req());
  w.decideApproval(w.pendingApprovals()[0].id, false);
  await p2;
  assert.equal(n, 4, "取消订阅后不再通知");
  assert.equal(w.decideApproval("nope", true), false);
  assert.equal(n, 4, "没处理成功的不通知");
});

test("onApprovalChange:某个订阅者抛错,不影响队列和别的订阅者", async () => {
  const origErr = console.error;
  console.error = () => {};
  let got = 0;
  const offBad = w.onApprovalChange(() => { throw new Error("坏订阅者"); });
  const offOk = w.onApprovalChange(() => { got++; });
  try {
    const p = w.requestApproval(req());
    assert.equal(w.decideApproval(w.pendingApprovals()[0].id, true), true);
    assert.equal(await p, true);
    assert.equal(got, 2);
  } finally { offBad(); offOk(); console.error = origErr; }
});

// ── 哪些请求要批准 ──

test("approvalKind:路径 → 类型", () => {
  const table = [
    ["/api/send", "send"], ["/api/tip", "tip"], ["/api/settings/set", "settings"],
    ["/api/autotransfer/target", "at-target"], ["/api/login/unpin", "unpin"], ["/api/link/limits", "limits"],
  ];
  for (const [p, k] of table) {
    assert.equal(w.approvalKind(p, {}), k, p);
    assert.equal(w.approvalKind(p, undefined), k, `${p} 没有 body 也一样`);
    assert.equal(w.approvalKind(`${p}?x=1`, {}), k, `${p} 带查询串`);
  }
});

test("approvalKind:自动转出开关只有「开」要批准,appconfirm 也是(on 必须严格 === true)", () => {
  assert.equal(w.approvalKind("/api/autotransfer/appconfirm", { on: true }), "at-appconfirm");
  assert.equal(w.approvalKind("/api/autotransfer/appconfirm", { on: false }), null);
  assert.equal(w.approvalKind("/api/autotransfer/set", { on: true }), "at-on");
  assert.equal(w.approvalKind("/api/autotransfer/set", { on: false }), null);
  for (const on of [1, "true", undefined, null, 0, ""]) {
    assert.equal(w.approvalKind("/api/autotransfer/set", { on }), null, `set on=${JSON.stringify(on)}`);
    assert.equal(w.approvalKind("/api/autotransfer/appconfirm", { on }), null, `appconfirm on=${JSON.stringify(on)}`);
  }
  assert.equal(w.approvalKind("/api/autotransfer/set", undefined), null);
  assert.equal(w.approvalKind("/api/autotransfer/set", null), null);
});

test("approvalKind:其它接口不要批准", () => {
  for (const p of ["/api/run", "/api/scan", "/api/copy", "/api/copy/pause-all", "/api/copy/tasks", "/api/autotransfer", "/api/settings", "/api/login/logout", "/api/link/state", "/api/link/revoke", "", undefined, null, 42]) {
    assert.equal(w.approvalKind(p, { on: true }), null, String(p));
  }
});

// ── 跟单策略 ──

test("webCopyTaskPolicy:模拟 → approve:false 且两层都写死 dryRun:true;真实 → approve:true 且两层都是 false", () => {
  assert.deepEqual(w.webCopyTaskPolicy({ target: "0xabc" }, []), { approve: false, body: { target: "0xabc", dryRun: true, params: { dryRun: true } } });
  assert.deepEqual(w.webCopyTaskPolicy({ target: "0xabc", params: { dryRun: true, x: 1 } }, []), { approve: false, body: { target: "0xabc", dryRun: true, params: { dryRun: true, x: 1 } } });
  assert.deepEqual(w.webCopyTaskPolicy({ target: "0xabc", params: { dryRun: false, x: 1 } }, []), { approve: true, body: { target: "0xabc", dryRun: false, params: { dryRun: false, x: 1 } } });
  assert.deepEqual(w.webCopyTaskPolicy({ target: "0xabc", dryRun: false }, []), { approve: true, body: { target: "0xabc", dryRun: false, params: { dryRun: false } } });
});

test("webCopyTaskPolicy:params 里有 dryRun 这个键就以它为准(引擎只读 params,!! 转布尔)", () => {
  for (const v of [false, 0, null, "", undefined]) {
    const r = w.webCopyTaskPolicy({ target: "0xabc", dryRun: true, params: { dryRun: v } }, []);
    assert.equal(r.approve, true, `dryRun=${String(v)}`);
    assert.equal(r.body.dryRun, false);
    assert.equal(r.body.params.dryRun, false);
  }
  for (const v of [true, 1, "yes"]) {
    const r = w.webCopyTaskPolicy({ target: "0xabc", dryRun: false, params: { dryRun: v } }, []);
    assert.equal(r.approve, false, `dryRun=${String(v)}`);
    assert.equal(r.body.dryRun, true);
    assert.equal(r.body.params.dryRun, true);
  }
});

test("webCopyTaskPolicy:params 没写 dryRun 时,已有真实任务(同 id)的修改也要批准,已有模拟任务的修改不用", () => {
  const tasks = [{ id: "real", params: { dryRun: false } }, { id: "sim", params: { dryRun: true } }, { id: "odd" }];
  assert.equal(w.webCopyTaskPolicy({ id: "real", amountBnb: 0.02 }, tasks).approve, true);
  assert.deepEqual(w.webCopyTaskPolicy({ id: "real", amountBnb: 0.02 }, tasks).body, { id: "real", amountBnb: 0.02, dryRun: false, params: { dryRun: false } });
  assert.equal(w.webCopyTaskPolicy({ id: "odd" }, tasks).approve, true, "没有 params.dryRun 的老任务在引擎眼里是真实的");
  assert.deepEqual(w.webCopyTaskPolicy({ id: "sim", amountBnb: 0.02 }, tasks), { approve: false, body: { id: "sim", amountBnb: 0.02, dryRun: true, params: { dryRun: true } } });
  assert.equal(w.webCopyTaskPolicy({ id: "nope" }, tasks).approve, false, "id 对不上 = 新建");
  // 顶层 dryRun === false 也算要开真实
  assert.equal(w.webCopyTaskPolicy({ id: "sim", dryRun: false }, tasks).approve, true);
  // 网页把真实任务明确改成模拟:不用批准(往安全方向走)
  assert.deepEqual(w.webCopyTaskPolicy({ id: "real", params: { dryRun: true } }, tasks), { approve: false, body: { id: "real", dryRun: true, params: { dryRun: true } } });
});

test("webCopyTaskPolicy:不改入参、乱输入不抛", () => {
  const body = { target: "0xabc", params: { dryRun: false } };
  const r = w.webCopyTaskPolicy(body, []);
  assert.deepEqual(body, { target: "0xabc", params: { dryRun: false } });
  assert.notEqual(r.body, body);
  for (const bad of [undefined, null, "x", 5, [], true]) {
    assert.deepEqual(w.webCopyTaskPolicy(bad, undefined), { approve: false, body: { dryRun: true, params: { dryRun: true } } }, JSON.stringify(bad) ?? "undefined");
    assert.doesNotThrow(() => w.webCopyTaskPolicy(bad, "not-array"));
  }
  assert.doesNotThrow(() => w.webCopyTaskPolicy({ id: "a" }, [null, undefined, 5, { id: "a", params: null }]));
  for (const bad of ["abc", [1, 2], 5, true]) {
    assert.deepEqual(w.webCopyTaskPolicy({ target: "0xabc", params: bad }, []), { approve: false, body: { target: "0xabc", dryRun: true, params: { dryRun: true } } }, JSON.stringify(bad));
  }
});

test("webPausePolicy:暂停不用批准,恢复(paused 不是真值)要批准,不抛", () => {
  assert.deepEqual(w.webPausePolicy({ paused: true }), { approve: false });
  assert.deepEqual(w.webPausePolicy({ paused: 1 }), { approve: false });
  for (const bad of [{}, { paused: false }, { paused: 0 }, { paused: null }, { paused: "" }, { other: 1 }, undefined, null]) {
    assert.deepEqual(w.webPausePolicy(bad), { approve: true }, JSON.stringify(bad) ?? "undefined");
  }
});

// ── 批准文案 ──

test("describeApproval 标题(逐字)", () => {
  const titles = {
    send: "转账", tip: "打赏作者", settings: "改设置", "at-target": "改自动转出地址",
    "at-appconfirm": "允许中风险转出去 App 确认", "at-on": "开启发射后自动转出", unpin: "解除账号地址锁定",
    limits: "改网页下单限额", "copy-real": "开启真实跟单", "copy-resume": "恢复全部跟单",
  };
  for (const [k, t] of Object.entries(titles)) assert.equal(w.describeApproval(k, {}, ctx()).title, t, k);
  assert.throws(() => w.describeApproval("nope", {}, ctx()), /未知/);
});

test("describeApproval send:收款是自己的账号 / 自动转出地址 / 陌生地址", () => {
  const own = w.describeApproval("send", { acct: "1", token: "BNB", amount: "0.5", to: OWN2 }, ctx());
  assert.ok(own.lines.some((l) => l.includes("你的账号 2")), own.lines.join("|"));
  assert.ok(!own.lines.some((l) => l.startsWith("⚠")));
  assert.ok(own.lines.some((l) => l.includes("0.5") && l.includes("BNB")));
  assert.ok(own.lines.some((l) => l.includes(OWN2)), "收款地址要完整显示");
  // 地址大小写不影响比较
  const lower = w.describeApproval("send", { acct: "1", token: "BNB", amount: "0.5", to: OWN2.toLowerCase() }, ctx());
  assert.ok(lower.lines.some((l) => l.includes("你的账号 2")));
  const at = w.describeApproval("send", { acct: "2", token: "BNB", amount: "1", to: AT.toUpperCase().replace("0X", "0x") }, ctx());
  assert.ok(at.lines.some((l) => l.includes("这是你设的自动转出地址")), at.lines.join("|"));
  const bad = w.describeApproval("send", { acct: "1", token: "BNB", amount: "0.5", to: STRANGER }, ctx());
  assert.ok(bad.lines.some((l) => l.startsWith("⚠")), bad.lines.join("|"));
  assert.ok(bad.lines.some((l) => l === "⚠ 这个地址不是你的账号,也不是自动转出地址"));
  assert.ok(bad.lines.some((l) => l.includes(STRANGER)));
  // 没设自动转出地址、没有 own:陌生地址照样警告,不会因为两边都是空而误判成「自己的」
  const none = w.describeApproval("send", { acct: "1", token: "BNB", amount: "1", to: STRANGER }, { own: {}, atTarget: null });
  assert.ok(none.lines.some((l) => l.startsWith("⚠")));
  const noCtx = w.describeApproval("send", { acct: "1", token: "BNB", amount: "1", to: "" }, undefined);
  assert.ok(noCtx.lines.some((l) => l.startsWith("⚠")), "空地址不能匹配上空的 own / atTarget");
});

test("describeApproval at-target:新地址同样标出是不是自己的", () => {
  const own = w.describeApproval("at-target", { to: OWN1, to2: OWN1 }, ctx());
  assert.ok(own.lines.some((l) => l.includes("你的账号 1")), own.lines.join("|"));
  const bad = w.describeApproval("at-target", { to: STRANGER, to2: STRANGER }, ctx());
  assert.ok(bad.lines.some((l) => l.startsWith("⚠")));
  assert.ok(bad.lines.some((l) => l.includes(STRANGER)));
  const clear = w.describeApproval("at-target", { to: "", to2: "" }, ctx());
  assert.ok(clear.lines.some((l) => l.includes("清空")), clear.lines.join("|"));
  assert.ok(!clear.lines.some((l) => l.startsWith("⚠")));
});

test("describeApproval tip / unpin / at-on / at-appconfirm / copy-resume", () => {
  const tip = w.describeApproval("tip", { acct: "2", amount: "0.1" }, ctx());
  assert.ok(tip.lines.some((l) => l.includes("账号 2") && l.includes("0.1") && l.includes("BNB")), tip.lines.join("|"));
  const unpin = w.describeApproval("unpin", { acct: "1" }, ctx());
  assert.ok(unpin.lines.some((l) => l.includes("账号 1")), unpin.lines.join("|"));
  const CA = "0x4444444444444444444444444444444444444444";
  const on = w.describeApproval("at-on", { ca: CA }, ctx());
  assert.ok(on.lines.some((l) => l.includes(CA)));
  assert.ok(on.lines.some((l) => l.includes(AT)), "写明发射后转去哪个地址");
  const noTarget = w.describeApproval("at-on", { ca: CA }, ctx({ atTarget: null }));
  assert.ok(noTarget.lines.some((l) => l.startsWith("⚠")), "还没设转出地址要提醒");
  const ac = w.describeApproval("at-appconfirm", { on: true }, ctx());
  assert.ok(ac.lines.length > 0 && ac.lines.some((l) => l.includes("App")));
  // 恢复全部跟单 = copyPauseAll(false):只解除全局暂停,任务自己的状态不变(暂停的还是暂停)
  const rs = w.describeApproval("copy-resume", {}, ctx());
  assert.deepEqual(rs.lines, ["解除全部暂停:状态是运行中的真实跟单任务会接着自动下单", "用的是钱包里的真钱;状态是暂停的任务还是暂停,不会启动"]);
  assert.ok(!rs.lines.some((l) => l.includes("重新开始")), "不能说被暂停的任务会重新开始");
});

test("describeApproval limits:每一项列成「名称:旧 → 新」,没改的项不列", () => {
  const r = w.describeApproval("limits", { webMaxBuyBnb: 1 }, { limits: { webMaxBuyBnb: 0.5, webDailyBnb: 2, webMaxSlip: 25, webMaxSellSlip: 10 } });
  assert.equal(r.lines.length, 1);
  assert.ok(r.lines[0].includes("0.5 → 1"), r.lines[0]);
  assert.match(r.lines[0], /^[^:]+:0\.5 → 1$/);
  const two = w.describeApproval("limits", { webMaxBuyBnb: "1", webMaxSellSlip: 5, other: 1 }, ctx());
  assert.equal(two.lines.length, 2, "不认识的键不列");
  assert.ok(two.lines.some((l) => l.endsWith(":0.5 → 1")));
  assert.ok(two.lines.some((l) => l.endsWith(":10 → 5")));
});

test("describeApproval settings:只列 params 里有的键;maxBuyBnb 的 0 显示成「不限」", () => {
  const a = w.describeApproval("settings", { maxBuyBnb: 0.3 }, ctx({ settings: { maxBuyBnb: 0, autoClaim: false } }));
  assert.equal(a.lines.length, 1);
  assert.ok(a.lines[0].includes("不限 → 0.3"), a.lines[0]);
  const b = w.describeApproval("settings", { maxBuyBnb: 0 }, ctx({ settings: { maxBuyBnb: 0.3, autoClaim: false } }));
  assert.ok(b.lines[0].includes("0.3 → 不限"), b.lines[0]);
  const c = w.describeApproval("settings", { autoClaim: true }, ctx());
  assert.equal(c.lines.length, 1);
  assert.match(c.lines[0], /:关 → 开$/);
  const both = w.describeApproval("settings", { maxBuyBnb: 1, autoClaim: false }, ctx({ settings: { maxBuyBnb: 2, autoClaim: true } }));
  assert.equal(both.lines.length, 2);
  assert.ok(both.lines.some((l) => l.endsWith(":开 → 关")));
});

test("describeApproval copy-real:列目标和单笔 / 每日上限,params 里没写的用默认", () => {
  const a = w.describeApproval("copy-real", { target: STRANGER, name: "大户", params: { maxPerTrade: 0.1, dryRun: false } }, ctx());
  assert.ok(a.lines.some((l) => l.includes(STRANGER)));
  assert.ok(a.lines.some((l) => l.includes("大户")));
  assert.ok(a.lines.some((l) => l.includes("0.1")), "单笔用 params 里的");
  assert.ok(a.lines.some((l) => l.includes("0.2")), "每日用默认");
  const b = w.describeApproval("copy-real", { target: STRANGER, params: { dryRun: false } }, ctx());
  assert.ok(b.lines.some((l) => l.includes("0.05")));
  assert.ok(b.lines.some((l) => l.includes("0.2")));
  assert.ok(!b.lines.some((l) => l.includes("大户")));
  const c = w.describeApproval("copy-real", { target: STRANGER, params: { maxPerTrade: 0, dailyCap: 0 } }, ctx());
  assert.ok(c.lines.some((l) => /^单笔.*:0 BNB/.test(l)), "单笔 0 就显示 0,不回退成默认");
  assert.ok(c.lines.some((l) => /^每日.*:0 BNB/.test(l)), "每日 0 就显示 0,不回退成默认");
});

test("describeApproval:每行都是字符串且不超过 200 字,值一律 String(),控制字符不会拆出假的一行", () => {
  const long = "x".repeat(500);
  const r = w.describeApproval("send", { acct: 1, token: long, amount: 0.5, to: `${STRANGER}\n⚠ 这是你的账号 1 的地址` }, ctx());
  for (const l of r.lines) { assert.equal(typeof l, "string"); assert.ok(l.length <= 200, `${l.length}`); assert.ok(!/[\r\n]/.test(l)); }
  const k = w.describeApproval("copy-real", { target: long, name: long, params: { maxPerTrade: 5 } }, ctx());
  for (const l of k.lines) assert.ok(l.length <= 200);
  const lim = w.describeApproval("limits", { webMaxBuyBnb: long }, ctx());
  for (const l of lim.lines) assert.ok(l.length <= 200);
  assert.doesNotThrow(() => w.describeApproval("send", undefined, undefined));
  assert.doesNotThrow(() => w.describeApproval("limits", null, {}));
  assert.doesNotThrow(() => w.describeApproval("settings", {}, {}));
});

// ── 事件流可见范围 ──

test("streamSees:local 全看;web 看不到 approve / linkpair / loginreq;wallet 只看白名单", () => {
  for (const t of ["approve", "linkpair", "loginreq", "trade", "notice", "anything"]) assert.equal(w.streamSees("local", t), true, `local ${t}`);
  for (const t of ["approve", "linkpair", "loginreq"]) assert.equal(w.streamSees("web", t), false, `web ${t}`);
  for (const t of ["trade", "notice", "hello", "copy-log", "lists", "anything"]) assert.equal(w.streamSees("web", t), true, `web ${t}`);
  for (const t of ["notice", "dropout", "lists", "copy-tasks", "copy-log"]) assert.equal(w.streamSees("wallet", t), true, `wallet ${t}`);
  // 追踪名单在网页浏览器里,追踪动态网页自己从网站的成交里补:助手的追踪事件不给 wallet(助手跟单用的追踪名单是它内部的)
  for (const t of ["track", "track-list", "trade", "approve", "linkpair", "loginreq", "hello", "anything", "", undefined]) assert.equal(w.streamSees("wallet", t), false, `wallet ${String(t)}`);
  assert.equal(w.streamSees("web", "approve"), false);
  assert.equal(w.streamSees("wallet", "trade"), false);
  // 不认识的范围 → 什么都不给看
  for (const s of ["nope", "", undefined, null]) assert.equal(w.streamSees(s, "notice"), false, String(s));
});

// ── 接口白名单(API 2) ──

test("webPolicy:API 2 新放行的 POST 接口", () => {
  for (const p of [
    "/api/send", "/api/tip", "/api/settings/set", "/api/autotransfer/target", "/api/autotransfer/set", "/api/autotransfer/appconfirm",
    "/api/login/unpin", "/api/login/request", "/api/mine", "/api/link/state", "/api/link/revoke", "/api/link/limits",
  ]) {
    assert.deepEqual(w.webPolicy("POST", p), { ok: true }, `POST ${p}`);
    assert.deepEqual(w.webPolicy("POST", `${p}?x=1`), { ok: true }, `POST ${p}?x=1`);
    assert.equal(w.webPolicy("GET", p).ok, false, `GET ${p}`);
  }
});

test("webPolicy:只能本机的接口 → 403 + 统一文案(GET / POST 都一样),其余 /api/link/* 也是", () => {
  for (const p of ["/api/login/start", "/api/link/pending", "/api/approve/pending", "/api/approve/decide", "/api/link/whatever", "/api/link/list", "/api/link/"]) {
    for (const m of ["POST", "GET"]) {
      assert.deepEqual(w.webPolicy(m, p), { ok: false, status: 403, error: LOCAL_ONLY }, `${m} ${p}`);
    }
  }
  assert.equal(w.webPolicy("POST", "/api/link/pending?x=/api/link/state").status, 403);
  assert.equal(w.webPolicy("POST", "/api/approve/decide#/api/run").status, 403);
});

test("webPolicy:GET /api/send 等方法不对 → 404", () => {
  for (const p of ["/api/send", "/api/tip", "/api/settings/set", "/api/link/state", "/api/mine"]) {
    assert.deepEqual(w.webPolicy("GET", p), { ok: false, status: 404, error: "没有这个接口" }, p);
  }
});

// ── /link/hello 报 kind ──

test("webGate 的 /link/hello:api 默认是 HELPER_API(2),kind 默认 full,可以传 kind", async () => {
  const O = "https://tigerpower.online";
  const hello = async (opts) => {
    const srv = http.createServer(async (rq, rs) => {
      const g = await w.webGate(rq, rs, { port: srv.address().port, build: 3, ...opts });
      if (!g.handled) { rs.writeHead(204); rs.end(); }
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      return await (await fetch(`http://127.0.0.1:${srv.address().port}/link/hello`, { headers: { origin: O } })).json();
    } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
  };
  assert.deepEqual(await hello({}), { app: "tigerpower-helper", api: 2, build: 3, kind: "full", paired: false });
  assert.deepEqual(await hello({ kind: "wallet", api: 5 }), { app: "tigerpower-helper", api: 5, build: 3, kind: "wallet", paired: false });
});

// ── 断开配对时拿掉它在等的批准 ──

test("dropPairApprovals:这个配对在等的全部当作拒绝、只通知一次;别的配对不受影响;返回拿掉了几条", async () => {
  let n = 0;
  const off = w.onApprovalChange(() => { n++; });
  const a1 = w.requestApproval(req("dropA")), a2 = w.requestApproval(req("dropA")), b1 = w.requestApproval(req("dropB"));
  n = 0;
  assert.equal(w.dropPairApprovals("dropA"), 2);
  assert.equal(n, 1, "一次拿掉多条只通知一次");
  assert.deepEqual(await Promise.all([a1, a2]), [false, false]);
  assert.deepEqual(w.pendingApprovals().map((a) => a.origin), ["https://tigerpower.online"], "dropB 的还在");
  assert.equal(w.dropPairApprovals("dropA"), 0);
  assert.equal(w.dropPairApprovals(undefined), 0);
  assert.equal(w.dropPairApprovals(null), 0);
  assert.equal(n, 1, "什么都没拿掉就不通知");
  assert.equal(w.decideApproval(w.pendingApprovals()[0].id, true), true);
  assert.equal(await b1, true);
  off();
});

test("dropPairApprovals:拿掉的请求,它的定时器不会再来通知", async () => {
  const stop = keepAlive();
  try {
    let n = 0;
    const off = w.onApprovalChange(() => { n++; });
    const p = w.requestApproval(req("dropT"), { timeoutMs: 30 });
    assert.equal(w.dropPairApprovals("dropT"), 1);
    assert.equal(await p, false);
    const seen = n;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(n, seen);
    off();
  } finally { stop(); }
});

// ── 转账 / 打赏的附加选项也写进批准框 ──

test("describeApproval send:中风险去 App 确认、只模拟 都单独一行;只认严格的 true", () => {
  const TOKEN = "0x5555555555555555555555555555555555555555";
  const app = w.describeApproval("send", { acct: "1", token: TOKEN, amount: "5", to: OWN2, appConfirm: true }, ctx());
  assert.ok(app.lines.includes("风险提示时提交到币安 App 确认"), app.lines.join("|"));
  for (const v of [false, 1, "true", undefined]) {
    const r = w.describeApproval("send", { acct: "1", token: TOKEN, amount: "5", to: OWN2, appConfirm: v }, ctx());
    assert.ok(!r.lines.some((l) => l.includes("App")), `appConfirm=${String(v)}`);
  }
  const dry = w.describeApproval("send", { acct: "1", token: "BNB", amount: "1", to: OWN2, dry: true }, ctx());
  assert.ok(dry.lines.includes("只模拟,不会真的转出"), dry.lines.join("|"));
  assert.ok(!w.describeApproval("send", { acct: "1", token: "BNB", amount: "1", to: OWN2, dry: 1 }, ctx()).lines.some((l) => l.includes("模拟")));
});

test("describeApproval tip:留言、中风险去 App 确认、只模拟;留言里的换行不会拆出假的一行", () => {
  const t = w.describeApproval("tip", { acct: "2", amount: "0.1", memo: "加油\n⚠ 这是你的账号 1 的地址", appConfirm: true }, ctx());
  assert.ok(t.lines.some((l) => l.startsWith("留言:加油")), t.lines.join("|"));
  assert.ok(!t.lines.some((l) => l.startsWith("⚠")), "留言里夹带的换行被换成空格");
  assert.ok(t.lines.includes("风险提示时提交到币安 App 确认"));
  for (const memo of [undefined, null, ""]) {
    const r = w.describeApproval("tip", { acct: "2", amount: "0.1", memo }, ctx());
    assert.ok(!r.lines.some((l) => l.startsWith("留言")), `memo=${String(memo)}`);
    assert.ok(!r.lines.some((l) => l.includes("App")));
  }
  assert.ok(w.describeApproval("tip", { acct: "2", amount: "0.1", dry: true }, ctx()).lines.includes("只模拟,不会真的转出"));
});

// ── 已有的真实跟单任务:只暂停 / 关闭 / 删除不用批准 ──

test("webCopyTaskPolicy:已有的真实任务只暂停 / 关闭 / 删除 → 不用批准,body 只留 id + status / delete(不写 dryRun、不碰 params)", () => {
  const tasks = [{ id: "real", params: { dryRun: false } }, { id: "sim", params: { dryRun: true } }, { id: "odd" }];
  for (const status of ["paused", "closed"]) {
    assert.deepEqual(w.webCopyTaskPolicy({ id: "real", status }, tasks), { approve: false, body: { id: "real", status } }, status);
    assert.deepEqual(w.webCopyTaskPolicy({ id: "odd", status }, tasks), { approve: false, body: { id: "odd", status } }, `odd ${status}`);
  }
  assert.deepEqual(w.webCopyTaskPolicy({ id: "real", delete: true }, tasks), { approve: false, body: { id: "real", delete: true } });
  assert.deepEqual(w.webCopyTaskPolicy({ id: "real", status: "closed", delete: true }, tasks), { approve: false, body: { id: "real", status: "closed", delete: true } });
  const body = { id: "real", status: "paused" };
  assert.notEqual(w.webCopyTaskPolicy(body, tasks).body, body, "返回的是副本");
});

test("webCopyTaskPolicy:真实任务的启动、改参数、改名、夹带别的键 → 照旧要批准", () => {
  const tasks = [{ id: "real", params: { dryRun: false } }];
  for (const b of [
    { id: "real", status: "running" },
    { id: "real", status: "paused", params: { maxPerTrade: 0.5 } },
    { id: "real", status: "paused", params: {} },
    { id: "real", status: "paused", name: "x" },
    { id: "real", status: "paused", dryRun: false },
    { id: "real", status: "paused", amountBnb: 0.02 },
    { id: "real", status: "PAUSED" },
    { id: "real", status: "" },
    { id: "real", delete: 1 },
    { id: "real", delete: false },
    { id: "real" },
  ]) {
    const r = w.webCopyTaskPolicy(b, tasks);
    assert.equal(r.approve, true, JSON.stringify(b));
    assert.equal(r.body.params.dryRun, false, JSON.stringify(b));
  }
});

test("webCopyTaskPolicy:模拟任务 / 新建的暂停照旧(两层写死 dryRun:true,不用批准)", () => {
  const tasks = [{ id: "sim", params: { dryRun: true } }];
  assert.deepEqual(w.webCopyTaskPolicy({ id: "sim", status: "paused" }, tasks), { approve: false, body: { id: "sim", status: "paused", dryRun: true, params: { dryRun: true } } });
  assert.deepEqual(w.webCopyTaskPolicy({ id: "nope", status: "paused" }, tasks), { approve: false, body: { id: "nope", status: "paused", dryRun: true, params: { dryRun: true } } });
});

// ── 网页限额:先校验(批准框照校验后的数字写),再落地 ──

test("parseWebLimits:只留认识的键并转成数字(\"5e1\" → 50);越界 / 坏值 / 不是对象 → 抛「限额数值不对」;只校验不落地", () => {
  assert.deepEqual(w.parseWebLimits({ webMaxSlip: "5e1", other: 1 }), { webMaxSlip: 50 });
  assert.deepEqual(w.parseWebLimits({ webMaxBuyBnb: "0.3", webDailyBnb: 4 }), { webMaxBuyBnb: 0.3, webDailyBnb: 4 });
  assert.deepEqual(w.parseWebLimits({}), {});
  for (const bad of [{ webMaxBuyBnb: 1000 }, { webMaxSlip: "" }, { webMaxSellSlip: "abc" }, { webDailyBnb: null }, null, [], "x"]) {
    assert.throws(() => w.parseWebLimits(bad), /限额数值不对/, JSON.stringify(bad));
  }
  const before = w.getWebLimits();
  w.parseWebLimits({ webMaxBuyBnb: 1 });
  assert.deepEqual(w.getWebLimits(), before, "只校验,不改");
  assert.deepEqual(w.setWebLimits({ webMaxBuyBnb: "1e-1" }), { ...before, webMaxBuyBnb: 0.1 }, "setWebLimits 用同一份校验");
});

// ── 等批准时网页断开 ──

test("clientGone:响应已销毁 / 已结束 / socket 关了 → true;还连着 → false", () => {
  assert.equal(w.clientGone({ destroyed: false, writableEnded: false, socket: { destroyed: false } }), false);
  assert.equal(w.clientGone({ destroyed: false, writableEnded: false, socket: null }), false);
  assert.equal(w.clientGone({ destroyed: true }), true);
  assert.equal(w.clientGone({ writableEnded: true }), true);
  assert.equal(w.clientGone({ socket: { destroyed: true } }), true);
});

test("批准相关的固定文案和 403 错误", () => {
  assert.equal(w.APPROVAL_WAIT_TEXT, "⏳ 等待本机助手批准…(请在本机助手页面点「批准」)");
  assert.equal(w.NOT_APPROVED, "本机没有批准");
  const e = w.notApproved();
  assert.ok(e instanceof Error);
  assert.equal(e.message, "本机没有批准");
  assert.equal(e.status, 403);
});

// ── 网页建 / 改跟单任务:批准框写的,就是批准后落地的(webCopyTaskPlan + checkCopyTaskUnchanged) ──

// 迷你跟单引擎:copyTask 和 copy.mjs 同一套(新建 newCopyTask / 修改 applyCopyEdit,都在 copyparams.mjs);
//   web(body) 和 server.mjs 的 /api/copy/tasks 网页分支一样:webCopyTaskPlan → 不用批准就马上执行;
//   要批准就返回 { plan, approve() },approve() = 本机点了「批准」之后那一段(再核对一次任务没被改过,才执行 execBody)
function copyEngine() {
  const tasks = [];
  let clock = 1_700_000_000_000;
  const copyTask = (body) => {
    if (body.target !== undefined && !body.id) { const t = newCopyTask(body, (clock += 1000)); tasks.push(t); return t; }
    const t = tasks.find((x) => x.id === body.id);
    if (!t) throw new Error("没有这个跟单任务");
    return applyCopyEdit(t, body);
  };
  const web = (body, opts) => {
    const plan = w.webCopyTaskPlan(body, tasks, opts);
    if (!plan.approve) return { plan, done: copyTask(plan.execBody) };
    return { plan, approve: () => { w.checkCopyTaskUnchanged(plan, tasks); return copyTask(plan.execBody); } };
  };
  return { tasks, web, copyTask };
}
const TGT = "0x7777777777777777777777777777777777777777";
const cardLines = (plan) => w.describeApproval("copy-real", plan.card, ctx()).lines;

test("C1 跟单:建模拟 → 请求开真实(等批准)→ 趁等批准用模拟修改把上限拉满 → 点批准:拒绝执行,任务还是模拟、还是暂停", () => {
  const e = copyEngine();
  // 1. 网页建模拟任务:不用批准
  const s = e.web({ target: TGT }).done;
  assert.equal(s.params.dryRun, true);
  assert.equal(s.status, "paused");
  // 2. 网页请求开真实 + 启动:要批准;批准框写的是单笔 0.05 / 每日 0.2
  const real = e.web({ id: s.id, status: "running", params: { dryRun: false } });
  assert.equal(real.plan.approve, true);
  assert.ok(cardLines(real.plan).includes("单笔上限:0.05 BNB(每个钱包)"), cardLines(real.plan).join("|"));
  assert.ok(cardLines(real.plan).includes("每日合计上限:0.2 BNB"));
  // 3. 等批准时:任务还是模拟的 → 模拟修改不用批准、马上执行,上限拉满
  const sneaky = e.web({ id: s.id, params: { maxPerTrade: 0.5, dailyCap: 50, maxPerToken: 10, maxCopies: 0, onlyFirst: false } });
  assert.equal(sneaky.plan.approve, false);
  assert.equal(s.params.maxPerTrade, 0.5);
  // 4. 用户点了批准:任务在等批准期间被改过 → 不执行(不会变成 0.5 / 50 的真实任务)
  assert.throws(() => real.approve(), (err) => err instanceof Error && /被改过/.test(err.message));
  assert.equal(s.params.dryRun, true, "还是模拟");
  assert.equal(s.status, "paused", "还是暂停");
  // 就算真的执行了,也只能是批准框里那一份参数(不会合到第 3 步改过的参数上)
  assert.equal(real.plan.execBody.params.maxPerTrade, 0.05);
  assert.equal(real.plan.execBody.params.dailyCap, 0.2);
});

test("C1 跟单:正常改真实任务 → 批准后任务的参数 / 名称 / 状态和批准框一模一样(批准框的参数是完整的一份)", () => {
  const e = copyEngine();
  const s = e.web({ target: TGT, name: "老名字" }).done;
  const r = e.web({ id: s.id, status: "running", name: "大户", params: { dryRun: false, maxPerTrade: 0.1, dailyCap: 1 } });
  assert.equal(r.plan.approve, true);
  for (const k of Object.keys(COPY_DEFAULTS)) assert.ok(Object.hasOwn(r.plan.card.params, k), `批准框参数缺 ${k}`);
  assert.deepEqual(r.plan.card, { target: TGT, name: "大户", params: r.plan.execBody.params });
  assert.equal(r.plan.card.params.dryRun, false);
  assert.deepEqual(r.plan.execBody, { id: s.id, status: "running", name: "大户", dryRun: false, params: r.plan.card.params });
  r.approve();
  assert.deepEqual(s.params, r.plan.card.params);
  assert.equal(s.name, "大户");
  assert.equal(s.status, "running");
  assert.ok(cardLines(r.plan).includes("单笔上限:0.1 BNB(每个钱包)"));
  // 已经是真实任务:只改参数(不带 dryRun)也要批准,落地照批准框
  const r2 = e.web({ id: s.id, params: { dailyCap: 2 } });
  assert.equal(r2.plan.approve, true);
  assert.equal(r2.plan.card.params.dailyCap, 2);
  assert.equal(r2.plan.card.params.maxPerTrade, 0.1, "没改的项照原任务");
  assert.equal(r2.plan.card.name, "大户");
  assert.equal(r2.plan.execBody.status, undefined, "没带 status 就不改状态");
  r2.approve();
  assert.deepEqual(s.params, r2.plan.card.params);
  assert.equal(s.status, "running");
});

test("C1 跟单:新建真实任务 → 批准后新任务的参数和批准框一样(新任务一律先暂停);名字截到 40 字,没起名用追踪名单里的", () => {
  const e = copyEngine();
  const r = e.web({ target: TGT.toUpperCase().replace("0X", "0x"), name: "x".repeat(60), params: { dryRun: false, maxPerTrade: 0.2, wallets: ["1", "2"] } });
  assert.equal(r.plan.approve, true);
  assert.equal(r.plan.print, null, "新建没有原任务可比");
  assert.equal(r.plan.card.target, TGT);
  assert.equal(r.plan.card.name, "x".repeat(40));
  for (const k of Object.keys(COPY_DEFAULTS)) assert.ok(Object.hasOwn(r.plan.card.params, k), `批准框参数缺 ${k}`);
  const t = r.approve();
  assert.deepEqual(t.params, r.plan.card.params);
  assert.equal(t.params.dryRun, false);
  assert.deepEqual(t.params.wallets, ["1", "2"]);
  assert.equal(t.name, "x".repeat(40));
  assert.equal(t.status, "paused");
  // 没起名:用追踪名单里的名字 / 推特
  const tracked = { [TGT]: { name: "", handle: "whale_x" } };
  const n = e.web({ target: TGT, params: { dryRun: false } }, { trackOf: (a) => tracked[a] });
  assert.equal(n.plan.card.name, "whale_x");
  assert.equal(n.plan.execBody.name, "whale_x");
});

test("C1 跟单:两条批准框改同一个任务,先批准的那条落地后,另一条再批准 → 拒绝执行", () => {
  const e = copyEngine();
  const s = e.web({ target: TGT }).done;
  const a = e.web({ id: s.id, params: { dryRun: false, maxPerTrade: 0.1 } });
  const b = e.web({ id: s.id, params: { dryRun: false, maxPerTrade: 0.3 } });
  b.approve();
  assert.equal(s.params.maxPerTrade, 0.3);
  assert.throws(() => a.approve(), /被改过/);
  assert.equal(s.params.maxPerTrade, 0.3);
});

test("C1 跟单:等批准时任务被本机暂停 / 关闭、或被删掉 → 批准后不执行", () => {
  const e = copyEngine();
  const s = e.web({ target: TGT }).done;
  e.copyTask({ id: s.id, status: "running" });
  const r = e.web({ id: s.id, params: { dryRun: false } });
  e.copyTask({ id: s.id, status: "closed" });   // 本机页面关掉了
  assert.throws(() => r.approve(), /被改过/);
  assert.equal(s.params.dryRun, true);
  const s2 = e.web({ target: TGT }).done;
  const r2 = e.web({ id: s2.id, params: { dryRun: false } });
  e.tasks.splice(e.tasks.indexOf(s2), 1);
  assert.throws(() => r2.approve(), /没有这个跟单任务/);
});

test("C1 跟单:进批准队列之前就能看出不对的,直接抛错(不弹批准框)", () => {
  const e = copyEngine();
  const s = e.web({ target: TGT }).done;
  assert.throws(() => e.web({ id: "nope", params: { dryRun: false } }), /没有这个跟单任务/);
  assert.throws(() => e.web({ id: s.id, status: "go", params: { dryRun: false } }), /状态不对/);
  assert.throws(() => e.web({ id: s.id, params: { dryRun: false, platforms: [] } }), /至少选一个平台/);
  e.copyTask({ id: s.id, status: "closed" });
  assert.throws(() => e.web({ id: s.id, status: "running", params: { dryRun: false } }), /已关闭的任务不能再启动/);
  assert.throws(() => e.web({ target: TGT, params: { dryRun: false, wallets: [] } }), /至少选一个钱包/);
});

test("C1 跟单:不用批准的(模拟 / 真实任务只暂停关闭删除)照旧:execBody 就是 webCopyTaskPolicy 的 body,card / print 为 null", () => {
  const tasks = [{ id: "real", target: TGT, status: "running", params: { ...COPY_DEFAULTS, dryRun: false } }, { id: "sim", target: TGT, status: "paused", params: { ...COPY_DEFAULTS } }];
  for (const b of [{ target: TGT }, { id: "sim", params: { maxPerTrade: 0.3 } }, { id: "real", status: "paused" }, { id: "real", delete: true }, { id: "real", params: { dryRun: true } }]) {
    const plan = w.webCopyTaskPlan(b, tasks);
    const pol = w.webCopyTaskPolicy(b, tasks);
    assert.equal(plan.approve, false, JSON.stringify(b));
    assert.deepEqual(plan.execBody, pol.body, JSON.stringify(b));
    assert.equal(plan.card, null);
    assert.equal(plan.print, null);
  }
  assert.doesNotThrow(() => w.checkCopyTaskUnchanged(w.webCopyTaskPlan({ target: TGT }, tasks), tasks));
});

test("C1 跟单:任务指纹只看目标 / 状态 / 参数(键的顺序不算)", () => {
  const a = { id: "x", target: TGT, status: "running", name: "a", params: { dryRun: false, maxPerTrade: 0.1 }, stats: { buys: 1 } };
  const b = { id: "x", target: TGT, status: "running", name: "b", params: { maxPerTrade: 0.1, dryRun: false }, stats: { buys: 9 } };
  assert.equal(w.copyTaskPrint(a), w.copyTaskPrint(b));
  assert.notEqual(w.copyTaskPrint(a), w.copyTaskPrint({ ...b, status: "paused" }));
  assert.notEqual(w.copyTaskPrint(a), w.copyTaskPrint({ ...b, target: "0x1" }));
  assert.notEqual(w.copyTaskPrint(a), w.copyTaskPrint({ ...b, params: { ...b.params, maxPerTrade: 0.2 } }));
  assert.notEqual(w.copyTaskPrint(a), w.copyTaskPrint({ ...b, params: { ...b.params, wallets: ["1"] } }));
});

// ── 网页请求等批准:配对被断开(I1)/ 网页断开(I2) ──

// 真的配一次对(配对存在临时数据目录里),返回配对 id。两次开始配对至少隔 10 秒:时钟每次往前拨 20 秒
let pairClock = 2_000_000_000_000;
function pairUp() {
  pairClock += 20_000;
  w.startPair("https://tigerpower.online", pairClock);
  const { code } = w.pendingPair(pairClock);
  return w.finishPair("https://tigerpower.online", code, "测试", pairClock).id;
}
const UNPAIRED = "没配对或已断开,请重新连接本机助手";

test("I1 webApproval:配对还在 → 进队列,批准 → true;拒绝 → false", async () => {
  const id = pairUp();
  const p = w.webApproval(req(id));
  const a = w.pendingApprovals().at(-1);
  assert.equal(w.decideApproval(a.id, true), true);
  assert.equal(await p, true);
  const q = w.webApproval(req(id));
  w.decideApproval(w.pendingApprovals().at(-1).id, false);
  assert.equal(await q, false);
});

test("I1 webApproval:配对在写批准框的这几秒里被断开了 → 同步抛 401「没配对或已断开」,不进队列", () => {
  const id = pairUp();
  assert.equal(w.revokePair(id), true);
  const before = w.pendingApprovals().length;
  assert.throws(() => w.webApproval(req(id)), (e) => e instanceof Error && e.status === 401 && e.message === UNPAIRED);
  assert.equal(w.pendingApprovals().length, before);
  assert.throws(() => w.webApproval(req("no-such-pair")), (e) => e.status === 401);
  assert.throws(() => w.webApproval(req(undefined)), (e) => e.status === 401);
});

test("I1 webApproval:批准了,但执行前配对已经断开 → 抛 401,不执行", async () => {
  const id = pairUp();
  const p = w.webApproval(req(id));
  const a = w.pendingApprovals().at(-1);
  w.revokePair(id);   // 只撤配对、不作废它在等的批准(模拟两件事挨着发生)
  w.decideApproval(a.id, true);
  await assert.rejects(p, (e) => e.status === 401 && e.message === UNPAIRED);
});

test("I1 webApproval:同一个配对 3 条在等,第 4 条照旧同步抛 429", async () => {
  const id = pairUp();
  const ps = [1, 2, 3].map(() => w.webApproval(req(id)));
  assert.throws(() => w.webApproval(req(id)), (e) => e.status === 429);
  w.dropPairApprovals(id);
  assert.deepEqual(await Promise.all(ps), [false, false, false]);
});

test("I2 requestApproval:signal 中止(网页断开)→ 这一条马上当作拒绝、拿出队列、通知一次,腾出名额", async () => {
  let n = 0;
  const off = w.onApprovalChange(() => { n++; });
  try {
    const acs = [1, 2, 3].map(() => new AbortController());
    const ps = acs.map((ac) => w.requestApproval(req("pSig"), { signal: ac.signal }));
    assert.throws(() => w.requestApproval(req("pSig")), (e) => e.status === 429);
    n = 0;
    acs[0].abort();
    assert.equal(await ps[0], false);
    assert.equal(n, 1, "撤掉通知一次");
    assert.equal(w.pendingApprovals().length, 2);
    const again = w.requestApproval(req("pSig"));   // 名额腾出来了
    assert.equal(w.pendingApprovals().length, 3);
    // 已经处理过的再中止:什么都不发生
    const first = w.pendingApprovals()[0];
    w.decideApproval(first.id, true);
    assert.equal(await ps[1], true);
    n = 0;
    acs[1].abort();
    assert.equal(n, 0, "处理过的不会再通知");
    w.dropPairApprovals("pSig");
    assert.deepEqual(await Promise.all([ps[2], again]), [false, false]);
  } finally { off(); }
});

test("I2 requestApproval:signal 已经中止 → 不进队列、不通知,直接当作拒绝", async () => {
  let n = 0;
  const off = w.onApprovalChange(() => { n++; });
  try {
    const ac = new AbortController();
    ac.abort();
    const before = w.pendingApprovals().length;
    assert.equal(await w.requestApproval(req("pPre"), { signal: ac.signal }), false);
    assert.equal(w.pendingApprovals().length, before);
    assert.equal(n, 0);
  } finally { off(); }
});

test("I2 clientGoneSignal:响应关闭(网页断开)时中止;一开始就断了 → 已经中止", () => {
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, socket: { destroyed: false } });
  const s = w.clientGoneSignal(res);
  assert.equal(s.aborted, false);
  res.emit("close");
  assert.equal(s.aborted, true);
  const dead = Object.assign(new EventEmitter(), { destroyed: true });
  assert.equal(w.clientGoneSignal(dead).aborted, true);
});

test("I2 webApproval 带 signal:网页断开 → 撤掉、返回 false", async () => {
  const id = pairUp();
  const ac = new AbortController();
  const p = w.webApproval(req(id), { signal: ac.signal });
  const n = w.pendingApprovals().length;
  ac.abort();
  assert.equal(await p, false);
  assert.equal(w.pendingApprovals().length, n - 1);
});

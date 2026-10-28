// 网页 ⇄ 本地小助手:接口白名单、限额、下单记录(panel/weblink.mjs 第二部分)
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "weblink-policy-"));
process.env.AGENTBUY_DATA_DIR = dir;
delete process.env.AGENTBUY_WEB_ORIGINS;
const w = await import("../panel/weblink.mjs");

const LOCAL_ONLY = "这个操作只能在本机助手页面里做(http://127.0.0.1:4400)";
const DEFAULTS = { webMaxBuyBnb: 0.5, webDailyBnb: 2, webMaxSlip: 25, webMaxSellSlip: 10 };
const limitsFile = () => JSON.parse(readFileSync(join(dir, "web-limits.json"), "utf8"));
// 本机日期的正午:+86_400_000 一定落在下一个本机日期(夏令时也不会错天)
const NOON = new Date(2026, 9, 28, 12, 0, 0).getTime();
const DAY = 86_400_000;

// ── 接口白名单 ──

const GET_OK = ["/api/stream", "/api/live-status", "/api/update-status", "/health"];
const POST_OK = [
  "/api/scan", "/api/trades", "/api/prefetch", "/api/inspect", "/api/history", "/api/notes", "/api/ticker",
  "/api/tradespage", "/api/trader", "/api/lists", "/api/lists/op", "/api/settings", "/api/autotransfer",
  "/api/approvals", "/api/approvals/revoke", "/api/quote", "/api/quote-balances", "/api/latency-stats",
  "/api/wallets", "/api/run", "/api/login/status", "/api/login/logout", "/api/tip-info",
  "/api/cache-status", "/api/track", "/api/track/add", "/api/track/update", "/api/track/remove",
  "/api/track/group", "/api/track/backfill", "/api/track/feed", "/api/copy", "/api/copy/pause-all",
  "/api/copy/tasks",
  // API 2:钱包相关的操作网页也能请求,但服务器端要本机批准(见 weblink-approve.test.mjs)
  "/api/send", "/api/tip", "/api/settings/set", "/api/autotransfer/target", "/api/autotransfer/set", "/api/autotransfer/appconfirm",
  "/api/login/unpin", "/api/login/request", "/api/mine", "/api/link/state", "/api/link/revoke", "/api/link/limits",
];
const LOCAL_PATHS = [
  "/api/login/start", "/api/link/pending", "/api/approve/pending", "/api/approve/decide", "/api/link/list", "/api/link/whatever",
];

test("webPolicy 放行清单里的 GET / POST", () => {
  assert.deepEqual(w.webPolicy("POST", "/api/run"), { ok: true });
  assert.deepEqual(w.webPolicy("GET", "/api/stream"), { ok: true });
  for (const p of GET_OK) assert.deepEqual(w.webPolicy("GET", p), { ok: true }, `GET ${p}`);
  for (const p of POST_OK) assert.deepEqual(w.webPolicy("POST", p), { ok: true }, `POST ${p}`);
});

test("webPolicy 只能本机的接口 → 403 + 统一文案", () => {
  for (const p of LOCAL_PATHS) {
    for (const m of ["POST", "GET"]) {
      const r = w.webPolicy(m, p);
      assert.equal(r.ok, false, `${m} ${p}`);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(r.error, LOCAL_ONLY);
      assert.ok(r.error.includes("只能在本机助手页面"));
    }
  }
});

test("webPolicy 其他一律 404,页面也不开放", () => {
  for (const [m, p] of [["POST", "/api/whatever"], ["GET", "/"], ["GET", "/scan"], ["GET", "/pair"], ["GET", "/index.html"],
    ["GET", ""], ["POST", "/api/copyx"], ["POST", "/api/run/extra"], ["GET", "/api/linkage"]]) {
    assert.deepEqual(w.webPolicy(m, p), { ok: false, status: 404, error: "没有这个接口" }, `${m} ${p}`);
  }
});

test("webPolicy 方法要对得上:GET 只放 GET 清单,POST 只放 POST 清单", () => {
  assert.equal(w.webPolicy("POST", "/api/stream").status, 404);
  assert.equal(w.webPolicy("POST", "/health").status, 404);
  assert.equal(w.webPolicy("GET", "/api/run").status, 404);
  assert.equal(w.webPolicy("DELETE", "/api/run").status, 404);
  assert.equal(w.webPolicy("PUT", "/api/stream").status, 404);
  assert.equal(w.webPolicy("post", "/api/run").ok, true); // 方法名大小写不挑
});

test("webPolicy 带查询串也按路径判断(/api/stream?t=… 是实际用法)", () => {
  assert.equal(w.webPolicy("GET", "/api/stream?t=abc").ok, true);
  assert.equal(w.webPolicy("POST", "/api/run?x=1").ok, true);
  assert.equal(w.webPolicy("POST", "/api/send?x=1").ok, true);
  assert.equal(w.webPolicy("POST", "/api/link/pending?x=1").status, 403);
  assert.equal(w.webPolicy("POST", "/api/login/start#frag").status, 403);
  assert.equal(w.webPolicy("POST", "/api/whatever?/api/run").status, 404);
});

test("webPolicy 乱输入不抛、一律拒绝", () => {
  assert.equal(w.webPolicy(undefined, undefined).ok, false);
  assert.equal(w.webPolicy(null, null).status, 404);
  assert.equal(w.webPolicy("POST", 42).status, 404);
});

// ── 跟单任务 / 暂停 ──
// 网页可以请求开真实跟单 / 恢复跟单,但要本机批准:这两个函数只判断「要不要批准」并把 body 里的 dryRun 两层写成一致,不再抛错

test("webCopyTaskPolicy:新建模拟任务不用批准,params 和顶层两层都写死 true,保留其他字段", () => {
  const body = { target: "0xabc", amountBnb: 0.01 };
  const r = w.webCopyTaskPolicy(body, []);
  assert.deepEqual(r, { approve: false, body: { target: "0xabc", amountBnb: 0.01, dryRun: true, params: { dryRun: true } } });
  assert.equal(body.dryRun, undefined, "不改入参");
  assert.equal(body.params, undefined, "不改入参");
  assert.equal(w.webCopyTaskPolicy({ ...body, dryRun: true }, []).body.dryRun, true);
  // 带了 params:其他参数原样保留,dryRun 在 params 里也是 true
  const withParams = { target: "0xabc", params: { amountBnb: 0.02, slippage: 10, dryRun: true } };
  assert.deepEqual(w.webCopyTaskPolicy(withParams, []), {
    approve: false, body: { target: "0xabc", dryRun: true, params: { amountBnb: 0.02, slippage: 10, dryRun: true } },
  });
  assert.equal(withParams.params.dryRun, true);
  // params 里写成真值但不是 true(1 / "yes"):也改成 true
  assert.equal(w.webCopyTaskPolicy({ target: "0xabc", params: { dryRun: 1 } }, []).body.params.dryRun, true);
  assert.equal(w.webCopyTaskPolicy({ target: "0xabc", params: { dryRun: "yes" } }, []).body.params.dryRun, true);
});

test("webCopyTaskPolicy:body.dryRun === false(params 没写 dryRun)→ 要批准,两层都写成 false", () => {
  assert.deepEqual(w.webCopyTaskPolicy({ dryRun: false }, []), { approve: true, body: { dryRun: false, params: { dryRun: false } } });
  assert.deepEqual(w.webCopyTaskPolicy({ id: "t1", dryRun: false }, [{ id: "t1", params: { dryRun: true } }]),
    { approve: true, body: { id: "t1", dryRun: false, params: { dryRun: false } } });
});

test("webCopyTaskPolicy:params.dryRun 为 false / 0 / null / \"\" 要批准(新建)——引擎只读 params 且用 !! 转布尔", () => {
  for (const v of [false, 0, null, "", undefined, NaN]) {
    const r = w.webCopyTaskPolicy({ target: "0xabc", params: { dryRun: v } }, []);
    assert.equal(r.approve, true, `create params.dryRun=${String(v)}`);
    assert.equal(r.body.dryRun, false);
    assert.equal(r.body.params.dryRun, false);
  }
  // JSON 实际会送来的形状
  assert.equal(w.webCopyTaskPolicy(JSON.parse('{"target":"0xabc","params":{"dryRun":false}}'), []).approve, true);
  assert.equal(w.webCopyTaskPolicy(JSON.parse('{"target":"0xabc","params":{"dryRun":null}}'), []).approve, true);
});

test("webCopyTaskPolicy:改模拟任务时 params.dryRun 为 false / 0 / null / \"\" 要批准(把它变成真实)", () => {
  const tasks = [{ id: "t2", params: { dryRun: true } }];
  for (const v of [false, 0, null, "", undefined]) {
    const r = w.webCopyTaskPolicy({ id: "t2", params: { dryRun: v } }, tasks);
    assert.equal(r.approve, true, `edit params.dryRun=${String(v)}`);
    assert.equal(r.body.params.dryRun, false);
  }
});

test("webCopyTaskPolicy:params 没写 dryRun 时,改真实任务要批准(两层写成 false),改模拟任务不用批准(两层保持 true)", () => {
  const tasks = [{ id: "t1", params: { dryRun: false } }, { id: "t2", params: { dryRun: true } }];
  assert.deepEqual(w.webCopyTaskPolicy({ id: "t1" }, tasks), { approve: true, body: { id: "t1", dryRun: false, params: { dryRun: false } } });
  assert.equal(w.webCopyTaskPolicy({ id: "t1", status: "running" }, tasks).approve, true);
  // 已有任务的 params.dryRun 不是真值(没有 params / 没写 dryRun / 0 / null / "")= 引擎眼里的真实任务,改它也要批准
  const odd = [{ id: "a" }, { id: "b", params: {} }, { id: "c", params: { dryRun: 0 } }, { id: "d", params: { dryRun: null } }, { id: "e", params: { dryRun: "" } }, { id: "f", params: null }];
  for (const o of odd) {
    const r = w.webCopyTaskPolicy({ id: o.id, amountBnb: 0.02 }, odd);
    assert.equal(r.approve, true, JSON.stringify(o));
    assert.equal(r.body.params.dryRun, false, JSON.stringify(o));
  }
  assert.deepEqual(w.webCopyTaskPolicy({ id: "g" }, [{ id: "g", params: { dryRun: 1 } }]), { approve: false, body: { id: "g", dryRun: true, params: { dryRun: true } } }, "真值的 dryRun 是模拟任务,改它不用批准");
  // 网页明确把真实任务改成模拟(params.dryRun 是真值):往安全方向走,不用批准
  assert.deepEqual(w.webCopyTaskPolicy({ id: "t1", params: { dryRun: true } }, tasks), { approve: false, body: { id: "t1", dryRun: true, params: { dryRun: true } } });
  // params 不在 body 里也补上 params.dryRun = true
  assert.deepEqual(w.webCopyTaskPolicy({ id: "t2", amountBnb: 0.02 }, tasks),
    { approve: false, body: { id: "t2", amountBnb: 0.02, dryRun: true, params: { dryRun: true } } });
  assert.deepEqual(w.webCopyTaskPolicy({ id: "t2", params: { slippage: 5 } }, tasks),
    { approve: false, body: { id: "t2", dryRun: true, params: { slippage: 5, dryRun: true } } });
  assert.deepEqual(w.webCopyTaskPolicy({ id: "t2", params: { dryRun: true, maxCopies: 2 } }, tasks),
    { approve: false, body: { id: "t2", dryRun: true, params: { dryRun: true, maxCopies: 2 } } });
  // id 对不上任何已有任务 → 当新建
  assert.equal(w.webCopyTaskPolicy({ id: "nope" }, tasks).approve, false);
  // 顶层 dryRun 写成 0 / "false" 之类(不是 === false,引擎也不读):不用批准,一律改成 true
  assert.equal(w.webCopyTaskPolicy({ dryRun: 0 }, []).body.dryRun, true);
  assert.equal(w.webCopyTaskPolicy({ dryRun: "false" }, []).body.dryRun, true);
  assert.deepEqual(w.webCopyTaskPolicy(undefined, undefined), { approve: false, body: { dryRun: true, params: { dryRun: true } } });
  assert.deepEqual(w.webCopyTaskPolicy("x", []), { approve: false, body: { dryRun: true, params: { dryRun: true } } });
  // params 不是对象(字符串 / 数组 / 数字):引擎读不出 dryRun,这里换成只含 dryRun 的对象
  for (const bad of ["abc", [1, 2], 5, true]) {
    assert.deepEqual(w.webCopyTaskPolicy({ target: "0xabc", params: bad }, []), { approve: false, body: { target: "0xabc", dryRun: true, params: { dryRun: true } } }, JSON.stringify(bad));
  }
});

test("webPausePolicy:暂停(paused 为真)不用批准,恢复(其余一律)要批准,都不抛", () => {
  assert.deepEqual(w.webPausePolicy({ paused: true }), { approve: false });
  assert.deepEqual(w.webPausePolicy({ paused: 1 }), { approve: false }); // server 里 !!b.paused 也是暂停
  for (const bad of [{}, { paused: false }, { paused: 0 }, { paused: null }, { paused: "" }, { paused: undefined }, { other: 1 }, undefined, null]) {
    assert.deepEqual(w.webPausePolicy(bad), { approve: true }, JSON.stringify(bad) ?? "undefined");
  }
});

// ── 限额 ──

test("getWebLimits 默认值", () => {
  assert.deepEqual(w.getWebLimits(), DEFAULTS);
});

test("setWebLimits 越界 / 非数字抛 限额数值不对,且不改任何值", () => {
  const bad = [
    { webDailyBnb: -1 }, { webDailyBnb: 0 }, { webDailyBnb: 1001 }, { webDailyBnb: 0.009 },
    { webMaxBuyBnb: 0 }, { webMaxBuyBnb: 100.01 }, { webMaxBuyBnb: 0.001 },
    { webMaxSlip: 0.5 }, { webMaxSlip: 51 }, { webMaxSellSlip: 0 }, { webMaxSellSlip: 0.99 }, { webMaxSellSlip: 51 },
    { webMaxSellSlip: "abc" }, { webMaxSellSlip: null }, { webMaxSellSlip: true },
    { webMaxSlip: NaN }, { webMaxSlip: Infinity }, { webMaxSlip: "abc" }, { webMaxSlip: "" }, { webMaxSlip: null },
    { webMaxSlip: true }, { webMaxSlip: [] }, { webMaxSlip: {} },
    // 一项合法一项非法:整体拒绝,合法那项也不生效
    { webMaxBuyBnb: 1, webDailyBnb: -1 }, { webMaxSlip: 20, webMaxSellSlip: 60 },
  ];
  for (const p of bad) assert.throws(() => w.setWebLimits(p), { message: "限额数值不对" }, JSON.stringify(p));
  assert.throws(() => w.setWebLimits("x"), { message: "限额数值不对" });
  assert.throws(() => w.setWebLimits([]), { message: "限额数值不对" });
  assert.deepEqual(w.getWebLimits(), DEFAULTS);
});

test("setWebLimits 改一项、返回新值、落盘;边界值合法", () => {
  const r = w.setWebLimits({ webDailyBnb: 3 });
  assert.deepEqual(r, { webMaxBuyBnb: 0.5, webDailyBnb: 3, webMaxSlip: 25, webMaxSellSlip: 10 });
  assert.deepEqual(w.getWebLimits(), r);
  assert.deepEqual(limitsFile().limits, r);
  r.webDailyBnb = 999; // 返回的是副本
  assert.equal(w.getWebLimits().webDailyBnb, 3);
  assert.deepEqual(w.setWebLimits({ webMaxBuyBnb: 0.01, webDailyBnb: 1000, webMaxSlip: 50, webMaxSellSlip: 50 }), { webMaxBuyBnb: 0.01, webDailyBnb: 1000, webMaxSlip: 50, webMaxSellSlip: 50 });
  assert.deepEqual(w.setWebLimits({ webMaxBuyBnb: 100, webDailyBnb: 0.01, webMaxSlip: 1, webMaxSellSlip: 1 }), { webMaxBuyBnb: 100, webDailyBnb: 0.01, webMaxSlip: 1, webMaxSellSlip: 1 });
  assert.deepEqual(w.setWebLimits({ webMaxBuyBnb: "0.5", webDailyBnb: "2", webMaxSlip: "25", webMaxSellSlip: "10" }), DEFAULTS); // 数字字符串也认
  assert.deepEqual(w.setWebLimits({ webMaxSellSlip: 7 }), { ...DEFAULTS, webMaxSellSlip: 7 });
  assert.equal(limitsFile().limits.webMaxSellSlip, 7);
  w.setWebLimits({ webMaxSellSlip: 10 });
  assert.deepEqual(w.setWebLimits({}), DEFAULTS);
  assert.deepEqual(w.setWebLimits({ webMaxSlip: undefined, other: 1 }), DEFAULTS); // undefined / 未知字段忽略
  assert.deepEqual(w.getWebLimits(), DEFAULTS);
});

test("checkWebBuy:单笔上限、算不出 BNB", () => {
  assert.doesNotThrow(() => w.checkWebBuy(0.4, NOON));
  assert.doesNotThrow(() => w.checkWebBuy(0.5, NOON)); // 正好等于上限可以
  assert.throws(() => w.checkWebBuy(0.6, NOON), { message: "超过网页单笔上限 0.5 BNB" });
  for (const bad of [null, undefined, 0, -1, NaN, Infinity, "0.1", {}]) {
    assert.throws(() => w.checkWebBuy(bad, NOON), { message: "算不出这笔折合多少 BNB,网页下单不能放行" }, String(bad));
  }
  // 两个号同时买:单笔上限按每个号的金额比,每日上限按 金额 × 号数 算(用单独的一天,不影响下面「今天已用」的用例)
  const t = NOON + 40 * DAY;
  assert.doesNotThrow(() => w.checkWebBuy(0.3, t, 2)); // 每个号 0.3 ≤ 0.5,合计 0.6 ≤ 2
  assert.throws(() => w.checkWebBuy(0.6, t, 1), { message: "超过网页单笔上限 0.5 BNB" });
  w.recordWebBuy(1.5, t);
  assert.throws(() => w.checkWebBuy(0.3, t, 2), { message: "超过网页每日上限 2 BNB(今天已用 1.5)" }); // 1.5 + 0.6 > 2
  assert.doesNotThrow(() => w.checkWebBuy(0.3, t, 1)); // 1.5 + 0.3 ≤ 2
  for (const bad of [0, -1, 1.5, NaN, "2"]) assert.throws(() => w.checkWebBuy(0.1, t, bad), { message: "下单的号数不对" }, String(bad));
});

test("每日上限:今天已用累计,换天重新算", () => {
  assert.equal(w.webSpentToday(NOON), 0);
  for (let i = 0; i < 3; i++) w.recordWebBuy(0.5, NOON);
  w.recordWebBuy(0.3, NOON);
  assert.ok(Math.abs(w.webSpentToday(NOON) - 1.8) < 1e-9);
  assert.throws(() => w.checkWebBuy(0.4, NOON), { message: "超过网页每日上限 2 BNB(今天已用 1.8)" });
  assert.doesNotThrow(() => w.checkWebBuy(0.2, NOON)); // 1.8 + 0.2 正好 2,不超
  assert.doesNotThrow(() => w.checkWebBuy(0.4, NOON + DAY)); // 换天
  assert.equal(w.webSpentToday(NOON + DAY), 0);
  // 账本落盘:{ day: 本机日期, spent }
  const led = limitsFile().ledger;
  assert.equal(led.day, new Date(NOON).toLocaleDateString("sv-SE"));
  assert.match(led.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Math.abs(led.spent - 1.8) < 1e-9);
  // 第二天记一笔 → 账本滚到新的一天,从 0 开始
  w.recordWebBuy(0.25, NOON + DAY);
  assert.equal(w.webSpentToday(NOON + DAY), 0.25);
  assert.equal(limitsFile().ledger.day, new Date(NOON + DAY).toLocaleDateString("sv-SE"));
  assert.equal(limitsFile().ledger.spent, 0.25);
  assert.equal(w.webSpentToday(NOON), 0, "回到前一天:账本已经不是那天的了");
});

test("每日上限跟着 setWebLimits 走;小数累加不会误拦正好到上限的单", () => {
  const t = NOON + 10 * DAY;
  w.setWebLimits({ webDailyBnb: 1, webMaxBuyBnb: 1 });
  for (let i = 0; i < 9; i++) w.recordWebBuy(0.1, t);
  assert.doesNotThrow(() => w.checkWebBuy(0.1, t)); // 0.9 + 0.1 = 1,浮点误差不能拦
  w.recordWebBuy(0.1, t);
  assert.equal(w.webSpentToday(t), 1);
  assert.throws(() => w.checkWebBuy(0.01, t), { message: "超过网页每日上限 1 BNB(今天已用 1)" });
  w.setWebLimits(DEFAULTS);
});

test("recordWebBuy 金额不对就抛,不记账", () => {
  const t = NOON + 20 * DAY;
  for (const bad of [0, -1, NaN, Infinity, null, undefined, "1"]) assert.throws(() => w.recordWebBuy(bad, t), /记账金额不对/, String(bad));
  assert.equal(w.webSpentToday(t), 0);
});

test("clampWebSlip", () => {
  assert.equal(w.clampWebSlip(undefined), undefined);
  assert.equal(w.clampWebSlip(null), undefined);
  assert.equal(w.clampWebSlip(""), undefined);
  assert.equal(w.clampWebSlip("20"), 20);
  assert.equal(w.clampWebSlip(25), 25); // 正好等于上限可以
  assert.equal(w.clampWebSlip(0.5), 0.5);
  assert.throws(() => w.clampWebSlip(30), { message: "网页下单滑点最多 25%" });
  assert.throws(() => w.clampWebSlip("25.01"), { message: "网页下单滑点最多 25%" });
  assert.throws(() => w.clampWebSlip(Infinity), { message: "网页下单滑点最多 25%" });
  for (const bad of ["abc", NaN, {}, [], true]) assert.throws(() => w.clampWebSlip(bad), { message: "滑点数值不对" }, String(bad));
  w.setWebLimits({ webMaxSlip: 10 });
  assert.throws(() => w.clampWebSlip(11), { message: "网页下单滑点最多 10%" });
  assert.equal(w.clampWebSlip(10), 10);
  w.setWebLimits(DEFAULTS);
});

test("clampWebSlip 卖出看 webMaxSellSlip(默认 10),买入照旧看 webMaxSlip", () => {
  assert.equal(w.clampWebSlip(undefined, "sell"), undefined);
  assert.equal(w.clampWebSlip("", "sell"), undefined);
  assert.equal(w.clampWebSlip(10, "sell"), 10);
  assert.throws(() => w.clampWebSlip(10.5, "sell"), { message: "网页卖出滑点最多 10%" });
  assert.throws(() => w.clampWebSlip("25", "sell"), { message: "网页卖出滑点最多 10%" });
  assert.equal(w.clampWebSlip(25, "buy"), 25);
  assert.throws(() => w.clampWebSlip("x", "sell"), { message: "滑点数值不对" });
  w.setWebLimits({ webMaxSellSlip: 30 });
  assert.equal(w.clampWebSlip(30, "sell"), 30);
  assert.throws(() => w.clampWebSlip(31, "sell"), { message: "网页卖出滑点最多 30%" });
  w.setWebLimits(DEFAULTS);
});

// ── 登录 ──

test("登录:网页永远发起不了钱包登录(/api/login/start → 403 只能在本机助手页面,GET / POST / 带查询串都一样);查状态 / 退出照常放行", () => {
  const denied = { ok: false, status: 403, error: LOCAL_ONLY };
  for (const m of ["POST", "GET", "post"]) assert.deepEqual(w.webPolicy(m, "/api/login/start"), denied, m);
  for (const p of ["/api/login/start?acct=1", "/api/login/start?x=/api/login/status", "/api/login/start#frag"]) assert.deepEqual(w.webPolicy("POST", p), denied, p);
  assert.match(w.webPolicy("POST", "/api/login/start").error, /只能在本机助手页面/);
  for (const p of ["/api/login/status", "/api/login/logout"]) assert.deepEqual(w.webPolicy("POST", p), { ok: true }, p);
  assert.equal(w.webPolicy("GET", "/api/login/status").status, 404, "状态 / 退出只给 POST");
  assert.equal(w.webLoginPolicy, undefined, "旧的「已锁定地址的号才能网页登录」口子已经拆掉");
});

test("登录状态给网页(webLoginStatus):只留 state / address / expireAt / error / pin,二维码 svg、扫码链接 url、配对码 code 一律去掉", () => {
  const PIN = "0x1111111111111111111111111111111111111111";
  // 待扫码:session.mjs 的 loginStatus 带着二维码和链接
  const pending = { state: "pending", url: "https://www.binance.com/x?qr=abc", code: "AB12", expireAt: 1_700_000_000_000, svg: "<svg>二维码</svg>", pin: PIN };
  assert.deepEqual(w.webLoginStatus(pending), { state: "pending", expireAt: 1_700_000_000_000, pin: PIN });
  // 成功 / 扫错:地址和出错信息照给(网页靠 state 判断扫完没有)
  assert.deepEqual(w.webLoginStatus({ ...pending, state: "ok", address: PIN }), { state: "ok", address: PIN, expireAt: 1_700_000_000_000, pin: PIN });
  assert.deepEqual(w.webLoginStatus({ state: "wrong", address: PIN, error: "扫错账号了", svg: "<svg/>", url: "u", code: "c", pin: null }), { state: "wrong", address: PIN, error: "扫错账号了", pin: null });
  // 没登录过:{ state: "none", pin }
  assert.deepEqual(w.webLoginStatus({ state: "none", pin: null }), { state: "none", pin: null });
  // 以后登录状态里多了别的字段也不会漏给网页(白名单)
  assert.deepEqual(w.webLoginStatus({ state: "pending", qrCodeId: "q", ps: {} }), { state: "pending" });
  for (const bad of [null, undefined, "x", 1]) assert.deepEqual(w.webLoginStatus(bad), {});
});

// ── 发给网页的出错信息 ──

test("webScrub:网址(RPC / 数据库 / ws)和 key=… 去掉,其余原样;null / undefined 原样返回", () => {
  assert.equal(w.webScrub(null), null);
  assert.equal(w.webScrub(undefined), undefined);
  assert.equal(w.webScrub("补查:timeout"), "补查:timeout");
  assert.equal(w.webScrub("WebSocket:wss://bsc.nodereal.io/ws/v1/abcdef0123 断开"), "WebSocket:<节点> 断开");
  assert.equal(w.webScrub("补查:could not fetch https://rpc.example.com/?apikey=SECRET123 (429)"), "补查:could not fetch <节点> (429)");
  assert.equal(w.webScrub("mysql://root:hunter2@10.0.0.5:3306/agentbuy"), "<节点>");
  assert.equal(w.webScrub("redis://:pw@127.0.0.1:6379 拒绝连接"), "<节点> 拒绝连接");
  const out = w.webScrub("auth failed apikey=abc123&x=1 token: zzz password=p@ss");
  for (const bad of ["abc123", "zzz", "p@ss"]) assert.ok(!out.includes(bad), out);
  assert.ok(out.includes("apikey=***"), out);
});

// ── 下单记录 ──

test("recentWebOrders 没有记录时是空数组", () => {
  assert.deepEqual(w.recentWebOrders(), []);
});

test("logWebOrder 追加一行 JSON 并加 at;recentWebOrders 新的在前", () => {
  const before = Date.now();
  w.logWebOrder({ ca: "0x1", action: "buy", at: 1 }); // 调用方给的 at 不算数
  w.logWebOrder({ ca: "0x2" });
  w.logWebOrder({ ca: "0x3", n: 3 });
  const lines = readFileSync(join(dir, "web-orders.jsonl"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).ca, "0x1");
  assert.ok(JSON.parse(lines[0]).at >= before);
  assert.equal(JSON.parse(lines[0]).action, "buy");
  assert.equal(w.recentWebOrders(1)[0].ca, "0x3");
  assert.deepEqual(w.recentWebOrders(2).map((o) => o.ca), ["0x3", "0x2"]);
  assert.deepEqual(w.recentWebOrders().map((o) => o.ca), ["0x3", "0x2", "0x1"]);
  assert.deepEqual(w.recentWebOrders(99).map((o) => o.ca), ["0x3", "0x2", "0x1"]);
  assert.deepEqual(w.recentWebOrders(0), []);
  assert.deepEqual(w.recentWebOrders(-5), []);
});

test("recentWebOrders 跳过坏行(比如写到一半断电的半行)", () => {
  appendFileSync(join(dir, "web-orders.jsonl"), '{"ca":"0xhalf"\n');
  w.logWebOrder({ ca: "0x4" });
  assert.deepEqual(w.recentWebOrders().map((o) => o.ca), ["0x4", "0x3", "0x2", "0x1"]);
});

// ── 重启后还在 ──

test("限额和账本落盘,重新加载模块后还在", async () => {
  const t = NOON + 30 * DAY;
  w.setWebLimits({ webMaxBuyBnb: 1.5, webDailyBnb: 4, webMaxSlip: 12, webMaxSellSlip: 6 });
  w.recordWebBuy(0.7, t);
  const w2 = await import("../panel/weblink.mjs?reload=1"); // 新的模块实例 = 新进程:缓存是空的
  assert.deepEqual(w2.getWebLimits(), { webMaxBuyBnb: 1.5, webDailyBnb: 4, webMaxSlip: 12, webMaxSellSlip: 6 });
  assert.equal(w2.webSpentToday(t), 0.7);
  assert.equal(w2.webSpentToday(t + DAY), 0);
  assert.throws(() => w2.checkWebBuy(1.6, t), { message: "超过网页单笔上限 1.5 BNB" });
  w.setWebLimits(DEFAULTS);
});

test("web-limits.json 坏了 / 值越界:回到保守的默认值,账本归零", async () => {
  const file = join(dir, "web-limits.json");
  writeFileSync(file, "{坏的");
  const a = await import("../panel/weblink.mjs?reload=2");
  assert.deepEqual(a.getWebLimits(), DEFAULTS);
  assert.equal(a.webSpentToday(NOON), 0);
  writeFileSync(file, JSON.stringify({
    limits: { webMaxBuyBnb: 9999, webDailyBnb: "5", webMaxSlip: 30 },
    ledger: { day: new Date(NOON).toLocaleDateString("sv-SE"), spent: -3 },
  }));
  const b = await import("../panel/weblink.mjs?reload=3");
  assert.deepEqual(b.getWebLimits(), { webMaxBuyBnb: 0.5, webDailyBnb: 2, webMaxSlip: 30, webMaxSellSlip: 10 }); // 只有合法的那项保留
  assert.equal(b.webSpentToday(NOON), 0);
});

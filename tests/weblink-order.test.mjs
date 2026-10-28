// 网页下单的全部决定 webOrderPlan(panel/weblink.mjs 第二部分):滑点上限、单笔 / 每日上限、Gang 按比例买的 --max-bnb、Gang 第一代拒绝
//   以及 SCRIPT_DEFAULT_SLIP 和各脚本源码 / route() 用到的脚本是否一致(表和脚本对不上就失败,不会悄悄放过高滑点)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "weblink-order-"));
process.env.AGENTBUY_DATA_DIR = dir; // webOrderPlan 不读写磁盘;这里只是保证万一读了也不碰真实的 panel/
delete process.env.AGENTBUY_WEB_ORIGINS;
const w = await import("../panel/weblink.mjs");
after(() => rmSync(dir, { recursive: true, force: true }));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIMITS = { webMaxBuyBnb: 0.5, webDailyBnb: 2, webMaxSlip: 25, webMaxSellSlip: 10 };
const CA = "0x1111111111111111111111111111111111111111";
// 照 server.mjs 的 route() 拼出来的样子(script = 相对 agentbuy 根目录的路径;scriptOf 默认直接用它)
const R = {
  fourbuy: (a, budget = "0.1") => ({ a, script: "fourbuy.mjs", args: [CA, budget], fourAcct: a }),
  foursell: (a, pct = "50") => ({ a, script: "foursell.mjs", args: [CA, pct, "--slip", "10"], fourAcct: a }),
  fast: (a, bnb = "0.1") => ({ a, script: "fast.mjs", args: [CA, bnb, "--acct", a, "--wait"] }),
  sell: (a, pct = "50") => ({ a, script: "sell.mjs", args: [CA, pct, "--acct", a] }),
  dexbuy: (a, bnb = "0.1") => ({ a, script: "dexbuy.mjs", args: [CA, bnb, "--acct", a] }),
  dexsell: (a, pct = "50") => ({ a, script: "dexsell.mjs", args: [CA, pct, "--acct", a] }),
  flapbuy: (a, amt = "0.1") => ({ a, script: "flapportal.mjs", args: ["buy", CA, amt, "--acct", a] }),
  gangbuy: (a, tokens) => ({ a, script: "gang/gangbuy.mjs", args: [CA, ...(tokens ? ["--tokens", tokens] : []), "--acct", a] }),
  gangv1buy: (a) => ({ a, script: "gang/gangv1buy.mjs", args: [CA, "--acct", a] }),
  gangv3buy: (a, tokens) => ({ a, script: "gang/gangv3.mjs", args: ["buy", CA, ...(tokens ? ["--tokens", tokens] : []), "--acct", a] }),
  gangv3sell: (a, pct = "50") => ({ a, script: "gang/gangv3.mjs", args: ["sell", CA, pct, "--acct", a] }),
  gangv2sell: (a, pct = "50") => ({ a, script: "gang/gangv2sell.mjs", args: [CA, pct, "--acct", a] }),
};
const plan = (o) => w.webOrderPlan({ limits: LIMITS, spentToday: 0, accounts: o.plans.length, ...o });
const argOf = (p, name) => { const i = p.args.indexOf(name); return i < 0 ? undefined : p.args[i + 1]; };

// ── 滑点:买入 ──

test("Gang 买入没选滑点:脚本默认 1% 比上限低 → 不加 --slip(只往下压,不往上抬)", () => {
  const r = plan({ action: "buy", arg: "1pct", plans: [R.gangbuy("1")], bnbEach: 0.1 });
  assert.equal(argOf(r.plans[0], "--slip"), undefined);
  assert.deepEqual(r.slipLog, { 1: "脚本默认" });
  const v3 = plan({ action: "buy", arg: "half", plans: [R.gangv3buy("1", "5000000")], bnbEach: 0.05 });
  assert.equal(argOf(v3.plans[0], "--slip"), undefined, "gangv3 默认 5% < 25%");
});

test("four / Flap 内盘买入没选滑点:脚本默认 30% 比上限 25% 高 → 补 --slip 25", () => {
  for (const p of [R.fourbuy("1"), R.fast("1")]) {
    const r = plan({ action: "buy", arg: "0.1", plans: [p], bnbEach: 0.1 });
    assert.equal(argOf(r.plans[0], "--slip"), "25", p.script);
    assert.deepEqual(r.slipLog, { 1: 25 });
  }
  // 上限调低到 8:默认 10% 的外盘 / Flap Portal 也压到 8,默认 1% 的 Gang 不动
  const low = { ...LIMITS, webMaxSlip: 8 };
  assert.equal(argOf(plan({ action: "buy", arg: "0.1", plans: [R.dexbuy("1")], bnbEach: 0.1, limits: low }).plans[0], "--slip"), "8");
  assert.equal(argOf(plan({ action: "buy", arg: "0.1", plans: [R.flapbuy("1")], bnbEach: 0.1, limits: low }).plans[0], "--slip"), "8");
  assert.equal(argOf(plan({ action: "buy", arg: "1pct", plans: [R.gangbuy("1")], bnbEach: 0.1, limits: low }).plans[0], "--slip"), undefined);
  // 默认 10% 正好不超过 25%:不补
  assert.equal(argOf(plan({ action: "buy", arg: "0.1", plans: [R.dexbuy("1")], bnbEach: 0.1 }).plans[0], "--slip"), undefined);
});

test("网页选了滑点:不超过上限就照它的(替换 route 自带的 --slip);超过上限 / 不是正数直接拒绝", () => {
  const r = plan({ action: "buy", arg: "0.1", slip: "12", plans: [R.fourbuy("1")], bnbEach: 0.1 });
  assert.equal(argOf(r.plans[0], "--slip"), "12");
  assert.deepEqual(r.slipLog, { 1: 12 });
  assert.equal(argOf(plan({ action: "buy", arg: "0.1", slip: 25, plans: [R.dexbuy("1")], bnbEach: 0.1 }).plans[0], "--slip"), "25", "正好等于上限可以");
  assert.equal(argOf(plan({ action: "buy", arg: "1pct", slip: 3, plans: [R.gangbuy("1")], bnbEach: 0.1 }).plans[0], "--slip"), "3");
  for (const s of [26, "25.5", 50]) {
    assert.throws(() => plan({ action: "buy", arg: "0.1", slip: s, plans: [R.fourbuy("1")], bnbEach: 0.1 }), { message: "网页下单滑点最多 25%" }, String(s));
  }
  for (const s of ["abc", 0, "0", -5, true, {}]) {
    assert.throws(() => plan({ action: "buy", arg: "0.1", slip: s, plans: [R.fourbuy("1")], bnbEach: 0.1 }), { message: "滑点数值不对" }, String(s));
  }
  for (const s of [undefined, null, ""]) assert.equal(argOf(plan({ action: "buy", arg: "0.1", slip: s, plans: [R.fourbuy("1")], bnbEach: 0.1 }).plans[0], "--slip"), "25");
});

// ── 滑点:卖出(上限 webMaxSellSlip,默认 10) ──

test("卖出没选滑点:four 卖出 route 自带 --slip 10 → 留着;Flap 内盘卖出脚本默认 30 → 压到 10;Gang 卖出 5 → 不动", () => {
  const four = plan({ action: "sell", arg: "50", plans: [R.foursell("1")] });
  assert.equal(argOf(four.plans[0], "--slip"), "10");
  const fast = plan({ action: "sell", arg: "100", plans: [R.sell("1")] });
  assert.equal(argOf(fast.plans[0], "--slip"), "10");
  assert.deepEqual(fast.slipLog, { 1: 10 });
  for (const p of [R.gangv3sell("1"), R.gangv2sell("1"), R.dexsell("1")]) {
    assert.equal(argOf(plan({ action: "sell", arg: "50", plans: [p] }).plans[0], "--slip"), undefined, p.script);
  }
  assert.equal(four.charge, null, "卖出不记账");
  assert.equal(four.maxBnb, null);
});

test("卖出:已带的 --slip 超过上限压到上限;上限调低时默认 10 / 5 的也压;只降不升", () => {
  const custom = { ...R.dexsell("1"), args: [CA, "50", "--acct", "1", "--slip", "20"] };
  assert.equal(argOf(plan({ action: "sell", arg: "50", plans: [custom] }).plans[0], "--slip"), "10");
  const low = { ...LIMITS, webMaxSellSlip: 4 };
  assert.equal(argOf(plan({ action: "sell", arg: "50", plans: [R.foursell("1")], limits: low }).plans[0], "--slip"), "4");
  assert.equal(argOf(plan({ action: "sell", arg: "50", plans: [R.dexsell("1")], limits: low }).plans[0], "--slip"), "4");
  assert.equal(argOf(plan({ action: "sell", arg: "50", plans: [R.gangv3sell("1")], limits: low }).plans[0], "--slip"), "4");
  // 上限调高到 40:four 卖出 route 自带的 10 不抬,Flap 内盘卖出默认 30 也不加
  const high = { ...LIMITS, webMaxSellSlip: 40 };
  assert.equal(argOf(plan({ action: "sell", arg: "50", plans: [R.foursell("1")], limits: high }).plans[0], "--slip"), "10");
  assert.equal(argOf(plan({ action: "sell", arg: "50", plans: [R.sell("1")], limits: high }).plans[0], "--slip"), undefined);
  // 已带的 --slip 不是数字:按超过上限处理(压到上限,偏保守)
  const junk = { ...R.dexsell("1"), args: [CA, "50", "--slip", "abc"] };
  assert.equal(argOf(plan({ action: "sell", arg: "50", plans: [junk] }).plans[0], "--slip"), "10");
});

test("卖出网页选了滑点:超过卖出上限拒绝(买入上限 25 不算数),不超过就照它的", () => {
  for (const s of [11, "25", 50]) {
    assert.throws(() => plan({ action: "sell", arg: "50", slip: s, plans: [R.sell("1")] }), { message: "网页卖出滑点最多 10%" }, String(s));
  }
  const r = plan({ action: "sell", arg: "50", slip: "6", plans: [R.foursell("1")] });
  assert.equal(argOf(r.plans[0], "--slip"), "6");
  assert.equal(r.plans[0].args.filter((x) => x === "--slip").length, 1, "替换,不重复加");
  assert.throws(() => plan({ action: "sell", arg: "50", slip: 31, plans: [R.sell("1")], limits: { ...LIMITS, webMaxSellSlip: 30 } }), { message: "网页卖出滑点最多 30%" });
});

// ── 单笔 / 每日上限 ──

test("单笔上限按每个号比,每日上限按 金额 × 号数;charge = 合计", () => {
  const two = [R.dexbuy("1", "0.3"), R.dexbuy("2", "0.3")];
  const r = plan({ action: "buy", arg: "0.3", plans: two, bnbEach: 0.3 });
  assert.equal(r.charge, 0.6);
  assert.deepEqual(r.slipLog, { 1: "脚本默认", 2: "脚本默认" });
  assert.throws(() => plan({ action: "buy", arg: "0.6", plans: [R.dexbuy("1", "0.6")], bnbEach: 0.6 }), { message: "超过网页单笔上限 0.5 BNB" });
  assert.throws(() => plan({ action: "buy", arg: "0.3", plans: two, bnbEach: 0.3, spentToday: 1.5 }), { message: "超过网页每日上限 2 BNB(今天已用 1.5)" });
  assert.equal(plan({ action: "buy", arg: "0.3", plans: [R.dexbuy("1", "0.3")], bnbEach: 0.3, spentToday: 1.5 }).charge, 0.3, "一个号 1.5 + 0.3 ≤ 2");
  assert.equal(plan({ action: "buy", arg: "0.1", plans: [R.dexbuy("1")], bnbEach: 0.1, spentToday: 1.9 }).charge, 0.1, "正好到上限可以");
  for (const bad of [null, undefined, 0, -1, NaN, Infinity, "0.1"]) {
    assert.throws(() => plan({ action: "buy", arg: "1pct", plans: [R.gangbuy("1")], bnbEach: bad }), { message: "算不出这笔折合多少 BNB,网页下单不能放行" }, String(bad));
  }
  // 卖出不看金额
  assert.doesNotThrow(() => plan({ action: "sell", arg: "50", plans: [R.dexsell("1")], bnbEach: null, spentToday: 999 }));
});

test("两个号同时下:每个号的 plan 都改,slipLog 两个号都有", () => {
  const r = plan({ action: "buy", arg: "0.2", plans: [R.fourbuy("1", "0.2"), R.fourbuy("2", "0.2")], bnbEach: 0.2 });
  assert.deepEqual(r.plans.map((p) => argOf(p, "--slip")), ["25", "25"]);
  assert.deepEqual(r.slipLog, { 1: 25, 2: 25 });
  assert.equal(r.charge, 0.4);
  const s = plan({ action: "sell", arg: "100", plans: [R.sell("1"), R.sell("2")] });
  assert.deepEqual(s.plans.map((p) => argOf(p, "--slip")), ["10", "10"]);
  const g = plan({ action: "buy", arg: "1pct", plans: [R.gangv3buy("1"), R.gangv3buy("2")], bnbEach: 0.2, spentToday: 0.8 });
  assert.deepEqual(g.plans.map((p) => argOf(p, "--max-bnb")), ["0.5", "0.5"], "min(0.5, (2 - 0.8) ÷ 2 = 0.6)");
});

// ── Gang 按比例买:--max-bnb,第一代拒绝 ──

test("Gang 按比例买 → --max-bnb = min(单笔上限, 今天剩下的 ÷ 号数),按记这一单之前的已用算", () => {
  let r = plan({ action: "buy", arg: "1pct", plans: [R.gangbuy("1")], bnbEach: 0.1 });
  assert.equal(argOf(r.plans[0], "--max-bnb"), "0.5");
  assert.equal(r.maxBnb, 0.5);
  r = plan({ action: "buy", arg: "half", plans: [R.gangbuy("1", "5000000"), R.gangbuy("2", "5000000")], bnbEach: 0.1, spentToday: 1.4 });
  assert.deepEqual(r.plans.map((p) => argOf(p, "--max-bnb")), ["0.3", "0.3"], "(2 - 1.4) ÷ 2 = 0.3 < 0.5");
  assert.equal(r.charge, 0.2);
  r = plan({ action: "buy", arg: "p0.3", plans: [R.gangv3buy("1", "3000000")], bnbEach: 0.03, spentToday: 1.75 });
  assert.equal(argOf(r.plans[0], "--max-bnb"), "0.25");
  // 小数:往下取整到 1e-8(只会更严)
  r = plan({ action: "buy", arg: "1pct", plans: [R.gangbuy("1"), R.gangbuy("2"), R.gangbuy("3")], bnbEach: 0.1, limits: { ...LIMITS, webDailyBnb: 1 } });
  assert.equal(argOf(r.plans[0], "--max-bnb"), "0.33333333");
  // 已经带了更小的 --max-bnb:留着
  const tight = { ...R.gangbuy("1"), args: [CA, "--acct", "1", "--max-bnb", "0.05"] };
  assert.equal(argOf(plan({ action: "buy", arg: "1pct", plans: [tight], bnbEach: 0.04 }).plans[0], "--max-bnb"), "0.05");
});

test("--max-bnb 只加给 Gang 按比例买;按 BNB 数量买、four / Flap 按比例买(脚本拿到的就是 BNB 预算)、卖出都不加", () => {
  for (const [arg, p] of [["0.1", R.dexbuy("1")], ["0.1", R.fast("1")], ["1pct", R.fourbuy("1", "0.0105")], ["half", R.flapbuy("1", "0.005")]]) {
    const r = plan({ action: "buy", arg, plans: [p], bnbEach: 0.01 });
    assert.equal(argOf(r.plans[0], "--max-bnb"), undefined, `${p.script} ${arg}`);
    assert.equal(r.maxBnb, null);
  }
  assert.equal(argOf(plan({ action: "sell", arg: "50", plans: [R.gangv3sell("1")] }).plans[0], "--max-bnb"), undefined);
});

test("Gang 第一代按比例买:网页上拒绝(脚本不认 --max-bnb,封不了顶)", () => {
  for (const arg of ["1pct", "half", "p0.3"]) {
    assert.throws(() => plan({ action: "buy", arg, plans: [R.gangv1buy("1")], bnbEach: 0.1 }), { message: "Gang 第一代网页上不支持,请在本机面板下单" }, arg);
    assert.throws(() => plan({ action: "buy", arg, plans: [R.gangv1buy("1"), R.gangv1buy("2")], bnbEach: 0.1 }), { message: "Gang 第一代网页上不支持,请在本机面板下单" }, arg);
  }
});

// ── 其他 ──

test("不改入参;scriptOf 把 plan 映射成相对路径(server 里传的是绝对路径)", () => {
  const p = R.fourbuy("1");
  const before = JSON.stringify(p);
  const r = plan({ action: "buy", arg: "0.1", plans: [p], bnbEach: 0.1 });
  assert.equal(JSON.stringify(p), before);
  assert.notEqual(r.plans[0], p);
  assert.equal(r.plans[0].fourAcct, "1", "别的字段原样带过去");
  // 绝对路径 + scriptOf(和 server.mjs 的 relScript 一样的做法)
  const ROOT_SLASH = "G:\\x\\agentbuy\\";
  const abs = { ...R.gangbuy("1"), script: ROOT_SLASH + "gang/gangbuy.mjs" };
  const r2 = w.webOrderPlan({ action: "buy", arg: "1pct", accounts: 1, plans: [abs], bnbEach: 0.1, limits: LIMITS, spentToday: 0, scriptOf: (x) => x.script.slice(ROOT_SLASH.length) });
  assert.equal(argOf(r2.plans[0], "--max-bnb"), "0.5");
  // 不认识的脚本:不补 --slip(照用它自己的默认)
  assert.equal(argOf(plan({ action: "buy", arg: "0.1", plans: [{ a: "1", script: "x/unknown.mjs", args: [] }], bnbEach: 0.1 }).plans[0], "--slip"), undefined);
});

test("参数不对就抛:action、号数和 plans 对不上;limits 缺项按默认", () => {
  assert.throws(() => plan({ action: "swap", arg: "0.1", plans: [R.dexbuy("1")], bnbEach: 0.1 }), { message: "action 不对" });
  assert.throws(() => w.webOrderPlan({ action: "buy", arg: "0.1", accounts: 2, plans: [R.dexbuy("1")], bnbEach: 0.1, limits: LIMITS }), { message: "下单的号数不对" });
  assert.throws(() => w.webOrderPlan({ action: "buy", arg: "0.1", accounts: 0, plans: [], bnbEach: 0.1, limits: LIMITS }), { message: "下单的号数不对" });
  assert.throws(() => w.webOrderPlan(), { message: "action 不对" });
  const r = w.webOrderPlan({ action: "sell", arg: "50", accounts: 1, plans: [R.sell("1")], limits: { webMaxBuyBnb: 1 } });
  assert.equal(argOf(r.plans[0], "--slip"), "10", "没给 webMaxSellSlip → 默认 10");
});

// ── 表和脚本 / route() 对得上 ──

test("SCRIPT_DEFAULT_SLIP 和每个脚本源码里的 opt(\"--slip\") ?? \"N\" 一致", () => {
  assert.ok(w.SCRIPT_DEFAULT_SLIP.size >= 12);
  for (const [rel, n] of w.SCRIPT_DEFAULT_SLIP) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    const hits = [...src.matchAll(/opt\("--slip"\)\s*\?\?\s*"(\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]));
    assert.equal(hits.length, 1, `${rel}:应当正好一处 opt("--slip") ?? "N",实际 ${hits.length}`);
    assert.equal(hits[0], n, `${rel}:脚本默认滑点是 ${hits[0]}%,表里写的是 ${n}% —— 改 panel/weblink.mjs 的 SCRIPT_DEFAULT_SLIP`);
  }
});

test("route() 用到的每个脚本都在 SCRIPT_DEFAULT_SLIP 里(漏了就会放过脚本自己的高默认滑点),表里也没有多余的", () => {
  const server = readFileSync(join(ROOT, "panel", "server.mjs"), "utf8");
  const from = server.indexOf("function route("), to = server.indexOf("function execOrder(");
  assert.ok(from > 0 && to > from, "server.mjs 里找不到 route() / execOrder()");
  const used = new Set([...server.slice(from, to).matchAll(/"([\w/.-]+\.mjs)"/g)].map((m) => m[1])); // route() 里出现的所有脚本名
  assert.ok(used.size >= 12, `route() 里应当能找到全部下单脚本,实际 ${[...used]}`);
  for (const s of used) assert.ok(w.SCRIPT_DEFAULT_SLIP.has(s), `route() 用了 ${s},SCRIPT_DEFAULT_SLIP 里没有`);
  for (const s of w.SCRIPT_DEFAULT_SLIP.keys()) assert.ok(used.has(s), `SCRIPT_DEFAULT_SLIP 里的 ${s} 在 route() 里没用到`);
});

test("加 --max-bnb 的脚本真的认 --max-bnb;Gang 第一代的买入脚本不认(所以网页按比例买要拒绝)", () => {
  for (const [p, arg] of [[R.gangbuy("1"), "1pct"], [R.gangv3buy("1"), "half"]]) {
    const r = plan({ action: "buy", arg, plans: [p], bnbEach: 0.1 });
    assert.ok(argOf(r.plans[0], "--max-bnb"), p.script);
    const src = readFileSync(join(ROOT, p.script), "utf8");
    assert.match(src, /opt\("--max-bnb"\)/, `${p.script} 不认 --max-bnb`);
    assert.match(src, /bnbCost > maxBnb|cost > maxBnb|quoteIn > ethers\.parseEther\(String\(maxBnb\)\)/, `${p.script} 没有按 --max-bnb 拦`);
  }
  assert.doesNotMatch(readFileSync(join(ROOT, "gang/gangv1buy.mjs"), "utf8"), /--max-bnb/);
});

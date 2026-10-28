// 英文界面:批准框(weblink.mjs 的 describeApproval)、本机弹窗(localpop.js)、本机助手页面(helper.html)的中文都要有英文
// panel/i18n.js 在 vm 里按英文跑一遍,拿它真正的 tr();词典按第 5 行那一行 JSON 读
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "i18n-local-"));
process.env.AGENTBUY_DATA_DIR = dir;   // weblink.mjs 只用来生成批准文案,不写盘;数据目录也指到临时目录
const w = await import("../panel/weblink.mjs");
after(() => rmSync(dir, { recursive: true, force: true }));

const panel = (f) => readFileSync(new URL(`../panel/${f}`, import.meta.url), "utf8");
const I18N = panel("i18n.js");
const DICT = JSON.parse(/^ {2}const DICT = (\{.*\});\r?$/m.exec(I18N)[1]);
const CJK = /[㐀-鿿＀-￯　-〿]/;

// 英文模式的 tr():页面相关的东西都给空壳,只要 window.tr
function loadTr() {
  const noop = () => {};
  const window = { alert: noop, confirm: noop, prompt: noop };
  const ctx = {
    window, console, NodeFilter: {}, MutationObserver: class { observe() {} },
    document: { documentElement: {}, addEventListener: noop, querySelector: () => null, head: {}, title: "" },
    navigator: { language: "en-US" }, localStorage: { getItem: () => "en", setItem: noop },
  };
  vm.createContext(ctx);
  vm.runInContext(I18N, ctx);
  return window.tr;
}
const tr = loadTr();

const OWN1 = "0x1111111111111111111111111111111111111111", OWN2 = "0x2222222222222222222222222222222222222222";
const AT = "0x3333333333333333333333333333333333333333", X = "0x9999999999999999999999999999999999999999";
const TOKEN = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const ctx = { own: { 1: OWN1, 2: OWN2 }, atTarget: AT, limits: { webMaxBuyBnb: 0.5, webDailyBnb: 2, webMaxSlip: 25, webMaxSellSlip: 10 },
  settings: { maxBuyBnb: 0, autoClaim: false }, copyDefaults: { maxPerTrade: 0.05, dailyCap: 0.5 } };
// 每种批准框、每种分支(自己的地址 / 自动转出地址 / 陌生地址、App 确认、只模拟、清空 …)都走一遍;留言 / 名称这种网页给的值用英文
const CASES = [
  ["send", { acct: "1", token: "BNB", amount: "0.5", to: X, appConfirm: false, dry: false }, ctx],
  ["send", { acct: "2", token: TOKEN, amount: "max", to: OWN1, appConfirm: true, dry: true }, ctx],
  ["send", { acct: "1", token: "BNB", amount: "1", to: OWN2 }, ctx],
  ["send", { acct: "2", token: "BNB", amount: "1", to: AT }, ctx],
  ["tip", { acct: "1", amount: "0.05", memo: "thanks", appConfirm: true, dry: true }, ctx],
  ["tip", { acct: "2", amount: "0.05" }, ctx],
  ["settings", { maxBuyBnb: 0.3, autoClaim: true }, ctx],
  ["settings", { maxBuyBnb: 0, autoClaim: false }, { ...ctx, settings: { maxBuyBnb: 0.2, autoClaim: true } }],
  ["settings", {}, ctx],
  ["at-target", { to: X }, ctx],
  ["at-target", { to: OWN2 }, ctx],
  ["at-target", { to: "" }, ctx],
  ["at-appconfirm", { on: true }, ctx],
  ["at-on", { ca: TOKEN }, ctx],
  ["at-on", { ca: TOKEN }, { ...ctx, atTarget: null }],
  ["unpin", { acct: "1" }, ctx],
  ["unpin", { acct: "2" }, ctx],
  ["limits", { webMaxBuyBnb: 1, webDailyBnb: 5, webMaxSlip: 30, webMaxSellSlip: 15 }, ctx],
  ["limits", {}, ctx],
  ["copy-real", { target: X, name: "whale", params: { maxPerTrade: 0.1, dailyCap: 1 } }, ctx],
  ["copy-real", { target: X, params: {} }, ctx],
  ["copy-resume", {}, ctx],
];

test("英文:每种批准框的标题和每一行都翻干净了(不剩中文)", () => {
  for (const [kind, p, c] of CASES) {
    const { title, lines } = w.describeApproval(kind, p, c);
    for (const s of [title, ...lines]) {
      const en = tr(s);
      assert.doesNotMatch(en, CJK, `${kind}:「${s}」→「${en}」`);
    }
  }
});

test("英文:转账框和改设置框读起来是对的", () => {
  const send = w.describeApproval("send", { acct: "1", token: "BNB", amount: "0.5", to: X, appConfirm: true, dry: true }, ctx);
  assert.deepEqual([send.title, ...send.lines].map(tr), [
    "Transfer", "Send from account 1", "Amount:0.5 BNB", `Recipient:${X}`,
    "⚠ This address is not one of your accounts, nor your auto-transfer address",
    "If flagged as risky, submit it for confirmation in the Binance App", "Simulation only, nothing is actually sent",
  ]);
  const own = w.describeApproval("send", { acct: "2", token: "BNB", amount: "max", to: OWN1 }, ctx);
  assert.equal(tr(own.lines[1]), "Amount:All BNB");
  assert.equal(tr(own.lines[3]), "This is the address of your account 1");
  const st = w.describeApproval("settings", { maxBuyBnb: 0.3, autoClaim: true }, ctx);
  assert.deepEqual([st.title, ...st.lines].map(tr), [
    "Change settings", "Max buy per order (BNB):No limit → 0.3", "Flap curve auto-claim after launch:Off → On",
  ]);
});

test("英文:网站上会弹出的批准相关报错在词典里都有整句", () => {
  for (const s of [w.NOT_APPROVED, w.UNPAIRED_MSG, w.COPY_CHANGED_MSG, w.APPROVAL_WAIT_TEXT]) {
    assert.notEqual(DICT[s], undefined, s);
    assert.doesNotMatch(tr(s), CJK, s);
  }
});

// 本机弹窗 / 助手页面里写死的中文:脚本里一律是 "…" 普通字符串(变的部分放在单独的节点里),页面上是标签之间的文字
function zhLiterals(src) {
  const out = new Set();
  for (const m of src.matchAll(/"([^"\\\r\n]*)"/g)) if (CJK.test(m[1])) out.add(m[1].trim());
  return out;
}
function zhMarkup(html) {
  const out = new Set();
  const bare = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const m of bare.matchAll(/>([^<>]+)</g)) if (CJK.test(m[1])) out.add(m[1].trim());
  for (const m of bare.matchAll(/\b(?:title|placeholder|aria-label)="([^"]*)"/g)) if (CJK.test(m[1])) out.add(m[1].trim());
  return out;
}
const scriptsOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

test("英文:localpop.js 和 helper.html 里每段写死的中文在词典里都有整句", () => {
  const missing = [];
  const helper = panel("helper.html");
  // 脚本里的模板字符串不许带中文(会拼出词典里没有的整句)
  for (const [f, src] of [["localpop.js", panel("localpop.js")], ["helper.html", scriptsOf(helper)]]) {
    const noComments = src.replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
    for (const m of noComments.matchAll(/`([^`]*)`/g)) assert.doesNotMatch(m[1], CJK, `${f} 的模板字符串里有中文:${m[1]}`);
    for (const s of zhLiterals(noComments)) if (DICT[s] === undefined) missing.push(`${f}: ${s}`);
  }
  for (const s of zhMarkup(helper)) if (DICT[s] === undefined) missing.push(`helper.html: ${s}`);
  assert.deepEqual(missing, []);
});

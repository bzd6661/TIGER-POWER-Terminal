// 发射后自动转出:面板里逐个币打开开关;后台每 15 秒看一次这些币有没有发射(毕业 / 开盘),
// 发射了就对每个持有它的已登录账号跑 transfer.mjs,把全部持仓转到目标地址,结果推 TG。
//   目标地址只从本机 panel/autotransfer.json 的 "to" 读(网页改不了);状态存 panel/autotransfer-state.json。
//   已经转成功的会记下 tx,不会重复转;失败最多重试 5 次(每次隔 1 分钟),之后停下并通知。
//   autotransfer.json 的 "appConfirm": true(面板设置里的开关)= 币安只报「中风险」的转账也提交,推 TG 让你去 Binance App 确认;
//   不开就和以前一样直接拦。高风险照样拦(transfer.mjs --app-confirm 的规则)。
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { detect } from "./detect.mjs";
import { sessions } from "./session.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const CONFIG = process.env.AGENTBUY_AT_CONFIG || here("./autotransfer.json");   // 测试时可以指到别的文件
// 测试用:AGENTBUY_AT_DRY=1 时转账脚本只 preview 不提交,状态写到 AGENTBUY_AT_STATE 指定的文件
const DRY = process.env.AGENTBUY_AT_DRY === "1";
const STATE = process.env.AGENTBUY_AT_STATE || here("./autotransfer-state.json");
const SCRIPT = here("../transfer.mjs");
const MAX_TRIES = 5;

const readCfg = () => { try { return JSON.parse(readFileSync(CONFIG, "utf8")) ?? {}; } catch { return {}; } };
const writeCfg = (c) => writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n");
export function target() {
  const t = readCfg().to; return ethers.isAddress(t) ? ethers.getAddress(t) : null;
}
export const appConfirm = () => readCfg().appConfirm === true;
export async function setAppConfirm(on) {
  writeCfg({ ...readCfg(), appConfirm: !!on });
  await tg(on ? "🔔 发射后自动转出:已开启「中风险去 App 确认」—— 被币安标成中风险的币也会提交,需要你在 Binance App 里确认" : "发射后自动转出:已关闭「中风险去 App 确认」,有风险提示的转账直接拦下");
  return appConfirm();
}
let state = { tokens: {} };
try { state = JSON.parse(readFileSync(STATE, "utf8")); } catch {}
const save = () => { try { writeFileSync(STATE, JSON.stringify(state, null, 1)); } catch {} };

export function list() { return { to: target(), appConfirm: appConfirm(), tokens: state.tokens }; }
// 在面板里设 / 改 / 清空目标地址。为了安全:改了地址就把所有已打开的开关关掉(要按新地址重新打开),并推 TG。
export async function setTarget(to, ownAddresses = []) {
  const v = String(to ?? "").trim();
  if (v && !ethers.isAddress(v)) throw new Error("地址格式不对");
  if (v && ownAddresses.map((a) => a.toLowerCase()).includes(v.toLowerCase()) && ownAddresses.length < 2) throw new Error("目标地址就是这个钱包自己");
  const old = target();
  if ((old ?? "").toLowerCase() === v.toLowerCase()) return { to: old, turnedOff: 0 };
  writeCfg({ ...readCfg(), to: v ? ethers.getAddress(v) : "" });
  let turnedOff = 0;
  // 所有开着的币都关掉(包括已经有一个号转完、另一个号还没转的):剩下的号不能不经确认就转到新地址
  for (const t of Object.values(state.tokens)) if (t.on) { t.on = false; turnedOff++; }
  save();
  await tg(v ? `🔑 发射后自动转出的目标地址改成了\n<code>${v}</code>\n(原来:${old ?? "没设"})。已关闭 ${turnedOff} 个开关,需要按新地址重新打开。不是你改的请马上检查面板。`
    : `🔑 发射后自动转出的目标地址已清空(原来 ${old ?? "没设"}),功能已关闭。`);
  return { to: target(), turnedOff };
}
export function setWatch(ca, on, meta = {}) {
  const k = ca.toLowerCase();
  if (on) state.tokens[k] = { ...(state.tokens[k] ?? {}), on: true, symbol: meta.symbol, platform: meta.platform, addedAt: state.tokens[k]?.addedAt ?? Date.now(), done: state.tokens[k]?.done ?? {}, tries: {}, lastError: null };
  else if (state.tokens[k]) state.tokens[k].on = false;
  save();
  return state.tokens[k] ?? null;
}

// ---------- TG:只从环境变量 / agentbuy/.env 读 TG_BOT_TOKEN、TG_CHAT_ID;没配就只写日志 ----------
function tgCreds() {
  return { token: process.env.TG_BOT_TOKEN, chat: process.env.TG_CHAT_ID };
}
export async function tg(text) {
  console.log("[自动转出] " + text.replace(/<[^>]+>/g, ""));
  if (DRY) return;   // 演练不推 TG
  const { token, chat } = tgCreds();
  if (!token || !chat) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }), signal: AbortSignal.timeout(10000),
  }).catch(() => {});
}

function runTransfer(ca, acct, to, onPending) {
  return new Promise((resolve) => {
    const ps = spawn(process.execPath, [SCRIPT, ca, "--to", to, "--acct", acct, ...(appConfirm() ? ["--app-confirm"] : []), ...(DRY ? ["--dry"] : [])], { cwd: here("../"), windowsHide: true });
    let out = "", told = false;
    ps.stdout.on("data", (d) => { out += d; if (!told && /⏳/.test(out)) { told = true; onPending?.(); } }); ps.stderr.on("data", (d) => (out += d));
    ps.on("close", (code) => resolve({ code, out }));
  });
}

let busyFlag = false;
async function tick(busy) {
  const to = target();
  if (!to || busyFlag) return;
  const watching = Object.entries(state.tokens).filter(([, t]) => t.on);
  if (!watching.length) return;
  busyFlag = true;
  try {
    const ss = await sessions();
    const accts = Object.values(ss).filter((s) => s.connected).map((s) => s.acct);
    for (const [ca, t] of watching) {
      const d = await detect(ca).catch(() => null);
      t.lastCheck = Date.now();
      if (!d) continue;
      // 平台接口偶尔超时(比如 gang.fun),识别会退回「普通外盘代币」,看起来像已发射 —— 已知是内盘平台的币,这种结果不算数
      if (d.platform === "dex" && t.platform && t.platform !== "dex") { t.outerSeen = 0; continue; }
      t.symbol = d.symbol !== "?" ? d.symbol : t.symbol; t.platform = d.platform; t.stage = d.stage;
      if (d.stage !== "outer") { t.outerSeen = 0; continue; }   // 还在内盘
      // 连续两次(间隔 15 秒)都看到已发射才转,防一次识别出错就去转
      t.outerSeen = (t.outerSeen ?? 0) + 1;
      if (t.outerSeen < 2) continue;
      for (const a of accts) {
        if (t.done?.[a]) continue;
        const h = d.holdings?.[a];
        if (!h || !((h.tokens || 0) > 0 || (h.shares || 0) > 0)) continue;   // 这个号没持有
        if ((t.tries?.[a] ?? 0) >= MAX_TRIES) continue;
        if (t.nextTry?.[a] && Date.now() < t.nextTry[a]) continue;
        if (busy.has(a)) continue;   // 这个号正在下单,下一轮再转
        busy.add(a);
        const sym = esc(t.symbol ?? ca.slice(0, 8));
        const r = await runTransfer(ca, a, to, () => tg(`⏳ <b>${sym}</b> 已发射,账号${a} 的自动转出被币安标成中风险,已提交 —— <b>请在 5 分钟内打开 Binance App 确认</b>\n→ <code>${to}</code>\n<code>${ca}</code>`)).finally(() => busy.delete(a));
        if (r.code === 0 && DRY) {
          t.done = { ...(t.done ?? {}), [a]: { tx: null, amount: null, at: Date.now(), note: "演练:preview 通过,没提交" } };
          console.log("[自动转出·演练]", r.out.trim().split(/\r?\n/).slice(-2).join(" | "));
        } else if (r.code === 0) {
          const m = r.out.match(/__TX__ (0x[0-9a-f]{64}) (\S+)/i);
          t.done = { ...(t.done ?? {}), [a]: { tx: m?.[1] ?? null, amount: m?.[2] ?? null, at: Date.now() } };
          t.lastError = null;
          await tg(`✅ <b>${sym}</b> 已发射,账号${a} 全部转出 ${m?.[2] ?? ""} 个\n→ <code>${to}</code>\n${m ? `<a href="https://bscscan.com/tx/${m[1]}">${m[1].slice(0, 12)}…</a>` : ""}\n<code>${ca}</code>`);
        } else if (r.code === 3 || r.code === 4) {
          // 3 = ID Agent 还没真正发币(phase 2 等开盘);4 = 钱包里已经没有了 —— 都不算失败
          if (r.code === 4) t.done = { ...(t.done ?? {}), [a]: { tx: null, amount: "0", at: Date.now(), note: "钱包里已经没有" } };
        } else if (!appConfirm() && /--app-confirm|App 批准|中风险/.test(r.out)) {
          // 被币安标风险 / 要去 App 批准,而「需要时去 App 确认」没开:重试也一样,直接停下,告诉你去哪打开
          t.tries = { ...(t.tries ?? {}), [a]: MAX_TRIES };
          t.lastError = `账号${a}:币安要求这笔去 App 确认,但设置里「被标中风险时去 Binance App 确认」没开`;
          await tg(`🛑 <b>${sym}</b> 已发射,账号${a} 自动转出被拦:币安把这笔标成${/中风险/.test(r.out) ? "中风险" : "需要 App 批准"}。\n去面板 账户总览 → 设置,打开「被标中风险时去 Binance App 确认」,再到这个币的「我的仓位」里把自动转出关掉重开一次;或者在代币页用「转出到地址…」手动转。\n<code>${ca}</code>`);
        } else {
          t.tries = { ...(t.tries ?? {}), [a]: (t.tries?.[a] ?? 0) + 1 };
          t.nextTry = { ...(t.nextTry ?? {}), [a]: Date.now() + 60_000 };
          const err = (r.out.split(/\r?\n/).reverse().find((l) => l.startsWith("✗")) ?? r.out.slice(-200)).trim();
          t.lastError = `账号${a}:${err}`;
          const n = t.tries[a];
          await tg(`${n >= MAX_TRIES ? "🛑" : "⚠️"} <b>${sym}</b> 已发射,账号${a} 自动转出失败(第 ${n}/${MAX_TRIES} 次${n >= MAX_TRIES ? ",不再重试,请手动处理" : ",1 分钟后重试"})\n${esc(err).slice(0, 300)}\n<code>${ca}</code>`);
        }
        save();
      }
    }
    save();
  } finally { busyFlag = false; }
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export function startAutoTransfer(busy) {
  setInterval(() => tick(busy).catch((e) => console.error("[自动转出] 出错", e.message)), 15_000);
}

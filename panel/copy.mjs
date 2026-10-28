// 跟单:追踪的地址在内盘(four / Gang / Flap)买入时,按设定自动跟买;可选跟卖(按对方卖出的比例卖我的)。
//   触发:track.mjs 推出来的实时追踪动态(type "track",带 建仓 / 加仓 / 减仓 / 清仓 和卖出比例),历史回补不触发。
//   安全:新任务一律「暂停 + 模拟」;要本人在页面关掉模拟并启动才真实下单。每笔 / 每币 / 每天都有上限,单笔硬上限 0.5 BNB;
//         已提交(不管最后成没成)都按花了钱算,宁可少跟一次也不超上限;右上角「全部暂停」一键停掉所有任务。
//   数据只存在本机:panel/copy-tasks.json(任务)、panel/copy-log.jsonl(每次决定的记录,保留最近 5000 条)。
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bus } from "./live.mjs";
import { bnbUsd } from "./prices.mjs";
import { HARD_MAX_TRADE, COPY_DEFAULTS, newCopyTask, applyCopyEdit } from "./copyparams.mjs";
// 默认参数和规整参数在 copyparams.mjs(纯函数,weblink.mjs 和测试也用);server.mjs 照旧从这里拿
export { COPY_DEFAULTS, cleanParams } from "./copyparams.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const FILE = here("./copy-tasks.json"), LOG = here("./copy-log.jsonl");
const lc = (a) => String(a ?? "").toLowerCase();
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };

let state = readJson(FILE, { tasks: [], paused: false });
if (!Array.isArray(state.tasks)) state.tasks = [];
const save = () => { try { writeFileSync(FILE, JSON.stringify(state, null, 1)); } catch {} bus.emit("event", { type: "copy-tasks" }); };
let recent = [];
try { recent = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).slice(-300).map((l) => JSON.parse(l)).reverse(); } catch {}
(function compact() {
  try { const lines = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean); if (lines.length > 5000) writeFileSync(LOG, lines.slice(-5000).join("\n") + "\n"); } catch {}
})();
function record(task, kind, reason, ev = {}, extra = {}) {
  const e = { ts: Math.floor(Date.now() / 1000), task: task.id, taskName: task.name, target: task.target, kind, reason, token: ev.ca ?? null, symbol: ev.symbol ?? null, action: ev.action ?? null, ...extra };
  recent.unshift(e); if (recent.length > 300) recent.length = 300;
  try { appendFileSync(LOG, JSON.stringify(e) + "\n"); } catch {}
  bus.emit("event", { type: "copy-log", ...e });
  return e;
}
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);   // 按北京时间算「每天」
const PF = { four: "four", gangv1: "gang", gangv2: "gang", gangv3: "gang", idagent: "flap", flapportal: "flap" };

// 外部注入:下单(server.mjs 的 copyOrder)、识别(市值过滤用)、TG
let deps = { order: null, detect: null, notify: () => {} };
export function initCopy(d) { deps = { ...deps, ...d }; }

export function copyState() { return { tasks: state.tasks, paused: !!state.paused, log: recent.slice(0, 300), defaults: COPY_DEFAULTS }; }
export function copyPauseAll(paused) { state.paused = !!paused; save(); return copyState(); }
export function copyTask(body) {
  if (body.target !== undefined && !body.id) {
    const t = newCopyTask(body);
    state.tasks.push(t); save(); return t;
  }
  const t = state.tasks.find((x) => x.id === body.id);
  if (!t) throw new Error("没有这个跟单任务");
  if (body.delete) {
    if (t.status !== "closed") throw new Error("先关闭任务再删除");
    state.tasks = state.tasks.filter((x) => x !== t); save(); return { ok: true };
  }
  applyCopyEdit(t, body);   // params / name / status:先全部校验再改
  save(); return t;
}

function checkLimit(t) {
  const p = t.params, n = p.dryRun ? t.stats.simCopies : t.stats.copies;
  if (p.maxCopies > 0 && n >= p.maxCopies) {
    t.status = "closed"; t.closedAt = Date.now(); t.closeReason = `已跟满 ${p.maxCopies} 次`;
    record(t, "stop", t.closeReason);
  }
}

// ---------- 决定跟不跟 ----------
async function decide(t, ev) {
  const p = t.params, plat = PF[ev.platform];
  if (t.status !== "running") return;
  if (state.paused) return record(t, "skip", "全部暂停中", ev);
  const tk = t.tokens[ev.ca] ?? { bought: 0, open: false, n: 0, simBnb: 0, symbol: ev.symbol };   // 真跟买了才记进任务
  // ---- 跟卖 ----
  if (ev.side === "sell") {
    if (!p.followSell) return;
    if (!tk.open) return record(t, "skip", "这个币没跟买过,不跟卖", ev);
    const pct = ev.action === "清仓" ? 100 : Math.min(100, Math.max(1, Math.round(ev.pct ?? 100)));
    if (p.dryRun) { t.stats.sims++; if (pct === 100) tk.open = false; save(); return record(t, "sim", `会卖出 ${pct}%(对方${ev.action}${ev.pct ? " " + ev.pct.toFixed(0) + "%" : ""})`, ev, { pct }); }
    try {
      const r = await deps.order({ ca: ev.ca, action: "sell", accts: p.wallets, arg: String(pct), slip: p.slippage });
      const ok = Object.values(r.results).some((x) => x.ok);
      t.stats.sells++; t.stats.lastAt = Date.now();
      if (pct === 100 && ok) tk.open = false;
      save();
      record(t, ok ? "order" : "fail", `卖出 ${pct}%`, ev, { results: r.results });
      deps.notify(`${ok ? "📤" : "⚠️"} 跟单「${t.name}」${ok ? "卖出" : "卖出失败"} ${ev.symbol} ${pct}%\n<code>${ev.ca}</code>`);
    } catch (e) { record(t, "error", e.message, ev); }
    return;
  }
  // ---- 跟买 ----
  if (p.maxCopies > 0 && (p.dryRun ? t.stats.simCopies : t.stats.copies) >= p.maxCopies) return record(t, "skip", `已跟满 ${p.maxCopies} 次`, ev);
  if (!plat || !p.platforms.includes(plat)) return record(t, "skip", `平台 ${ev.platform} 没勾选`, ev);
  if (p.onlyFirst && ev.action === "加仓") return record(t, "skip", "只跟建仓,这笔是加仓", ev);
  if (p.onlyFirst && tk.n > 0) return record(t, "skip", "这个币已经跟过", ev);
  const delay = Math.floor(Date.now() / 1000) - Number(ev.ts || 0);
  if (ev.ts && delay > p.maxDelaySec) return record(t, "skip", `晚了 ${delay} 秒(上限 ${p.maxDelaySec} 秒)`, ev);
  const px = await bnbUsd().catch(() => null);
  const tBnb = ev.quote === "BNB" ? ev.quoteAmt : ev.usd && px ? ev.usd / px : null;
  if (p.minTargetBnb > 0 && !(tBnb >= p.minTargetBnb)) return record(t, "skip", `对方只买了 ${tBnb?.toFixed(4) ?? "?"} BNB,低于下限 ${p.minTargetBnb}`, ev);
  if (p.maxTargetBnb > 0 && tBnb > p.maxTargetBnb) return record(t, "skip", `对方买了 ${tBnb.toFixed(4)} BNB,高于上限 ${p.maxTargetBnb}`, ev);
  if (p.maxMcUsd > 0) {
    const d = await deps.detect?.(ev.ca).catch(() => null);
    if (d?.mcUsd && d.mcUsd > p.maxMcUsd) return record(t, "skip", `市值 $${Math.round(d.mcUsd)} 超过上限 $${p.maxMcUsd}`, ev);
  }
  let base = p.mode === "ratio" ? (tBnb ? (tBnb * p.ratioPct) / 100 : null) : p.amountBnb;
  if (!base) return record(t, "skip", "算不出对方花了多少 BNB,按比例跟不了", ev);
  const nW = p.wallets.length, day = today(), spent = t.days[day] ?? 0;
  let amt = Math.min(base, p.maxPerTrade, HARD_MAX_TRADE, p.maxPerToken - tk.bought);
  if (spent + amt * nW > p.dailyCap) amt = (p.dailyCap - spent) / nW;
  const open = Object.values(t.tokens).filter((x) => x.open).length;
  if (!tk.open && open >= p.maxOpen) return record(t, "skip", `已经同时持有 ${open} 个跟单的币(上限 ${p.maxOpen})`, ev);
  amt = Math.floor(amt * 1e5) / 1e5;
  if (!(amt >= 0.001)) return record(t, "skip", "额度用完了(单币 / 每天上限)", ev);
  tk.n++; t.tokens[ev.ca] = tk;   // 先占位:同一个币连着两笔不会重复跟
  if (p.dryRun) {
    t.stats.sims++; t.stats.simCopies++; tk.simBnb += amt * nW; t.stats.lastAt = Date.now();
    record(t, "sim", `会用 ${amt} BNB × ${nW} 个钱包买入(对方${ev.action} ${tBnb ? tBnb.toFixed(4) + " BNB" : ""})`, ev, { bnb: amt });
    checkLimit(t); save(); return;
  }
  save();
  try {
    const r = await deps.order({ ca: ev.ca, action: "buy", accts: p.wallets, bnb: amt, slip: p.slippage });
    // 已提交的(成交或在等确认)都按花了钱算
    const paid = Object.values(r.results).filter((x) => x.ok || x.submitted).length;
    if (paid) {
      tk.bought += amt; tk.open = true; t.days[day] = (t.days[day] ?? 0) + amt * paid;
      t.stats.buyBnb += amt * paid; t.stats.buys++; t.stats.copies++; t.stats.lastAt = Date.now();
    }
    const ok = Object.values(r.results).some((x) => x.ok);
    record(t, ok ? "order" : "fail", `买入 ${amt} BNB × ${nW} 个钱包`, ev, { bnb: amt, results: r.results });
    deps.notify(`${ok ? "📥" : "⚠️"} 跟单「${t.name}」${ok ? "买入" : "买入失败"} ${ev.symbol} ${amt} BNB × ${nW}\n<code>${ev.ca}</code>`);
    checkLimit(t); save();
  } catch (e) { tk.n--; save(); record(t, "error", e.message, ev); }
}

// 同一个任务的决定按顺序处理(两笔挨着到也不会算重额度)
const chains = new Map();
bus.on("event", (ev) => {
  if (ev.type !== "track" || ev.backfill || !ev.ca) return;
  for (const t of state.tasks) {
    if (t.target !== lc(ev.target) || t.status !== "running") continue;
    const prev = chains.get(t.id) ?? Promise.resolve();
    chains.set(t.id, prev.then(() => decide(t, ev)).catch((e) => record(t, "error", e.message, ev)));
  }
});

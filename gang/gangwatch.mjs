#!/usr/bin/env node
// Gang 持仓涨跌监控(每 15 分钟由 Windows 计划任务跑一次):node gangwatch.mjs [--hello] [--dry]
//   价格来自 gang.fun/api/tokens/<CA>(V1 = priceBnb,V2 = priceQuote,底池币计价)。
//   和持仓均价比,穿过档位就推 TG:-50% / -30% / +30% / +60% / +100% / +200% / +400% / +900%;
//   同一档只推一次,回落到别的档再推。毕业、进度 ≥80% 各推一次。连续 4 次拉不到价格也推一次。
//   --hello 推一条当前全部持仓概况;--dry 只打印不推送。
import "../env.mjs";   // 先读 .env
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const POS = JSON.parse(readFileSync(here("./positions.json"), "utf8")).tokens;
const STATE_FILE = here("./watch-state.json");
const LEVELS = [-50, -30, 30, 60, 100, 200, 400, 900];
const args = process.argv.slice(2);
const DRY = args.includes("--dry"), HELLO = args.includes("--hello");

// TG 凭证:只从环境变量 / agentbuy/.env 读(TG_BOT_TOKEN、TG_CHAT_ID);没配就只在终端打印
function tgCreds() {
  return { token: process.env.TG_BOT_TOKEN, chat: process.env.TG_CHAT_ID };
}
async function tg(text) {
  if (DRY) { console.log("---- TG(dry) ----\n" + text); return; }
  const { token, chat } = tgCreds();
  if (!token || !chat) { console.log("(没配 TG,设 TG_BOT_TOKEN / TG_CHAT_ID 环境变量就会推送)\n" + text); return; }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) console.error("TG 发送失败", r.status, await r.text());
}
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const band = (pct) => { let b = 0; for (const l of LEVELS) { if (l < 0 && pct <= l) { b = l; break; } if (l > 0 && pct >= l) b = l; } return b; };
const pctStr = (p) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
const fmt = (x) => (x >= 1 ? x.toFixed(4) : x.toPrecision(4));

const lines = [], alerts = [];
const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
for (const t of POS) {
  const st = (state[t.address] ??= { band: 0, fails: 0 });
  let d;
  try {
    const r = await fetch(`https://gang.fun/api/tokens/${t.address}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d = await r.json();
  } catch (e) {
    st.fails++;
    console.error(t.symbol, "拉取失败", e.message);
    if (st.fails === 4) alerts.push(`⚠️ <b>${t.symbol}</b> 连续 4 次拉不到 gang.fun 价格(${e.message}),监控可能失效`);
    continue;
  }
  st.fails = 0;
  const price = Number(d.priceQuote ?? d.priceBnb);
  const hs = Object.entries(t.holdings);
  const amount = hs.reduce((s, [, h]) => s + h.amount, 0), cost = hs.reduce((s, [, h]) => s + h.cost, 0);
  const entry = cost / amount, pct = (price / entry - 1) * 100;
  const value = price * amount;
  const accts = hs.map(([a]) => `账号${a}`).join("+");
  const line = `${t.symbol} ${pctStr(pct)}  按现价≈${fmt(value)} ${t.quote}(成本 ${fmt(cost)})进度 ${d.progressPct}%${d.graduated ? " 已毕业" : ""}`;
  lines.push(line);
  console.log(now, line);

  const b = band(pct);
  if (b !== st.band) {
    const up = b > st.band;
    if (b !== 0 || st.band !== 0) {
      alerts.push(`${up ? "🟢" : "🔴"} <b>${t.symbol}</b> ${b === 0 ? "回到成本附近" : (b > 0 ? "涨" : "跌") + "过 " + Math.abs(b) + "%"}:现在 ${pctStr(pct)}\n` +
        `按现价≈${fmt(value)} ${t.quote},成本 ${fmt(cost)}(${accts} 共 ${amount / 1e4}万个)进度 ${d.progressPct}%\n<code>${t.address}</code>`);
    }
    st.band = b;
  }
  if (d.graduated && !st.graduated) { st.graduated = true; alerts.push(`🎓 <b>${t.symbol}</b> 已毕业到 PancakeSwap(pair <code>${d.pair}</code>),现在 ${pctStr(pct)},可以在外盘卖了\n<code>${t.address}</code>`); }
  if (!d.graduated && Number(d.progressPct) >= 80 && !st.near) { st.near = true; alerts.push(`🚀 <b>${t.symbol}</b> 内盘进度 ${d.progressPct}%,快毕业了,现在 ${pctStr(pct)}\n<code>${t.address}</code>`); }
}
if (HELLO) await tg(`📋 Gang 持仓监控已开启(每 15 分钟,${now})\n涨跌按持仓均价算,底池币计价;穿过 ±30%、-50%、+60%、+100% 等档位才推送\n\n` + lines.join("\n"));
for (const a of alerts) await tg(a);
if (!DRY) writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

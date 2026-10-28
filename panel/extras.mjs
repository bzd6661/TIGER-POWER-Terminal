// 交易细节:设置(单笔上限 / 自动领取)、授权管理、底池币余额、下单耗时、ID Agent 自动领取。
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { provider } from "./detect.mjs";
import { bawJson, sessions } from "./session.mjs";
import { quoteUsdOf } from "./history.mjs";
import { marketList } from "./live.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const erc = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function decimals() view returns (uint8)"]);
const call = (to, fn, a = []) => provider.call({ to, data: erc.encodeFunctionData(fn, a) }).then((r) => erc.decodeFunctionResult(fn, r)[0]);

// ---------- 设置 ----------
const SFILE = here("./settings.json");
let S = { maxBuyBnb: 0, autoClaim: false };
try { S = { ...S, ...JSON.parse(readFileSync(SFILE, "utf8")) }; } catch {}
export const settings = () => ({ ...S });
// 校验要改的设置,返回规整过的改动 { maxBuyBnb?: 数字, autoClaim?: 布尔 }(不对就抛错,什么都不改)。
//   网页改设置要本机批准:批准框照这份写,批准后原样交给 setSettings
export function cleanSettings(b) {
  const p = {};
  if (b.maxBuyBnb !== undefined) { const v = Number(b.maxBuyBnb); if (!(v >= 0 && v <= 100)) throw new Error("单笔上限要在 0–100 BNB 之间(0 = 不限)"); p.maxBuyBnb = v; }
  if (b.autoClaim !== undefined) p.autoClaim = b.autoClaim === true;
  return p;
}
export function setSettings(b) {
  Object.assign(S, cleanSettings(b));
  writeFileSync(SFILE, JSON.stringify(S, null, 1));
  return settings();
}
// 下单前检查单笔上限(按 BNB 买入;按比例买时用报出来的花费)
export function checkMaxBuy(bnb) {
  if (S.maxBuyBnb > 0 && !(Number(bnb) > 0)) throw new Error(`算不出这笔折合多少 BNB,设了单笔上限 ${S.maxBuyBnb} BNB 时不下单;请改用按 BNB 数量买`);
  if (S.maxBuyBnb > 0 && Number(bnb) > S.maxBuyBnb) throw new Error(`超过单笔上限 ${S.maxBuyBnb} BNB(这笔约 ${Number(bnb).toPrecision(4)} BNB);要改上限去账户总览的「设置」`);
}

// ---------- 授权管理:币安钱包列出的授权 + 链上当前额度核对 ----------
export async function approvals() {
  const ss = await sessions();
  const out = [];
  for (const s of Object.values(ss).filter((x) => x.connected)) {
    const r = await bawJson(s.acct, ["approvals", "list", "--limit", "100"]);
    for (const a of r?.data?.list ?? []) {
      const onchain = await call(a.tokenContract, "allowance", [s.address, a.spender]).catch(() => null);
      const dec = a.tokenDecimals ?? 18;
      out.push({ acct: s.acct, token: a.tokenContract.toLowerCase(), symbol: a.tokenSymbol, spender: a.spender.toLowerCase(), spenderName: a.spenderName,
        listed: Number(ethers.formatUnits(a.amount ?? "0", dec)), onchain: onchain === null ? null : Number(ethers.formatUnits(onchain, dec)),
        unlimited: onchain !== null && onchain > 10n ** 60n, risk: a.riskyLevel, type: a.type, time: a.time });
    }
  }
  return out;
}
// 撤销 = 发一笔 approve(0) 交易,只在本人点按钮时调用
export async function revoke(acct, token, spender, type = "approve") {
  if (!ethers.isAddress(token) || !ethers.isAddress(spender)) throw new Error("地址格式不对");
  const r = await bawJson(acct, ["approvals", "revoke", "--binanceChainId", "56", "--tokenContract", token, "--spender", spender, "--type", type === "permit2" ? "permit2" : "approve"], 120_000);
  if (!r.success) throw new Error("撤销失败:" + JSON.stringify(r.error ?? r).slice(0, 200));
  return r.data;
}

// ---------- 底池币余额(GANG / BNCB / 币股 / WBNB …)----------
const QUOTES = {
  WBNB: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", GANG: "0x0c6302401aa5325c2e36f170f52c00b1d220b405", BNCB: "0x4902c5ebc598265ed2212b559b042de8a5eeec3f",
  NVDAB: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436", QQQB: "0x205812cdbed920aff76c6580abd681a46d11efc7", SPCXB: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1",
};
export async function quoteBalances() {
  const ss = await sessions();
  const accts = Object.values(ss).filter((x) => x.connected);
  const rows = [];
  for (const [sym, ca] of Object.entries(QUOTES)) {
    const [dec, usd] = await Promise.all([call(ca, "decimals").catch(() => 18n), quoteUsdOf(sym === "WBNB" ? "BNB" : ca).catch(() => null)]);
    for (const s of accts) {
      const bal = await call(ca, "balanceOf", [s.address]).catch(() => null);
      if (bal === null || bal === 0n) continue;
      const amount = Number(ethers.formatUnits(bal, dec));
      rows.push({ acct: s.acct, symbol: sym, ca, amount, usd: usd ? amount * usd : null });
    }
  }
  return rows;
}

// ---------- 下单耗时 ----------
const LFILE = here("./latency.jsonl");
export function recordLatency(rec) { try { appendFileSync(LFILE, JSON.stringify(rec) + "\n"); } catch {} }
export function latencyStats(days = 1) {
  let rows = [];
  try { rows = readFileSync(LFILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  const since = Date.now() - days * 86400_000;
  rows = rows.filter((r) => r.ts >= since);
  const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const groups = {};
  for (const r of rows) (groups[`${r.platform}·${r.action}`] ??= []).push(r);
  return Object.entries(groups).map(([k, rs]) => {
    const ok = rs.filter((r) => r.ok), ms = ok.map((r) => r.ms);
    return { key: k, n: rs.length, ok: ok.length, p50: q(ms, 0.5), p90: q(ms, 0.9), avgPreview: avg(ok.map((r) => r.steps?.preview).filter(Boolean)), avgSubmit: avg(ok.map((r) => r.steps?.submitted).filter(Boolean)) };
  }).sort((a, b) => b.n - a.n);
}
const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);

// ---------- ID Agent 自动领取(设置里打开才跑) ----------
const mc = new ethers.Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])", "function phase() view returns (uint8)", "function sharesOf(address) view returns (uint256)"]);
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
let claiming = false;
const claimTried = new Map();   // market:acct → 上次尝试时间
async function claimTick(busy, notify) {
  if (!S.autoClaim || claiming) return;
  claiming = true;
  try {
    const ss = await sessions();
    const accts = Object.values(ss).filter((x) => x.connected && x.address);
    const ms = marketList();
    if (!accts.length || !ms.length) return;
    const calls = ms.flatMap(([m]) => [[m, mc.encodeFunctionData("phase")], ...accts.map((a) => [m, mc.encodeFunctionData("sharesOf", [a.address])])]);
    const res = [];
    for (let i = 0; i < calls.length; i += 300) {
      const chunk = calls.slice(i, i + 300);
      const r = await provider.call({ to: MULTICALL, data: mc.encodeFunctionData("aggregate3", [chunk.map(([t, d]) => ({ target: t, allowFailure: true, callData: d }))]) });
      res.push(...mc.decodeFunctionResult("aggregate3", r)[0]);
    }
    const per = 1 + accts.length;
    for (let i = 0; i < ms.length; i++) {
      const [m, meta] = ms[i];
      const ph = res[i * per]; if (!ph.success || mc.decodeFunctionResult("phase", ph.returnData)[0] !== 3n) continue;
      for (let j = 0; j < accts.length; j++) {
        const sh = res[i * per + 1 + j]; if (!sh.success) continue;
        if (mc.decodeFunctionResult("sharesOf", sh.returnData)[0] === 0n) continue;
        const a = accts[j].acct, key = m + ":" + a;
        if (Date.now() - (claimTried.get(key) ?? 0) < 5 * 60_000 || busy.has(a)) continue;   // 失败的 5 分钟后再试
        claimTried.set(key, Date.now());
        busy.add(a);
        const r = await new Promise((resolve) => {
          const ps = spawn(process.execPath, [here("../claim.mjs"), m, "--acct", a], { cwd: here("../"), windowsHide: true });
          let out = ""; ps.stdout.on("data", (d) => (out += d)); ps.stderr.on("data", (d) => (out += d));
          ps.on("close", (code) => resolve({ code, out }));
        }).finally(() => busy.delete(a));
        const sym = meta.symbol || meta.ca?.slice(0, 8);
        if (r.code === 0) notify(`✅ 自动领取 ${sym}:账号${a} 已领到代币`);
        else if (r.code !== 3 && r.code !== 4) notify(`⚠️ 自动领取 ${sym} 账号${a} 失败:${(r.out.split(/\r?\n/).reverse().find((l) => l.startsWith("✗")) ?? "").slice(0, 160)}`);
      }
    }
  } catch (e) { console.error("[自动领取]", e.message); }
  finally { claiming = false; }
}
export function startAutoClaim(busy, notify) { setInterval(() => claimTick(busy, notify), 30_000); }

// BNB ↔ 底池币兑换(币安钱包 market-order)。
//   有的底池币是 Ondo 代币化股票(比如 FXIon),币安只允许它和稳定币直接换,BNB 直接换会报
//   "Unsupported token pair for Ondo trading, one side must be a supported stablecoin" —— 这种自动改走 USDT 两步:
//   BNB → USDT → 底池币 / 底池币 → USDT → BNB。每个币走哪条路记在本机 .quote-routes.json。
//   第一步成交、第二步失败时,USDT 会留在钱包里(会说清楚),不会丢。
//   等成交:订单状态和链上余额一起看,余额先到就直接往下走(订单状态常比余额晚 1~3 秒)。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

export const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const USDT = "0x55d398326f99059fF775485246999027B3197955";
const ONDO = /one side must be a supported stablecoin|Unsupported token pair for Ondo/i;
const FILE = fileURLToPath(new URL("./.quote-routes.json", import.meta.url));
const load = () => { try { return JSON.parse(readFileSync(FILE, "utf8")) || {}; } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (r) => JSON.stringify(r?.error ?? r ?? "");

const quoteArgs = (qty, from, to, slip) => ["market-order", "quote", "--fromTokenQty", String(qty), "--fromToken", from, "--toToken", to, "--binanceChainId", "56", "--slippage", String(slip)];
const swapArgs = (qty, from, to, slip) => ["market-order", "swap", "--fromTokenQty", String(qty), "--fromToken", from, "--toToken", to, "--binanceChainId", "56", "--slippage", String(slip)];

// 底池币的小数位:大多是 18 位,XAUt 是 6 位。链上读一次后缓存;读不到按 18。
//   注意 gang CLI 的金额参数一律按 18 位解析(传的是原始单位 / 1e18),只有换算成真实数量、去兑换时才用这个
const KNOWN_DEC = { "0x21caef8a43163eea865baee23b9c2e327696a3bf": 6 };   // XAUt
const decCache = new Map();
export async function quoteDecimals(token) {
  const k = String(token).toLowerCase();
  if (KNOWN_DEC[k] !== undefined) return KNOWN_DEC[k];
  if (decCache.has(k)) return decCache.get(k);
  let d = 18;
  try {
    const r = await fetch(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: k, data: "0x313ce567" }, "latest"] }), signal: AbortSignal.timeout(8000) }).then((x) => x.json());
    if (r?.result && r.result !== "0x") d = Number(BigInt(r.result));
    decCache.set(k, d);
  } catch { /* 网络失败不缓存,下次再读 */ }
  return d;
}

// "direct" 或 "usdt"
export async function routeOf(baw, token, slip = 3) {
  const k = String(token).toLowerCase(), all = load();
  if (all[k]) return all[k];
  const r = await baw(quoteArgs("0.01", BNB, token, slip));
  let v;
  if (r?.success) v = "direct";
  else if (ONDO.test(errText(r))) v = "usdt";
  else throw new Error(`拿不到 ${token} 的兑换报价:${errText(r).slice(0, 200)}`);
  all[k] = v;
  try { writeFileSync(FILE, JSON.stringify(all, null, 1)); } catch {}
  return v;
}

// 1 BNB 大约能换多少个这个币(只报价)
export async function perBnb(baw, token, slip = 3) {
  const via = await routeOf(baw, token, slip);
  if (via === "direct") {
    const r = await baw(quoteArgs("0.01", BNB, token, slip));
    if (!r?.success) throw new Error(`兑换询价失败:${errText(r).slice(0, 200)}`);
    return { perBnb: Number(r.data.toCoinAmount) / 0.01, via };
  }
  const u = await baw(quoteArgs("0.01", BNB, USDT, slip));
  if (!u?.success) throw new Error(`BNB→USDT 询价失败:${errText(u).slice(0, 200)}`);
  const t = await baw(quoteArgs(Number(u.data.toCoinAmount).toFixed(6), USDT, token, slip));
  if (!t?.success) throw new Error(`USDT→底池币 询价失败:${errText(t).slice(0, 200)}`);
  return { perBnb: Number(t.data.toCoinAmount) / 0.01, via };
}

// 提交一笔兑换并等到账;返回到账数量(bigint,按链上余额差;卖成 BNB 时按订单的 toTokenActualQty)
async function swapWait({ baw, wallet, from, to, qty, slip, balanceOf, label, log }) {
  const before = to === BNB ? null : await balanceOf(to, wallet);
  const sw = await baw(swapArgs(qty, from, to, slip));
  if (!sw?.success) throw new Error(`${label} 提交失败:${errText(sw).slice(0, 300)}`);
  log?.(`${label} 已提交 orderId ${sw.data.orderId}`);
  let o = null;
  for (let i = 0; i < 150; i++) {
    if (before !== null) { const got = (await balanceOf(to, wallet).catch(() => before)) - before; if (got > 0n) return { got, orderId: sw.data.orderId }; }
    if (i % 2 === 0) {
      o = (await baw(["market-order", "list", "--orderId", sw.data.orderId]))?.data?.list?.[0];
      if (o?.status === "FAILED") throw new Error(`${label} 失败(orderId ${sw.data.orderId})`);
      if (o?.status === "FINISHED" && before === null) return { got: ethers.parseEther(Number(o.toTokenActualQty || 0).toFixed(18)), orderId: sw.data.orderId, txHash: o.txHash };
    }
    await sleep(400);
  }
  if (o?.status === "FINISHED" && before !== null) {
    for (let i = 0; i < 25; i++) { const got = (await balanceOf(to, wallet)) - before; if (got > 0n) return { got, orderId: sw.data.orderId }; await sleep(400); }
  }
  throw new Error(`${label} 60 秒没成交 / 没到账(${o?.status ?? "?"}),orderId ${sw.data.orderId},别重复提交`);
}

// BNB → 底池币;bnbAmt 是字符串 / 数字。返回到账数量(bigint)
export async function bnbToToken({ baw, wallet, token, bnbAmt, slip = 3, balanceOf, log, sym = "底池币" }) {
  const via = await routeOf(baw, token, slip);
  if (via === "direct") return (await swapWait({ baw, wallet, from: BNB, to: token, qty: bnbAmt, slip, balanceOf, label: `BNB→${sym}`, log })).got;
  log?.(`${sym} 是 Ondo 类代币,币安只允许和稳定币直接换:走 BNB → USDT → ${sym}`);
  const u = await swapWait({ baw, wallet, from: BNB, to: USDT, qty: bnbAmt, slip, balanceOf, label: "BNB→USDT", log });
  try {
    return (await swapWait({ baw, wallet, from: USDT, to: token, qty: ethers.formatEther(u.got), slip, balanceOf, label: `USDT→${sym}`, log })).got;
  } catch (e) { throw new Error(`${e.message}(第一步已经换成了 ${ethers.formatEther(u.got)} USDT,留在钱包里)`); }
}

// 底池币 → BNB;amountWei 是 bigint。返回换到的 BNB(bigint,按订单)
export async function tokenToBnb({ baw, wallet, token, amountWei, decimals = 18, slip = 3, balanceOf, log, sym = "底池币" }) {
  const qty = ethers.formatUnits(amountWei, decimals);
  const via = await routeOf(baw, token, slip);
  if (via === "direct") return (await swapWait({ baw, wallet, from: token, to: BNB, qty, slip, balanceOf, label: `${sym}→BNB`, log })).got;
  log?.(`${sym} 是 Ondo 类代币:走 ${sym} → USDT → BNB`);
  const u = await swapWait({ baw, wallet, from: token, to: USDT, qty, slip, balanceOf, label: `${sym}→USDT`, log });
  try {
    return (await swapWait({ baw, wallet, from: USDT, to: BNB, qty: ethers.formatEther(u.got), slip, balanceOf, label: "USDT→BNB", log })).got;
  } catch (e) { throw new Error(`${e.message}(第一步已经换成了 ${ethers.formatEther(u.got)} USDT,留在钱包里)`); }
}

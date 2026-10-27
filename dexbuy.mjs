#!/usr/bin/env node
// 外盘(DEX)买入,任何已上 DEX 的币:node dexbuy.mjs <CA> <BNB数量> [--slip 10] [--acct 1|2|both] [--dry]
//   币安钱包报价 → market-order swap BNB→代币(固定滑点)→ 轮询到终态 → 打印实际买到多少。--dry 只报价。
import { ethers } from "ethers";
import { takeAcct, bawSpawn, runBoth } from "./accounts.mjs";

const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const ACCT = takeAcct(args);
if (ACCT === "both") { runBoth(import.meta.url, args); await new Promise(() => {}); }
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry");
const slip = opt("--slip") ?? "10";
const [ca, amt] = args;
if (!ca || !ethers.isAddress(ca) || !/^\d+(\.\d{1,18})?$/.test(amt ?? "") || Number(amt) <= 0 || !(Number(slip) > 0 && Number(slip) <= 50))
  die("用法 node dexbuy.mjs <CA> <BNB数量> [--slip 10] [--acct 1|2|both] [--dry]");

function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(ACCT, [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}

const q = await baw(["market-order", "quote", "--fromTokenQty", amt, "--fromToken", BNB, "--toToken", ca, "--binanceChainId", "56", "--slippage", slip]);
if (!q.success) die(`报价失败(可能还没上 DEX 或流动性太差):${JSON.stringify(q.error ?? q)}`);
log(`${amt} BNB → 约 ${q.data.toCoinAmount} ${q.data.toCoinSymbol},滑点 ${slip}%`);
if (DRY) { log("--dry:只报价,没有买"); process.exit(0); }
const sw = await baw(["market-order", "swap", "--fromTokenQty", amt, "--fromToken", BNB, "--toToken", ca, "--binanceChainId", "56", "--slippage", slip]);
if (!sw.success) die(`买入提交失败:${JSON.stringify(sw.error ?? sw)}`);
log(`已提交 orderId ${sw.data.orderId},等待成交…`);
let o;
for (let i = 0; i < 75; i++) {
  o = (await baw(["market-order", "list", "--orderId", sw.data.orderId]))?.data?.list?.[0];
  if (o?.status === "FINISHED" || o?.status === "FAILED") break;
  await sleep(400);   // 兑换订单状态 0.4 秒查一次
}
if (o?.status === "FAILED") die(`买入失败(价格变动超过滑点或流动性不足),BNB 没花:${JSON.stringify(o)}`);
if (o?.status !== "FINISHED") die(`60 秒还没成交(${o?.status}),不要重复提交;稍后用 baw market-order list --orderId ${sw.data.orderId} --json 查`);
log(`✓ 成交 tx ${o.txHash}  买到 ${o.toTokenActualQty} ${q.data.toCoinSymbol}(报价 ${q.data.toCoinAmount})`);

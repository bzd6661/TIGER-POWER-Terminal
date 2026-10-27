#!/usr/bin/env node
// 外盘(DEX)买入,任何已上 DEX 的币:node dexbuy.mjs <CA> <BNB数量> [--slip 10] [--acct 1|2|both] [--dry]
//   币安钱包报价 → market-order swap BNB→代币(固定滑点)→ 轮询到终态 → 打印实际买到多少。--dry 只报价。
//   刚毕业的盘币安聚合器常常还报不出价:自动改走 PancakeSwap V2 直连(pancake.mjs),同样先 preview 模拟和风控。
//   --mid <地址>:直连时优先试的中间币(Gang 毕业的盘传它的底池币)
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
const MID = opt("--mid");
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
if (!q.success) {
  log(`币安钱包报不出价(${JSON.stringify(q.error ?? q).slice(0, 160)}),改走 PancakeSwap V2 直连`);
  await pancakeBuy();
  process.exit(0);
}
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

// ---------- PancakeSwap V2 直连买入 ----------
async function pancakeBuy() {
  const { findPath, amountOut, buyCalldata, ROUTER } = await import("./pancake.mjs");
  const { readFileSync } = await import("node:fs");
  const path = await findPath(ca, MID);
  if (!path) die("PancakeSwap V2 上也没找到这个币的池子(可能还没上 DEX,或池子在 V3 / 别的 DEX),BNB 没花");
  const value = ethers.parseEther(amt);
  const out = await amountOut(value, path);
  if (out === 0n) die("PancakeSwap 报价是 0,不买");
  const minOut = (out * BigInt(Math.round((100 - Number(slip)) * 100))) / 10000n;
  log(`PancakeSwap 路径 ${path.map((x) => x.slice(0, 8)).join(" → ")}:${amt} BNB → 约 ${ethers.formatEther(out)} 个(按 18 位),最少 ${ethers.formatEther(minOut)},滑点 ${slip}%`);
  let W = null;
  try { W = readFileSync(new URL(ACCT === "2" ? "./.wallet2" : "./.wallet", import.meta.url), "utf8").trim(); } catch {}
  if (!/^0x[0-9a-fA-F]{40}$/.test(W ?? "")) W = (await baw(["wallet", "address"]))?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
  if (!W) die("拿不到钱包地址");
  const p = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", ROUTER, "--value", value.toString(), "--inputData", buyCalldata(minOut, path, W)]);
  if (!p.success) die(`PancakeSwap 买入 preview 失败:${JSON.stringify(p.error ?? p)}`);
  if (p.data.requireConfirmation) die("这笔要去 Binance App 批准(钱包判成了有风险的交易),按你的设置不提交,BNB 没花");
  const risks = p.data.risks?.riskDetails || [];
  if (risks.length) die(`钱包报了风险,不执行:${JSON.stringify(risks)}`);
  if (DRY) { log("--dry:preview 通过,没有买"); return; }
  const ex = await baw(["contract-call", "execute", "--requestId", p.data.requestId]);
  if (!ex.success) die(`execute 失败:${JSON.stringify(ex.error ?? ex)}`);
  if (!ex.data.txHash) die(`没拿到 txHash(${ex.data.status}),去 Binance App 看一下,别重复提交`);
  log(`已提交 ${ex.data.txHash}`);
  const net = ethers.Network.from(56);
  const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
  provider.pollingInterval = 300;
  const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
  if (!rc) die(`60 秒没确认,别重复提交:${ex.data.txHash}`);
  if (rc.status !== 1) die(`链上失败(多半是价格变动超过滑点):${ex.data.txHash}`);
  log(`✓ 成交 tx ${ex.data.txHash}(PancakeSwap 直连)`);
}

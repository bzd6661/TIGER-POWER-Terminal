#!/usr/bin/env node
// four.meme Open 模式(OpenFour)卖出,走 baw(和 sell.mjs 同一套规则)。
//
//   node foursell.mjs <CA> <百分比1-100> [--slip 30] [--swap-slip 5] [--keep] [--proof 0x..] [--dry]
//   加 --sim:只做链上模拟、打印 calldata,不调 baw(FOURBUY_WALLET=0x.. 可以换模拟用的地址)
//
//   内盘中:Core.sell 卖给曲线(先授权代币给 Core);BNB 底池直接拿回 BNB,
//           ERC20 底池拿回底池币后默认再用 market-order 换成 BNB(--keep 则留着底池币)。
//   已毕业:estimateSell 返回 0,改到 DEX 用 market-order 把代币卖成 BNB。
// 百分比是当前持仓的百分比;--slip 是内盘 / DEX 卖出的滑点,--swap-slip 是底池币换 BNB 的滑点。
// Agent ID 模式(1778027615735)卖出也可能要资格 / proof:estimateSell 会先用你的地址模拟,不过就停。
import { spawn } from "node:child_process";
import { bawSpawn } from "./accounts.mjs";
import { checkLiquid } from "./liq.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";

const CORE = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
const TOOLS = "0x97da82f56fef1a0b974587a48135fa9da2a4e905";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const WALLET_CACHE = new URL("./.wallet", import.meta.url);
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;   // 等回执时每 0.3 秒查一次(ethers 默认 4 秒)

const core = new ethers.Contract(CORE, [
  "function tokens(address) view returns (uint32 version,address creator,uint256 presetId,address token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address tokenModule,address customData,uint256 createBlock,bool exists,bool paused,bool antiSniperEnabled)",
  "function sell(address token,uint256 amount,uint256 minReceiveAmount,uint256 options,bytes proof)",
], provider);
const tools = new ethers.Contract(TOOLS, [
  "function estimateSell(address token,address trader,uint256 amount,uint256 options,bytes proof) view returns (uint256 curveQuote,uint256 totalFee,uint256 userPays,uint256 userReceives,uint256 tokenAmount,uint256 executionPrice)",
], provider);
const erc20 = (a) => new ethers.Contract(a, [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
], provider);

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry"), KEEP = flag("--keep"), SIM = flag("--sim");
const slip = opt("--slip") ?? "30", swapSlip = opt("--swap-slip") ?? "5";
const proof = opt("--proof") ?? "0x";
const [ca, pctRaw] = args;
if (!ca || !ethers.isAddress(ca) || !pctRaw || !/^\d+(\.\d{1,2})?$/.test(pctRaw) || Number(pctRaw) <= 0 || Number(pctRaw) > 100 ||
    !(Number(slip) >= 0 && Number(slip) < 100) || !(Number(swapSlip) > 0 && Number(swapSlip) < 50) || !ethers.isHexString(proof))
  die("用法 node foursell.mjs <CA> <百分比1-100> [--slip 30] [--swap-slip 5] [--keep] [--proof 0x..] [--dry] [--sim]");
const bps = BigInt(Math.round(Number(pctRaw) * 100));
const keepBps = BigInt(Math.round((100 - Number(slip)) * 100));

function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(process.env.AGENTBUY_ACCT === "2" ? "2" : "1", [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}
async function wallet() {
  if (process.env.FOURBUY_WALLET) return process.env.FOURBUY_WALLET;
  try { return readFileSync(WALLET_CACHE, "utf8").trim(); } catch {}
  const r = await baw(["wallet", "address"]);
  const w = r?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
  if (!w) die(`拿不到钱包地址,先确认 baw 已登录:${JSON.stringify(r)}`);
  writeFileSync(WALLET_CACHE, w);
  return w;
}
// preview → 模拟 / 风险检查 → execute(任何风险项都不执行)
async function send(label, W, to, data) {
  if (SIM) { log(`${label}(--sim 不调 baw)to=${to}\n  calldata=${data}`); return null; }
  const pv = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", to, "--value", "0", "--inputData", data]);
  if (!pv.success) die(`${label} preview 失败:${JSON.stringify(pv.error ?? pv)}`);
  const r = pv.data.risks;
  if (pv.data.simulationResult?.simulationCode !== "000000000") die(`${label} 模拟没通过:${JSON.stringify(pv.data.simulationResult)}`);
  if (r?.riskDetails?.length || Object.values(r?.addresses ?? {}).some((x) => x?.riskDetails?.length)) die(`${label} 钱包报了风险,不执行:${JSON.stringify(r)}`);
  if (pv.data.requireConfirmation) die(`${label} 需要去 Binance App 批准,按你的设置不提交(钱包把这笔判成了有风险的交易)`);
  if (DRY) { log(`${label} preview 通过(--dry 不执行)`); process.exit(0); }
  const ex = await baw(["contract-call", "execute", "--requestId", pv.data.requestId]);
  if (!ex.success) die(`${label} execute 失败:${JSON.stringify(ex.error ?? ex)}`);
  log(`${label} ${ex.data.status} ${ex.data.txHash ?? ex.data.message ?? ""}`);
  if (!ex.data.txHash) die(`${label} 没拿到 txHash,去 App 确认`);
  return ex.data.txHash;
}
const mined = async (h, label) => {
  if (!h) return;
  const rc = await provider.waitForTransaction(h, 1, 60_000).catch(() => null);
  if (!rc) die(`${label} 60 秒没确认,别重复提交:${h}`);
  if (rc.status !== 1) die(`${label} 链上失败:${h}`);
};
async function why(e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (e?.reason) return e.reason;
  if (typeof data === "string" && data.length >= 10) {
    const sel = data.slice(0, 10);
    const name = await fetch(`https://api.openchain.xyz/signature-database/v1/lookup?function=${sel}&filter=true`)
      .then((r) => r.json()).then((j) => j?.result?.function?.[sel]?.[0]?.name).catch(() => null);
    return `${name ?? "自定义错误"} ${sel}${data.length > 10 ? " 参数 " + data.slice(10, 138) : ""}`;
  }
  return e?.shortMessage || e?.message || String(e);
}

/** 代币 → BNB(baw market-order)。--dry / --sim 只报价 */
async function swapToBnb(label, token, amountWei, dec, slipPct) {
  const qty = ethers.formatUnits(amountWei, dec);
  if (SIM) { log(`${label}(--sim 不调 baw)会把 ${qty} 换成 BNB,滑点 ${slipPct}%`); return; }
  if (DRY) {
    const q = await baw(["market-order", "quote", "--fromTokenQty", qty, "--fromToken", token, "--toToken", BNB, "--binanceChainId", "56", "--slippage", slipPct]);
    log(`${label} 报价 ${qty} → ${q?.data?.toCoinAmount ?? JSON.stringify(q.error ?? q)} BNB(--dry 不卖)`);
    return;
  }
  const sw = await baw(["market-order", "swap", "--fromTokenQty", qty, "--fromToken", token, "--toToken", BNB, "--binanceChainId", "56", "--slippage", slipPct]);
  if (!sw.success) {
    if (sw.error?.code === 30003001) die(`${label} 被钱包拦了:这个币不在 Agentic Wallet 的可交易代币设置里,币还在钱包。\n  → 币安 App → Agentic Wallet 页面放开 ${token} 后重跑`);
    die(`${label} 失败:${JSON.stringify(sw.error ?? sw)}`);
  }
  let o;
  for (let i = 0; i < 60; i++) {
    o = (await baw(["market-order", "list", "--orderId", sw.data.orderId]))?.data?.list?.[0];
    if (o?.status === "FINISHED" || o?.status === "FAILED") break;
    await sleep(400);   // 兑换订单状态 0.4 秒查一次
  }
  if (o?.status !== "FINISHED") die(`${label} 没成交(${o?.status}),orderId ${sw.data.orderId},别重复提交`);
  log(`${label} ✓ orderId ${sw.data.orderId}`);
}

const W = await wallet();
const t = await core.tokens(ca).catch(() => null);
if (!t || !t.exists) die(`${ca} 不是 OpenFour 的币(Core.tokens 查不到)`);
const tok = erc20(ca);
const isBnb = t.quoteAsset.toLowerCase() === WBNB;
const q = erc20(t.quoteAsset);
const [sym, qdec] = isBnb ? ["BNB", 18n] : await Promise.all([q.symbol().catch(() => "?"), q.decimals().then(BigInt).catch(() => 18n)]);
const [bal, dec] = await Promise.all([tok.balanceOf(W), tok.decimals().then(BigInt).catch(() => 18n)]);
log(`钱包 ${W}${DRY ? "(--dry:只 preview 不执行)" : ""}`);
log(`${t.symbol} preset ${t.presetId} 底池 ${sym} · 持有 ${ethers.formatUnits(bal, dec)}`);
const amount = (bal * bps) / 10000n;
if (amount === 0n && !SIM) die("持仓是 0,没东西可卖");
const sellAmt = amount > 0n ? amount : ethers.parseUnits("100000", dec);   // --sim 且空仓时拿 10 万个演示
if (amount === 0n) log("(--sim:持仓是 0,下面按 10 万个演示)");

// 1. 用你的地址模拟卖出:回滚 = 资格 / proof 不过;全 0 = 已毕业
let est;
try { est = await tools.estimateSell.staticCall(ca, W, sellAmt, 0, proof, { from: W }); }
catch (e) { die(`模拟卖出被拒:${await why(e)}\n  → 资格不够或需要 proof(用 --proof 传)`); }

if (est.userReceives === 0n && est.tokenAmount === 0n) {
  // ---------- 已毕业 / 新模式:走币安钱包兑换卖 ----------
  // Agent ID 模式(1778027615735)对不在白名单的地址报价全 0,直接调 Core 也卖不了,同样交给钱包兑换
  const why0 = t.presetId === 1778027615735n ? "新模式(Agent ID),走币安钱包兑换卖" : "内盘已结束,改到 DEX 卖";
  log(`${why0} ${ethers.formatUnits(sellAmt, dec)} 个(持仓的 ${pctRaw}%)滑点 ${slip}%`);
  await swapToBnb("卖出", ca, sellAmt, dec, slip);
  process.exit(0);
}

// ---------- 内盘:Core.sell ----------
const minOut = (est.userReceives * keepBps) / 10000n;
log(`卖 ${ethers.formatUnits(sellAmt, dec)} 个(持仓的 ${pctRaw}%)预计 ${ethers.formatUnits(est.userReceives, qdec)} ${sym}(手续费 ${ethers.formatUnits(est.totalFee, qdec)})最少 ${ethers.formatUnits(minOut, qdec)}`);

const allow = await tok.allowance(W, CORE);
if (allow < sellAmt) {
  const ap = tok.interface.encodeFunctionData("approve", [CORE, sellAmt]);
  if (DRY) { log(`--dry:需要先授权 ${ethers.formatUnits(sellAmt, dec)} 个给 Core,卖出的 preview 跳过`); process.exit(0); }
  await mined(await send("授权", W, ca, ap), "授权");
}

const before = isBnb || KEEP ? 0n : await q.balanceOf(W);
const h = await send("卖出", W, CORE, core.interface.encodeFunctionData("sell", [ca, sellAmt, minOut, 0, proof]));
await mined(h, "卖出");
if (h) log(`✓ 卖出 https://bscscan.com/tx/${h}`);
if (isBnb || KEEP) process.exit(0);

// ERC20 底池:拿回的底池币再换成 BNB
let got = 0n;
for (let i = 0; i < 10 && got <= 0n && !SIM; i++) { got = (await q.balanceOf(W)) - before; if (got <= 0n) await sleep(400); }
if (SIM) got = minOut;
if (got <= 0n) die(`卖出成交但没看到 ${sym} 到账,先查交易`);
log(`拿回 ${ethers.formatUnits(got, qdec)} ${sym},换成 BNB(滑点 ${swapSlip}%)`);
{ const lq = await checkLiquid(t.quoteAsset, sym); if (!lq.ok) { log(`⚠️ ${lq.msg}。卖出已完成,${sym} 留在钱包里(面板「底池币余额」可以之后再换)`); process.exit(0); } }
await swapToBnb(`${sym}→BNB`, t.quoteAsset, got, qdec, swapSlip);

#!/usr/bin/env node
// 一键买入 ID Agent 内盘(Flap 系,BNB 池和 ERC20 底池都支持)。用法:
//   node buy.mjs <CA> <数量> [--slip 30] [--swap-slip 5] [--quote] [--dry]
//   BNB 池:数量 = BNB。
//   ERC20 池(NVDAB/BNCB 等):默认数量 = BNB,先 BNB→底池币兑换,再精确授权 Market,再买;
//                           加 --quote 则数量 = 底池币,直接用钱包里已有的底池币。
// 走本机已登录的币安 Agentic Wallet(baw CLI)。每笔链上操作都先 eth_call 模拟 + baw preview,有风险项就停。
// --dry 只检查+预览第一步,不执行任何交易。
import "./env.mjs";   // 先读 .env
import { checkLiquid } from "./liq.mjs";
import { spawn } from "node:child_process";
import { ethers } from "ethers";

const FACTORY = "0xC55820f24015bE7c4f18949D9e1363A3609B300e";
const PORTAL = "0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062";
const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const RPC = process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org";

const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(RPC, net, { staticNetwork: net });
provider.pollingInterval = 300;   // 等回执时每 0.3 秒查一次(ethers 默认 4 秒)
const iface = new ethers.Interface([
  "function marketOfToken(address) view returns (address)",
  "function probeOfMarket(address) view returns (address)",
  "function portal() view returns (address)",
  "function market() view returns (address)",
  "function assetProbe()",
  "function actionStatusProbe()",
  "function buyCapacityProbe()",
  "function buyPlanProbe(uint256,uint256)",
  "function quoteFundingProbe(uint256)",
  "function positionProbe()",
  "function buy(address,uint256) payable returns (uint256)",
  "function buyWithQuote(address,uint256,uint256) returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
function die(msg) { console.error(`\n✗ 停止:${msg}`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 参数 ----------
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry");
const USE_QUOTE = flag("--quote");
const slipPct = opt("--slip") ?? "30";
const swapSlipPct = opt("--swap-slip") ?? "5";
const [caRaw, amountRaw] = args;
if (!caRaw || !amountRaw) die("用法 node buy.mjs <CA> <数量> [--slip 30] [--swap-slip 5] [--quote] [--dry]");
if (!ethers.isAddress(caRaw)) die(`CA 不是合法地址:${caRaw}`);
if (!/^\d+(\.\d{1,18})?$/.test(amountRaw) || Number(amountRaw) <= 0) die(`数量不合法:${amountRaw}`);
for (const [n, v] of [["--slip", slipPct], ["--swap-slip", swapSlipPct]])
  if (!/^\d+(\.\d+)?$/.test(v) || Number(v) > 100) die(`${n} 要是 0–100 的百分比:${v}`);
const CA = ethers.getAddress(caRaw);
const amountWei = ethers.parseEther(amountRaw);
const slipBps = BigInt(Math.round(Number(slipPct) * 100));

// ---------- 工具 ----------
function baw(cliArgs) {
  return new Promise((resolve, reject) => {
    const ps = spawn("baw", [...cliArgs, "--json"], { shell: true });
    let out = "", err = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.stderr.on("data", (d) => (err += d));
    ps.on("close", () => {
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`baw 输出无法解析:${(out + err).slice(0, 300)}`)); }
    });
  });
}
const view = (to, fn, a = []) =>
  provider.call({ to, data: iface.encodeFunctionData(fn, a) }).then((r) => iface.decodeFunctionResult(fn, r)[0]);
function revertString(e) {
  const d = e?.data || e?.info?.error?.data;
  if (typeof d === "string" && d.startsWith("0x08c379a0")) return ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + d.slice(10))[0];
  return null;
}
// Probe 方法故意 revert,读数在 Error(string) 里,必须以 ;END 结尾才算读到
async function probe(probeAddr, from, fn, a = []) {
  try { await provider.call({ from, to: probeAddr, data: iface.encodeFunctionData(fn, a), value: 0 }); }
  catch (e) {
    const s = revertString(e);
    if (!s || !s.endsWith(";END")) die(`${fn} 读不到(unreadable):${s ?? e.shortMessage}`);
    return Object.fromEntries(s.split(";").filter((x) => x.includes("=")).map((x) => x.split("=")));
  }
  die(`${fn} 没有 revert,Probe 版本不对`);
}
// 一笔链上操作:eth_call 模拟 → baw preview(无风险才继续)→ baw execute → 等回执
async function send(label, W, to, value, data) {
  try { await provider.call({ from: W, to, data, value }); }
  catch (e) { die(`${label} 链上模拟失败:${revertString(e) ?? e.shortMessage}`); }
  const pv = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", to,
    "--value", value.toString(), "--inputData", data]);
  if (!pv.success) die(`${label} preview 失败:${JSON.stringify(pv.error ?? pv)}`);
  const sim = pv.data.simulationResult, risks = pv.data.risks;
  if (sim?.simulationCode !== "000000000") die(`${label} preview 模拟没通过:${JSON.stringify(sim)}`);
  if (risks?.riskDetails?.length || Object.values(risks?.addresses ?? {}).some((x) => x?.riskDetails?.length)) die(`${label} 钱包报了风险,不执行:${JSON.stringify(risks)}`);
  if (pv.data.requireConfirmation) die(`${label} 需要去 Binance App 批准,按你的设置不提交(钱包把这笔判成了有风险的交易)`);
  log(`${label} preview 通过 requestId ${pv.data.requestId}`);
  if (DRY) { log("--dry:到此为止,没有执行"); process.exit(0); }
  const ex = await baw(["contract-call", "execute", "--requestId", pv.data.requestId]);
  if (!ex.success) die(`${label} execute 失败:${JSON.stringify(ex.error ?? ex)}`);
  log(`${label} 已提交 ${ex.data.status} ${ex.data.txHash ?? ""} ${ex.data.message ?? ""}`);
  if (!ex.data.txHash) die(`${label} 没拿到 txHash(${ex.data.status}),去 App 里确认后重跑`);
  const rc = await provider.waitForTransaction(ex.data.txHash, 1, 90_000).catch(() => null);
  if (!rc) die(`${label} 90 秒内没等到回执,状态 PENDING,不要重复提交:${ex.data.txHash}`);
  if (rc.status !== 1) die(`${label} 交易失败(区块 ${rc.blockNumber}):${ex.data.txHash}`);
  log(`${label} ✓ 上链成功 区块 ${rc.blockNumber}`);
  return rc;
}
// 内盘买入计划;超出单钱包上限时给出明确提示
async function buyPlan(probeAddr, W, gross, cap, unit) {
  const plan = await probe(probeAddr, W, "buyPlanProbe", [gross, slipBps]);
  if (plan.RULES_OK !== "1" && plan.BUY_SHARES && BigInt(plan.BUY_SHARES) > BigInt(cap.ROOM_SHARES))
    die(`超出单钱包上限:${ethers.formatEther(gross)} ${unit} 约 ${ethers.formatUnits(plan.BUY_SHARES, 18)} 份,你还能买 ${ethers.formatUnits(cap.ROOM_SHARES, 18)} 份,请减少数量`);
  if (plan.RULES_OK !== "1" || !plan.MIN_SHARES) die(`买入计划不通过:${JSON.stringify(plan)}`);
  return plan;
}

// ---------- 定位池子 ----------
log(`CA ${CA}  数量 ${amountRaw}${USE_QUOTE ? "(底池币)" : ""}  内盘滑点 ${slipPct}%${DRY ? "  (只预览)" : ""}`);
const [status, addrRes, market, portal] = await Promise.all([
  baw(["wallet", "status"]),
  baw(["wallet", "address"]),
  view(FACTORY, "marketOfToken", [CA]),
  view(FACTORY, "portal"),
]);
if (status?.data?.status !== "CONNECTED") die(`币安钱包没登录:${JSON.stringify(status)}`);
const W = addrRes?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
if (!W) die("拿不到 BSC 钱包地址");
if (portal.toLowerCase() !== PORTAL.toLowerCase()) die(`工厂返回的 Portal 变了:${portal},先人工核对`);
if (market === ethers.ZeroAddress) die("这个 CA 在 ID Agent 工厂里查不到对应的内盘");

const probeAddr = await view(FACTORY, "probeOfMarket", [market]);
const bound = await view(probeAddr, "market");
if (bound.toLowerCase() !== market.toLowerCase()) die(`Probe 绑定不一致:${probeAddr} → ${bound}`);

const [asset, act, cap] = await Promise.all([
  probe(probeAddr, W, "assetProbe"),
  probe(probeAddr, W, "actionStatusProbe"),
  probe(probeAddr, W, "buyCapacityProbe"),
]);
if (asset.MARKET?.toLowerCase() !== market.toLowerCase()) die(`assetProbe 不匹配:${JSON.stringify(asset)}`);
if (asset.DECIMALS !== "18") die(`底池币精度是 ${asset.DECIMALS},脚本只按 18 位处理`);
if (act.PHASE === "3") die(`已经发币(PHASE=3),代币 ${act.TOKEN},内盘不能买了,去 DEX`);
if (act.PHASE !== "1") die(`市场不在内盘阶段:PHASE=${act.PHASE}`);
if (act.BUY_OK !== "1") die(`BUY_OK=${act.BUY_OK},这个钱包现在不能买`);
if (cap.ID !== "1") die("这个钱包没有 Agent ID");

const QUOTE = asset.QUOTE === ethers.ZeroAddress ? null : ethers.getAddress(asset.QUOTE);
const sym = QUOTE ? await view(QUOTE, "symbol") : "BNB";
log(`钱包 ${W}  Market ${market}  底池 ${sym}${QUOTE ? " " + QUOTE : ""}`);

// ---------- BNB 池 ----------
if (!QUOTE) {
  if (USE_QUOTE) die("这是 BNB 池,不需要 --quote");
  const plan = await buyPlan(probeAddr, W, amountWei, cap, "BNB");
  log(`预计 ${ethers.formatUnits(plan.BUY_SHARES, 18)} 份,最少 ${ethers.formatUnits(plan.MIN_SHARES, 18)} 份`);
  await send("买入", W, PORTAL, amountWei, iface.encodeFunctionData("buy", [market, BigInt(plan.MIN_SHARES)]));
  const pos = await probe(probeAddr, W, "positionProbe");
  log(`✓ 完成  现在持有 ${ethers.formatUnits(pos.HELD_SHARES, 18)} 份`);
  process.exit(0);
}

// ---------- ERC20 底池 ----------
let gross;
if (USE_QUOTE) {
  gross = amountWei;
} else {
  // 先按报价估算能换到多少底池币,确认买入规则能过再兑换,免得换完买不进去
  const q = await baw(["market-order", "quote", "--fromTokenQty", amountRaw, "--fromToken", BNB, "--toToken", QUOTE,
    "--binanceChainId", "56", "--slippage", swapSlipPct]);
  if (!q.success) die(`兑换报价失败:${JSON.stringify(q.error ?? q)}`);
  const est = ethers.parseEther(Number(q.data.toCoinAmount).toFixed(18));
  const worst = est - (est * BigInt(Math.round(Number(swapSlipPct) * 100))) / 10000n;
  log(`兑换报价 ${amountRaw} BNB ≈ ${q.data.toCoinAmount} ${sym}(滑点 ${swapSlipPct}%)`);
  await buyPlan(probeAddr, W, est, cap, sym);
  await buyPlan(probeAddr, W, worst, cap, sym);
  { const lq = await checkLiquid(QUOTE, sym); if (!lq.ok) die(lq.msg + "(钱没动)"); }
  if (DRY) { log("--dry:兑换前检查都通过,没有兑换也没有买入"); process.exit(0); }

  const before = await view(QUOTE, "balanceOf", [W]);
  const sw = await baw(["market-order", "swap", "--fromTokenQty", amountRaw, "--fromToken", BNB, "--toToken", QUOTE,
    "--binanceChainId", "56", "--slippage", swapSlipPct]);
  if (!sw.success) die(`兑换提交失败:${JSON.stringify(sw.error ?? sw)}`);
  const orderId = sw.data.orderId;
  log(`兑换已提交 orderId ${orderId},等待成交…`);
  let order;
  for (let i = 0; i < 40; i++) {
    const r = await baw(["market-order", "list", "--orderId", orderId]);
    order = r?.data?.list?.[0];
    if (order && (order.status === "FINISHED" || order.status === "FAILED")) break;
    await sleep(1500);
  }
  if (order?.status === "FAILED") die(`兑换失败:${JSON.stringify(order)}`);
  if (order?.status !== "FINISHED") die(`兑换 60 秒还没完成(${order?.status}),不要重复提交,orderId ${orderId}`);
  let after = before;
  for (let i = 0; i < 10 && after <= before; i++) { after = await view(QUOTE, "balanceOf", [W]); if (after <= before) await sleep(1000); }
  gross = after - before;
  if (gross <= 0n) die(`兑换显示完成但余额没增加,先查 orderId ${orderId}`);
  log(`兑换成交 tx ${order.txHash}  实际到账 ${ethers.formatEther(gross)} ${sym}`);
}

let fund = await probe(probeAddr, W, "quoteFundingProbe", [gross]);
if (fund.BALANCE_OK !== "1") die(`${sym} 余额不够 ${ethers.formatEther(gross)}`);
if (fund.ALLOWANCE_OK !== "1") {
  log(`授权 Market 扣 ${ethers.formatEther(gross)} ${sym}(只授权这一次的数量)`);
  await send("授权", W, QUOTE, 0n, iface.encodeFunctionData("approve", [market, gross]));
  fund = await probe(probeAddr, W, "quoteFundingProbe", [gross]);
  if (fund.BALANCE_OK !== "1" || fund.ALLOWANCE_OK !== "1") die(`授权后资金检查仍不通过:${JSON.stringify(fund)}`);
}
const plan = await buyPlan(probeAddr, W, gross, cap, sym);
log(`预计 ${ethers.formatUnits(plan.BUY_SHARES, 18)} 份,最少 ${ethers.formatUnits(plan.MIN_SHARES, 18)} 份`);
await send("买入", W, PORTAL, 0n, iface.encodeFunctionData("buyWithQuote", [market, gross, BigInt(plan.MIN_SHARES)]));
const pos = await probe(probeAddr, W, "positionProbe");
log(`✓ 完成  现在持有 ${ethers.formatUnits(pos.HELD_SHARES, 18)} 份`);

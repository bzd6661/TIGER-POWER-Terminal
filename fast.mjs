#!/usr/bin/env node
// 极速版:node fast.mjs <CA> <数量> [--slip 30] [--swap-slip 5] [--quote] [--wait] [--dry]
// 和 buy.mjs 的区别:不查 Probe、不做本地 eth_call 模拟、不等回执、钱包地址本地缓存。
// 保留的只有 baw preview 自带的模拟 + 风险项检查(execute 必须要 preview 的 requestId,省不掉)。
// ERC20 底池不再做兑换前的上限预检:超过单钱包上限的话,兑换会成交但买入 preview 会失败,底池币留在钱包里。
import { takeAcct, bawSpawn, runBoth } from "./accounts.mjs";
import { checkLiquid } from "./liq.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";

const FACTORY = "0xC55820f24015bE7c4f18949D9e1363A3609B300e";
const PORTAL = "0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062";
const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;   // 等回执时每 0.3 秒查一次(ethers 默认 4 秒)
const iface = new ethers.Interface([
  "function marketOfToken(address) view returns (address)",
  "function quoteBuy(address,uint256) view returns (uint256 accept,uint256 fee,uint256 refund,uint256 shares)",
  "function quoteToken() view returns (address)",
  "function phase() view returns (uint8)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function buy(address,uint256) payable returns (uint256)",
  "function buyWithQuote(address,uint256,uint256) returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const ACCT = takeAcct(args);
if (ACCT === "both") { runBoth(import.meta.url, args); await new Promise(() => {}); }
const WALLET_CACHE = new URL(ACCT === "2" ? "./.wallet2" : "./.wallet", import.meta.url);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const WAIT = flag("--wait"), USE_QUOTE = flag("--quote"), DRY = flag("--dry");
const slip = Number(opt("--slip") ?? "30"), swapSlip = opt("--swap-slip") ?? "5";
const [ca, amt] = args;
if (!ca || !amt || !ethers.isAddress(ca) || !/^\d+(\.\d{1,18})?$/.test(amt) || !(slip >= 0 && slip <= 100))
  die("用法 node fast.mjs <CA> <数量> [--slip 30] [--swap-slip 5] [--quote] [--wait]");
const amountWei = ethers.parseEther(amt);
const keepBps = BigInt(Math.round((100 - slip) * 100));

function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(ACCT, [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}
const call = (to, fn, a = []) => provider.call({ to, data: iface.encodeFunctionData(fn, a) }).then((r) => iface.decodeFunctionResult(fn, r));
async function wallet() {
  try { return readFileSync(WALLET_CACHE, "utf8").trim(); } catch {}
  const r = await baw(["wallet", "address"]);
  const w = r?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
  if (!w) die(`拿不到钱包地址,先确认 baw 已登录:${JSON.stringify(r)}`);
  writeFileSync(WALLET_CACHE, w);
  return w;
}
// preview → 风险检查 → execute,返回 txHash
async function send(label, W, to, value, data) {
  const pv = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", to, "--value", value.toString(), "--inputData", data]);
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
  const rc = await provider.waitForTransaction(h, 1, 60_000).catch(() => null);
  if (!rc) die(`${label} 60 秒没确认,别重复提交:${h}`);
  if (rc.status !== 1) die(`${label} 链上失败:${h}`);
};

const [W, [market]] = await Promise.all([wallet(), call(FACTORY, "marketOfToken", [ca])]);
if (market === ethers.ZeroAddress) die("这个 CA 查不到内盘");
const [[phase], [quote]] = await Promise.all([call(market, "phase"), call(market, "quoteToken")]);
if (phase !== 1n) die(`不在内盘阶段(phase=${phase})${phase === 3n ? ",已发币去 DEX" : ""}`);

if (quote === ethers.ZeroAddress) {
  // BNB 池:一步买入
  const q = await call(market, "quoteBuy", [W, amountWei]);
  const min = (q.shares * keepBps) / 10000n;
  log(`Market ${market} 预计 ${ethers.formatUnits(q.shares, 18)} 份 最少 ${ethers.formatUnits(min, 18)}`);
  const h = await send("买入", W, PORTAL, amountWei, iface.encodeFunctionData("buy", [market, min]));
  if (WAIT) { await mined(h, "买入"); log("✓ 已上链"); }
  process.exit(0);
}

// ERC20 底池:兑换(可选)→ 不够才授权 → 买入
// 兑换前先确认有 Agent ID,免得换完了买不进去
const [agentIds] = await call("0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F", "balanceOf", [W]);
if (agentIds === 0n) die(`钱包 ${W} 没有 Agent ID,内盘买不了`);
let gross = amountWei;
if (!USE_QUOTE) {
  { const lq = await checkLiquid(quote); if (!lq.ok) die(lq.msg + "(钱没动)"); }
  if (DRY) { log(`ERC20 底池 ${quote},--dry 不兑换`); process.exit(0); }
  const before = (await call(quote, "balanceOf", [W]))[0];
  const sw = await baw(["market-order", "swap", "--fromTokenQty", amt, "--fromToken", BNB, "--toToken", quote, "--binanceChainId", "56", "--slippage", swapSlip]);
  if (!sw.success) die(`兑换失败:${JSON.stringify(sw.error ?? sw)}`);
  let o;
  for (let i = 0; i < 60; i++) {
    o = (await baw(["market-order", "list", "--orderId", sw.data.orderId]))?.data?.list?.[0];
    if (o?.status === "FINISHED" || o?.status === "FAILED") break;
    await sleep(400);   // 兑换订单状态 0.4 秒查一次
  }
  if (o?.status !== "FINISHED") die(`兑换没成交(${o?.status}),orderId ${sw.data.orderId},别重复提交`);
  let after = before;
  for (let i = 0; i < 15 && after <= before; i++) { after = (await call(quote, "balanceOf", [W]))[0]; if (after <= before) await sleep(400); }
  gross = after - before;
  if (gross <= 0n) die(`兑换完成但余额没变,查 orderId ${sw.data.orderId}`);
  log(`兑换到账 ${ethers.formatEther(gross)}`);
}
const [[allow], q] = await Promise.all([call(quote, "allowance", [W, market]), call(market, "quoteBuy", [W, gross])]);
if (allow < gross) await mined(await send("授权", W, quote, 0n, iface.encodeFunctionData("approve", [market, gross])), "授权");
const min = (q.shares * keepBps) / 10000n;
log(`Market ${market} 预计 ${ethers.formatUnits(q.shares, 18)} 份 最少 ${ethers.formatUnits(min, 18)}`);
const h = await send("买入", W, PORTAL, 0n, iface.encodeFunctionData("buyWithQuote", [market, gross, min]));
if (WAIT) { await mined(h, "买入"); log("✓ 已上链"); }

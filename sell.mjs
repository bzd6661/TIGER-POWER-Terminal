#!/usr/bin/env node
// 极速卖出:node sell.mjs <CA> <百分比> [--slip 30] [--swap-slip 5] [--keep] [--wait] [--dry]
//   内盘中(phase=1):Portal.sellBps 卖内盘份额;BNB 池直接拿回 BNB,
//                   ERC20 底池(NVDAB 等)拿回底池币后默认再换成 BNB(--keep 则留着底池币)。
//   已发币(phase=3):有没领的份额先 Portal.claim,再把代币按百分比在 DEX 卖成 BNB(market-order)。
// 百分比 1–100;--slip 是内盘卖出 / 发币后 DEX 卖出的滑点,--swap-slip 是底池币换 BNB 的滑点。
// 和 fast.mjs 一样:只保留 baw preview 自带的模拟和风险检查。
import { takeAcct, bawSpawn, runBoth } from "./accounts.mjs";
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
  "function quoteToken() view returns (address)",
  "function phase() view returns (uint8)",
  "function token() view returns (address)",
  "function sharesOf(address) view returns (uint256)",
  "function quoteSellExactShares(address,uint256) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function sellBps(address,uint256,uint256) returns (uint256)",
  "function claim(address) returns (uint256)",
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
const WAIT = flag("--wait"), KEEP = flag("--keep"), DRY = flag("--dry");
const slip = opt("--slip") ?? "30", swapSlip = opt("--swap-slip") ?? "5";
const [ca, pctRaw] = args;
if (!ca || !pctRaw || !ethers.isAddress(ca) || !/^\d+(\.\d{1,2})?$/.test(pctRaw) || Number(pctRaw) <= 0 || Number(pctRaw) > 100 ||
    !(Number(slip) >= 0 && Number(slip) <= 100) || !(Number(swapSlip) >= 0 && Number(swapSlip) <= 100))
  die("用法 node sell.mjs <CA> <百分比1-100> [--slip 30] [--swap-slip 5] [--keep] [--wait] [--dry]");
const bps = BigInt(Math.round(Number(pctRaw) * 100));
const keepBps = BigInt(Math.round((100 - Number(slip)) * 100));

function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(ACCT, [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}
const call = (to, fn, a = []) => provider.call({ to, data: iface.encodeFunctionData(fn, a) }).then((r) => iface.decodeFunctionResult(fn, r)[0]);
async function wallet() {
  try { return readFileSync(WALLET_CACHE, "utf8").trim(); } catch {}
  const r = await baw(["wallet", "address"]);
  const w = r?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
  if (!w) die(`拿不到钱包地址,先确认 baw 已登录:${JSON.stringify(r)}`);
  writeFileSync(WALLET_CACHE, w);
  return w;
}
async function send(label, W, to, data) {
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
async function mined(h, label) {
  const rc = await provider.waitForTransaction(h, 1, 60_000).catch(() => null);
  if (!rc) die(`${label} 60 秒没确认,别重复提交:${h}`);
  if (rc.status !== 1) die(`${label} 链上失败:${h}`);
  return rc;
}
// DEX 卖成 BNB:提交 market-order 后轮询到终态
async function swapToBnb(label, token, amountWei, decimals, slipPct) {
  const qty = ethers.formatUnits(amountWei, decimals);
  if (DRY) {
    const q = await baw(["market-order", "quote", "--fromTokenQty", qty, "--fromToken", token, "--toToken", BNB, "--binanceChainId", "56", "--slippage", slipPct]);
    log(`${label} 报价 ${qty} → ${q?.data?.toCoinAmount ?? JSON.stringify(q.error ?? q)} BNB(--dry 不卖)`);
    process.exit(0);
  }
  const sw = await baw(["market-order", "swap", "--fromTokenQty", qty, "--fromToken", token, "--toToken", BNB, "--binanceChainId", "56", "--slippage", slipPct]);
  if (!sw.success) die(`${label} 提交失败:${JSON.stringify(sw.error ?? sw)}`);
  log(`${label} 已提交 orderId ${sw.data.orderId}`);
  if (!WAIT) return;
  let o;
  for (let i = 0; i < 60; i++) {
    o = (await baw(["market-order", "list", "--orderId", sw.data.orderId]))?.data?.list?.[0];
    if (o?.status === "FINISHED" || o?.status === "FAILED") break;
    await sleep(400);   // 兑换订单状态 0.4 秒查一次
  }
  if (o?.status !== "FINISHED") die(`${label} 没成交(${o?.status}),orderId ${sw.data.orderId},别重复提交`);
  log(`${label} ✓ 到账 ${o.toTokenActualQty} BNB  tx ${o.txHash}`);
}

const [W, market] = await Promise.all([wallet(), call(FACTORY, "marketOfToken", [ca])]);
if (market === ethers.ZeroAddress) die("这个 CA 查不到内盘");
const [phase, quote, shares] = await Promise.all([call(market, "phase"), call(market, "quoteToken"), call(market, "sharesOf", [W])]);

// ---------- 已发币:领取 → DEX 卖 ----------
if (phase === 3n) {
  const token = await call(market, "token");
  if (shares > 0n) {
    log(`已发币,先领取 ${ethers.formatUnits(shares, 18)} 份 → ${token}`);
    await mined(await send("领取", W, PORTAL, iface.encodeFunctionData("claim", [market])), "领取");
  }
  const [bal, dec] = await Promise.all([call(token, "balanceOf", [W]), call(token, "decimals")]);
  const amount = (bal * bps) / 10000n;
  if (amount === 0n) die(`钱包里没有这个币可卖(${token})`);
  log(`DEX 卖出 ${ethers.formatUnits(amount, dec)} 个(持有的 ${pctRaw}%)滑点 ${slip}%`);
  await swapToBnb("卖出", token, amount, dec, slip);
  process.exit(0);
}
if (phase !== 1n) die(`市场状态 phase=${phase},不能卖`);

// ---------- 内盘:卖份额 ----------
if (shares === 0n) die("你在这个内盘没有份额");
const sellShares = (shares * bps) / 10000n;
const out = await call(market, "quoteSellExactShares", [W, sellShares]);
const min = (out * keepBps) / 10000n;
const isBnb = quote === ethers.ZeroAddress;
const sym = isBnb ? "BNB" : await call(quote, "symbol");
log(`Market ${market} 卖 ${ethers.formatUnits(sellShares, 18)} 份(${pctRaw}%)预计 ${ethers.formatEther(out)} ${sym} 最少 ${ethers.formatEther(min)}`);
const before = isBnb || KEEP ? 0n : await call(quote, "balanceOf", [W]);
const h = await send("内盘卖出", W, PORTAL, iface.encodeFunctionData("sellBps", [market, bps, min]));
if (isBnb || KEEP) {
  if (WAIT) { await mined(h, "内盘卖出"); log("✓ 已上链"); }
  process.exit(0);
}
// ERC20 底池:等卖出上链,把拿回的底池币换成 BNB
await mined(h, "内盘卖出");
let got = 0n;
for (let i = 0; i < 10 && got <= 0n; i++) { got = (await call(quote, "balanceOf", [W])) - before; if (got <= 0n) await sleep(400); }
if (got <= 0n) die(`内盘卖出已上链,但没看到 ${sym} 到账,先查 ${h}`);
log(`拿回 ${ethers.formatEther(got)} ${sym},换成 BNB(滑点 ${swapSlip}%)`);
await swapToBnb(`${sym}→BNB`, quote, got, 18, swapSlip);

#!/usr/bin/env node
// 外盘(DEX)卖出,任何平台毕业后的币都行:node dexsell.mjs <CA> <百分比1-100> [--slip 10] [--acct 1|2|both] [--dry]
//   读钱包里的实际余额 × 百分比 → 币安钱包报价 → market-order swap 卖成 BNB(固定滑点,价格掉太多就失败,不贱卖)
//   → 轮询订单到终态 → 打印实际到手 BNB。--dry 只报价不卖。
//   滑点默认 10%(不是 auto:auto 对小币可能给到 20% 以上,实际成交可能比报价低很多)。
import { ethers } from "ethers";
import { takeAcct, bawSpawn, runBoth } from "./accounts.mjs";

const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;   // 等回执时每 0.3 秒查一次(ethers 默认 4 秒)
const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
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
const [ca, pctRaw] = args;
if (!ca || !ethers.isAddress(ca) || !/^\d+(\.\d{1,2})?$/.test(pctRaw ?? "") || Number(pctRaw) <= 0 || Number(pctRaw) > 100 || !(Number(slip) > 0 && Number(slip) <= 50))
  die("用法 node dexsell.mjs <CA> <百分比1-100> [--slip 10] [--acct 1|2|both] [--dry]");

function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(ACCT, [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}
const call = (fn, a = []) => provider.call({ to: ca, data: erc20.encodeFunctionData(fn, a) }).then((r) => erc20.decodeFunctionResult(fn, r)[0]);

const addr = await baw(["wallet", "address"]);
const W = addr?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
if (!W) die(`拿不到钱包地址(baw 登录了吗?):${JSON.stringify(addr)}`);
const [bal, dec, sym] = await Promise.all([call("balanceOf", [W]), call("decimals"), call("symbol").catch(() => "?")]);
const amount = (bal * BigInt(Math.round(Number(pctRaw) * 100))) / 10000n;
if (amount === 0n) die(`${W} 没有 ${sym}(${ca})`);
const qty = ethers.formatUnits(amount, dec);

const q = await baw(["market-order", "quote", "--fromTokenQty", qty, "--fromToken", ca, "--toToken", BNB, "--binanceChainId", "56", "--slippage", slip]);
// Ondo 类代币(FXIon 等,面板「底池币余额 → 换回 BNB」常遇到):币安只允许和稳定币换,改走 代币 → USDT → BNB
if (!q.success && /one side must be a supported stablecoin|Unsupported token pair for Ondo/i.test(JSON.stringify(q.error ?? q))) {
  const { perBnb, tokenToBnb } = await import("./quoteswap.mjs");
  const pb = await perBnb(baw, ca, slip).catch((e) => die(e.message));
  log(`${sym} ${ca}  卖 ${qty} 个(持仓 ${ethers.formatUnits(bal, dec)} 的 ${pctRaw}%),Ondo 类代币经 USDT 中转,估计 ≈ ${(Number(qty) / pb.perBnb).toFixed(6)} BNB`);
  if (DRY) { log("--dry:只报价,没有卖"); process.exit(0); }
  const balOf = async (t, w) => (t === BNB ? 0n : BigInt(await provider.call({ to: t, data: "0x70a08231" + w.slice(2).toLowerCase().padStart(64, "0") })));
  try { const got = await tokenToBnb({ baw, wallet: W, token: ca, amountWei: amount, decimals: Number(dec), slip, balanceOf: balOf, log, sym }); log(`✓ 成交,到手约 ${ethers.formatEther(got)} BNB`); }
  catch (e) { die(e.message); }
  process.exit(0);
}
if (!q.success) die(`报价失败(可能还没毕业、外盘没池子或流动性太差):${JSON.stringify(q.error ?? q)}`);
const est = Number(q.data.toCoinAmount);
log(`${sym} ${ca}  卖 ${qty} 个(持仓 ${ethers.formatUnits(bal, dec)} 的 ${pctRaw}%)报价 ≈ ${est} BNB,滑点 ${slip}% → 最少约 ${(est * (1 - Number(slip) / 100)).toFixed(6)} BNB`);
if (DRY) { log("--dry:只报价,没有卖"); process.exit(0); }

const before = await provider.getBalance(W);
const sw = await baw(["market-order", "swap", "--fromTokenQty", qty, "--fromToken", ca, "--toToken", BNB, "--binanceChainId", "56", "--slippage", slip]);
if (!sw.success) die(`卖出提交失败:${JSON.stringify(sw.error ?? sw)}`);
log(`已提交 orderId ${sw.data.orderId},等待成交…`);
let o;
for (let i = 0; i < 75; i++) {
  o = (await baw(["market-order", "list", "--orderId", sw.data.orderId]))?.data?.list?.[0];
  if (o?.status === "FINISHED" || o?.status === "FAILED") break;
  await sleep(400);   // 兑换订单状态 0.4 秒查一次
}
if (o?.status === "FAILED") die(`卖出失败(价格变动超过滑点或流动性不足),币还在钱包里:${JSON.stringify(o)}`);
if (o?.status !== "FINISHED") die(`60 秒还没成交(${o?.status}),不要重复提交;稍后用 baw market-order list --orderId ${sw.data.orderId} --json 查`);
const after = await provider.getBalance(W);
log(`✓ 成交 tx ${o.txHash}`);
log(`  到手 ${o.toTokenActualQty} BNB(报价 ${est},${((Number(o.toTokenActualQty) / est - 1) * 100).toFixed(1)}%);钱包 BNB 变化 ${ethers.formatEther(after - before)}(已扣 gas)`);

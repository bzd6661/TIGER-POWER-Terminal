#!/usr/bin/env node
// Gang V2 内盘一键买满:node gangbuy.mjs <CA> [--tokens 数量] [--buffer 5] [--swap-slip 3] [--slip 1] [--dry]
//   默认买到单钱包上限(总量 1% = 1000 万个);--tokens 指定要买的数量。
//   流程:gang quote 算要多少底池币 → 不够就 BNB 兑换补足(多带 buffer%)→ gang buy(先精确授权)→ 执行 → 等上链。
//   合约会把超出上限的底池币退回,所以多带一点是安全的。
// 预览(授权、买入)都由官方 gang CLI 生成,经 baw preview 模拟和风控;有风险项就停。--dry 只算不做。
import { takeAcct, bawSpawn, runBoth, BAW2_ENTRY, BAW2_DIR } from "../accounts.mjs";
import { makeGang } from "./gangcore.mjs";
import { checkLiquid } from "../liq.mjs";
import { perBnb, bnbToToken } from "../quoteswap.mjs";
import { ethers } from "ethers";

const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;   // 等回执时每 0.3 秒查一次(ethers 默认 4 秒)
const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
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
const wantTokens = opt("--tokens");
const buffer = Number(opt("--buffer") ?? "5"), swapSlip = opt("--swap-slip") ?? "3", slip = opt("--slip") ?? "1";
const maxBnbRaw = opt("--max-bnb"), maxBnb = maxBnbRaw === null ? null : Number(maxBnbRaw);
if (maxBnb !== null && !(maxBnb > 0)) die("--max-bnb 要是正数");
const [ca] = args;
if (!ca || !ethers.isAddress(ca)) die("用法 node gangbuy.mjs <CA> [--tokens 数量] [--buffer 5] [--swap-slip 3] [--slip 1] [--dry]");

const gang = makeGang(ACCT);   // 进程内调 gang CLI 的库函数,不再每步起一个 CLI 进程
function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(ACCT, [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}
const balanceOf = async (token, who) => BigInt(await provider.call({ to: token, data: erc20.encodeFunctionData("balanceOf", [who]) }));
const fmt = (wei, d = 6) => Number(ethers.formatEther(wei)).toFixed(d);

// 执行一个 gang 生成的 preview:检查 → baw execute → 等上链
async function run(label, pv) {
  if (pv.success && pv.requireConfirmation) die(`${label} 需要去 Binance App 批准,按你的设置不提交(钱包把这笔判成了有风险的交易)`);
  if (!pv.success) die(`${label} preview 失败:${JSON.stringify(pv.error ?? pv)}`);
  if (pv.risks?.length) die(`${label} 钱包报了风险,不执行:${JSON.stringify(pv.risks)}`);
  if (DRY) { log(`${label} preview 通过(--dry 不执行)`); process.exit(0); }
  const ex = await baw(["contract-call", "execute", "--requestId", pv.requestId]);
  if (!ex.success) die(`${label} execute 失败:${JSON.stringify(ex.error ?? ex)}`);
  if (!ex.data.txHash) die(`${label} ${ex.data.status},去 Binance App 确认后重跑`);
  log(`${label} 已提交 ${ex.data.txHash}`);
  const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
  if (!rc) die(`${label} 60 秒没确认,别重复提交:${ex.data.txHash}`);
  if (rc.status !== 1) die(`${label} 链上失败:${ex.data.txHash}`);
  log(`${label} ✓ 上链 区块 ${rc.blockNumber}`);
}

const info = await gang(["token", "--token", ca]);
if (!info.success) die(`查不到这个币:${JSON.stringify(info.error ?? info)}`);
if (info.graduated) die(`已毕业,去 PancakeSwap 买(pair ${info.pair})`);
// V2 和以后的新版本(比如 V3,要新版 gang CLI 才认得)都按 CLI 给的报价 / calldata 走;第一代 soft 池用 gangv1buy.mjs
if (info.kind === "soft") die(`这是 ${info.kind} 池,用 gangv1buy.mjs`);
const W = info.buyer ?? (await baw(["wallet", "address"]))?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
const room = BigInt(info.myRoomRaw);
let target = wantTokens ? ethers.parseEther(wantTokens) : room;
if (room === 0n) die("这个币你已经买到上限了");
// 要买的超过剩余额度(单钱包 1% 上限):自动缩到剩余额度,买满为止
if (target > room) { log(`要买 ${ethers.formatEther(target)} 个,超过剩余额度,按剩余 ${ethers.formatEther(room)} 个买`); target = room; }
const hasId = BigInt(await provider.call({ to: "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F", data: erc20.encodeFunctionData("balanceOf", [W]) }));
if (hasId === 0n) die(`钱包 ${W} 没有 Agent ID,Gang 内盘买不了(先在 Binance App 领 .ai ID)`);
const quote = ethers.getAddress(info.quote);
log(`${info.symbol}(${info.name}) ${ca}  目标 ${ethers.formatEther(target)} 个  底池 ${quote}`);

// 用足够大的投入询价:超出上限的部分会显示为退款,spent 就是买到目标数量真正需要的底池币
let need;
{
  const big = Number(info.priceBnb) * Number(ethers.formatEther(target)) * 3 + 1;
  const q = await gang(["quote", "--token", ca, "--bnb", big.toFixed(6)]);
  if (!q.success) die(`询价失败:${JSON.stringify(q.error ?? q)}`);
  const out = ethers.parseEther(q.tokensOut.replaceAll(",", ""));
  if (wantTokens && out > target) {
    // 指定数量小于上限:按比例估算,再多带 buffer
    need = (ethers.parseEther(q.spent) * target) / out;
  } else need = ethers.parseEther(q.spent);
  log(`买 ${ethers.formatEther(target)} 个约需 ${fmt(need, 4)} 底池币(含 1% 手续费)`);
}
const input = (need * BigInt(Math.round((100 + buffer) * 100))) / 10000n;
// --max-bnb:这一笔折合 BNB 超过上限就不买(V3 自动买入用:新发射台价格未知,先封顶)
if (maxBnb !== null) {
  let bnbCost = Number(ethers.formatEther(need));
  if (quote.toLowerCase() !== "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c") {
    const pb = await perBnb(baw, quote, swapSlip).catch(() => null);
    if (!(pb?.perBnb > 0)) die(`底池币 ${quote} 拿不到 BNB 报价,算不出花费,按 --max-bnb 的要求不买`);
    bnbCost /= pb.perBnb;
  }
  if (bnbCost > maxBnb) die(`买到目标数量约需 ${bnbCost.toFixed(4)} BNB,超过上限 ${maxBnb} BNB,不买(钱没动)`);
  log(`约 ${bnbCost.toFixed(4)} BNB,在上限 ${maxBnb} BNB 以内`);
}

let have = await balanceOf(quote, W);
if (have < input) {
  const deficit = input - have;
  if (quote.toLowerCase() === "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c") {
    // 底池是 WBNB:直接 WBNB.deposit() 1:1 包装,不走兑换
    log(`底池是 WBNB,包装 ${ethers.formatEther(deficit)} BNB → WBNB`);
    const p = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", quote, "--value", deficit.toString(), "--inputData", "0xd0e30db0"]);
    await run("包装 WBNB", p.success ? { success: true, requestId: p.data.requestId, risks: p.data.risks?.riskDetails || [], requireConfirmation: p.data.requireConfirmation } : p);
    have = await balanceOf(quote, W);
  }
}
if (have < input) {
  const deficit = input - have;
  { const lq = await checkLiquid(quote); if (!lq.ok) die(lq.msg + "(钱没动)"); }
  let pb;
  try { pb = await perBnb(baw, quote, swapSlip); } catch (e) { die(e.message); }
  // 走 USDT 中转是两次兑换,滑点按两次算
  const slipMul = pb.via === "usdt" ? (1 + Number(swapSlip) / 100) ** 2 : 1 + Number(swapSlip) / 100;
  const bnbAmt = (Number(ethers.formatEther(deficit)) / pb.perBnb * slipMul).toFixed(6);
  log(`底池币不够,用 ${bnbAmt} BNB 兑换(约 ${pb.perBnb.toFixed(4)} 个/BNB${pb.via === "usdt" ? ",Ondo 类底池币,经 USDT 中转" : ""},滑点 ${swapSlip}%)`);
  if (DRY) { log("--dry:不兑换"); process.exit(0); }
  let got;
  try { got = await bnbToToken({ baw, wallet: W, token: quote, bnbAmt, slip: swapSlip, balanceOf, log, sym: info.quoteSymbol ?? "底池币" }); }
  catch (e) { die(`兑换失败:${e.message}`); }
  for (let i = 0; i < 15; i++) { have = await balanceOf(quote, W); if (have >= input) break; await sleep(400); }
  log(`兑换到账 ${fmt(got, 4)},现在有 ${fmt(have, 4)}`);
  if (have < need) die(`底池币还是不够(有 ${fmt(have, 4)},需 ${fmt(need, 4)})`);
}
const spend = have < input ? have : input;
const spendStr = ethers.formatEther(spend);

let pv = await gang(["buy", "--token", ca, "--bnb", spendStr, "--slippage", slip]);
if (pv.step === "approve-quote") {
  log(`授权 ${fmt(spend, 4)} 底池币给 Gang(只授权这一次的数量)`);
  await run("授权", pv);
  pv = await gang(["buy", "--token", ca, "--bnb", spendStr, "--slippage", slip]);
}
if (pv.step !== "buy") die(`意外的步骤:${JSON.stringify(pv)}`);
log(`买入预计 ${pv.expectTokens} 个,花 ${pv.expectSpent},退回 ${pv.expectRefund},最少 ${pv.minTokensOut}`);
await run("买入", pv);
const after = await gang(["token", "--token", ca]);
log(`✓ 完成  持有 ${after.myBalance} 个,还能买 ${after.myRoomTokens} 个`);

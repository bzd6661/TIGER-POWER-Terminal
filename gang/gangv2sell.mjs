#!/usr/bin/env node
// Gang V2 内盘卖出:node gangv2sell.mjs <CA> <百分比1-100> [--slip 5] [--keep] [--swap-slip 5] [--acct 1|2|both] [--app-confirm] [--dry]
//   交易由官方 gang CLI 生成(gang sell → 可能先返回 approve 步骤 → 再 sell),经 baw preview 模拟和风控后执行。
//   V2 卖出拿回的是底池币(GANG / BNCB / WBNB …),默认再用外盘把拿回的底池币换成 BNB(--keep 则留着)。
//   钱包报风险提示时默认不执行;--accept-risk 打印风险原文后仍提交(钱包设成「需要确认」时还要去 App 点确认)。
import { ethers } from "ethers";
import { takeAcct, bawSpawn, runBoth, BAW2_ENTRY, BAW2_DIR } from "../accounts.mjs";
import { makeGang } from "./gangcore.mjs";
import { checkLiquid } from "../liq.mjs";
import { tokenToBnb, quoteDecimals } from "../quoteswap.mjs";

const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;   // 等回执时每 0.3 秒查一次(ethers 默认 4 秒)
const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function withdraw(uint256)"]);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const ACCT = takeAcct(args);
if (ACCT === "both") { runBoth(import.meta.url, args); await new Promise(() => {}); }
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry"), KEEP = flag("--keep"), ACCEPT_RISK = flag("--accept-risk");
// --app-confirm:钱包要求去 Binance App 批准的交易也提交,然后等你在 App 里确认(不加就直接停)
const APP_CONFIRM = flag("--app-confirm");
const slip = opt("--slip") ?? "5", swapSlip = opt("--swap-slip") ?? "5";
const [ca, pctRaw] = args;
if (!ca || !ethers.isAddress(ca) || !/^\d+(\.\d{1,2})?$/.test(pctRaw ?? "") || Number(pctRaw) <= 0 || Number(pctRaw) > 100)
  die("用法 node gangv2sell.mjs <CA> <百分比1-100> [--slip 5] [--keep] [--swap-slip 5] [--acct 1|2|both] [--accept-risk] [--dry]");

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

// 开了 --app-confirm 时,只有「中风险」提示(medium_*)放行到 App,由你在 App 里看着提示决定;高风险/钓鱼等照样拦
const mediumOnly = (list) => list.length > 0 && list.every((x) => /^medium_/.test(String(x?.code ?? "")));
// 执行一个 gang 生成的 preview;返回回执,dry 返回 "dry"
async function run(label, pv) {
  if (pv.success && pv.requireConfirmation && !APP_CONFIRM) die(`${label} 需要去 Binance App 批准,按你的设置不提交(钱包把这笔判成了有风险的交易;要去 App 确认就勾选「需要时去 App 确认」/ 加 --app-confirm)`);
  if (!pv.success) die(`${label} preview 失败:${JSON.stringify(pv.error ?? pv)}`);
  if (pv.risks?.length) {
    log(`⚠️ ${label} 钱包风险提示:${JSON.stringify(pv.risks)}`);
    if (APP_CONFIRM && pv.requireConfirmation && mediumOnly(pv.risks)) log(`${label} 是中风险提示,已开 App 确认 → 提交,去 App 里看提示再决定`);
    else if (!ACCEPT_RISK) die(`${label} 有风险提示,不执行(确认要卖就加 --accept-risk)`);
  }
  if (DRY) { log(`${label} preview 通过(--dry 不执行)`); return "dry"; }
  const ex = await baw(["contract-call", "execute", "--requestId", pv.requestId]);
  if (!ex.success) die(`${label} execute 失败:${JSON.stringify(ex.error ?? ex)}`);
  if (ex.data.status === "PENDING_CONFIRMATION") { log(`⏳ ${label} 已提交,请在 Binance App 里确认(orderId ${ex.data.orderId}),最多等 5 分钟…`); return { pending: true }; }
  if (!ex.data.txHash) die(`${label} 没拿到 txHash:${JSON.stringify(ex.data)}`);
  const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
  if (!rc) die(`${label} 60 秒没确认,别重复提交:${ex.data.txHash}`);
  if (rc.status !== 1) die(`${label} 链上失败:${ex.data.txHash}`);
  log(`${label} ✓ 上链 ${ex.data.txHash}`);
  return rc;
}

const info = await gang(["token", "--token", ca]);
if (!info.success) die(`查不到这个币:${JSON.stringify(info.error ?? info)}`);
// 刚毕业(面板那边还当成内盘)时不用报错让你重点:直接转到外盘卖出,同样的比例和账号
if (info.graduated) {
  log("这个币已经毕业了,改走外盘卖出(dexsell.mjs)");
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const ps = spawn(process.execPath, [fileURLToPath(new URL("../dexsell.mjs", import.meta.url)), ca, String(pctRaw), "--acct", ACCT, ...(DRY ? ["--dry"] : [])], { stdio: "inherit" });
  ps.on("close", (code) => process.exit(code ?? 1));
  await new Promise(() => {});
}
if (info.kind !== "v2") die(`这是 ${info.kind} 池,第一代用 gangv1sell.mjs`);
const W = info.buyer;   // gangcore 已经拿到地址(本机缓存)
if (!W) die("拿不到钱包地址");
const bal = BigInt(info.myBalanceRaw);
if (bal === 0n) die(`${W} 没有 ${info.symbol}`);
const amount = (bal * BigInt(Math.round(Number(pctRaw) * 100))) / 10000n;
const amountStr = ethers.formatEther(amount);
const quote = ethers.getAddress(info.quote);
const qDec = await quoteDecimals(quote);   // XAUt 是 6 位,其他底池币 18 位
log(`${info.symbol} ${ca}  卖 ${amountStr} 个(持仓 ${info.myBalance} 的 ${pctRaw}%),内盘滑点 ${slip}%,拿回底池币 ${quote}`);

const sellArgs = Number(pctRaw) === 100 ? ["sell", "--token", ca, "--all", "--slippage", slip] : ["sell", "--token", ca, "--amount", amountStr, "--slippage", slip];
let pv = await gang(sellArgs);
if (pv.step === "approve") {
  log(`先授权 ${pv.amount} 个给 Gang(只授权这次卖出的数量)`);
  if (DRY) { log("--dry:需要先授权,授权和卖出都不做(卖出要等授权上链后才能预览)"); process.exit(0); }
  const ap = await run("授权", pv);
  pv = await gang(sellArgs);
  for (let i = 0; ap?.pending && pv.step === "approve" && i < 60; i++) { await sleep(5000); pv = await gang(sellArgs); }
  if (pv.step === "approve") die("授权 5 分钟内没确认上链,卖出没做");
}
if (pv.step !== "sell" && pv.step !== undefined && !pv.requestId) die(`意外的步骤:${JSON.stringify(pv)}`);
const before = await balanceOf(quote, W);
const rc = await run("内盘卖出", pv);
if (rc === "dry" || KEEP) process.exit(0);

let got = 0n;
const waitN = rc?.pending ? 100 : 10;
for (let i = 0; i < waitN && got <= 0n; i++) { got = (await balanceOf(quote, W)) - before; if (got <= 0n) await sleep(rc?.pending ? 3000 : 400); }
if (got <= 0n) die("内盘卖出已上链,但没看到底池币到账,先查交易");
log(`拿回 ${ethers.formatUnits(got, qDec)} 底池币`);
if (quote.toLowerCase() === WBNB) {
  // 底池是 WBNB:直接 withdraw 换回 BNB
  const p = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", quote, "--value", "0", "--inputData", erc20.encodeFunctionData("withdraw", [got])]);
  await run("WBNB→BNB", p.success ? { success: true, requestId: p.data.requestId, risks: p.data.risks?.riskDetails || [], requireConfirmation: p.data.requireConfirmation } : p);
  log(`✓ 完成,到手 ${ethers.formatEther(got)} BNB`);
  process.exit(0);
}
{ const lq = await checkLiquid(quote); if (!lq.ok) { log(`⚠️ ${lq.msg}。卖出已完成,底池币留在钱包里(面板「底池币余额」可以之后再换)`); process.exit(0); } }
// Ondo 类底池币(FXIon 等)自动经 USDT 中转换回 BNB
let bnbBack;
try { bnbBack = await tokenToBnb({ baw, wallet: W, token: quote, amountWei: got, decimals: qDec, slip: swapSlip, balanceOf, log }); }
catch (e) { die(`底池币换 BNB 失败(卖出已完成,底池币 / USDT 留在钱包里,面板「底池币余额」可以之后再换):${e.message}`); }
log(`✓ 完成,底池币换回 ${ethers.formatEther(bnbBack)} BNB`);

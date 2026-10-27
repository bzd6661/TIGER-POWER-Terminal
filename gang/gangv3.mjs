#!/usr/bin/env node
// Gang V3 内盘买卖(合并发射台 GangLaunchpad,2026-10-27 主网上线):
//   node gangv3.mjs buy  <CA> [--tokens 数量 | --bnb 数量] [--max-bnb 0.2] [--slip 5] [--acct 1|2|both] [--dry]
//   node gangv3.mjs sell <CA> <百分比1-100> [--slip 5] [--keep] [--app-confirm] [--accept-risk] [--acct 1|2|both] [--dry]
//   地址来自官方仓库 gangfun/gang-launchpad(skill/gang-cli/src/gangpad.js):发射台 0x15CFD2dc…、GangRouter 0xE0404456…
//   曲线和 V2 一样(虚拟储备、1% 手续费、单钱包 1% 上限、只有持 Agent ID 的钱包能在内盘买卖);内盘不收税,买卖税只在毕业后的外盘收。
//   买:底池是 WBNB 的走 Router.v3BuyBNB(直接付 BNB,一笔搞定;超过上限 / 毕业截断的部分以 WBNB 退回钱包);
//       其他底池币先用 BNB 换够(quoteswap,Ondo 类经 USDT),再授权 + 发射台 buy。不指定数量就买到单钱包上限(总量 1%)。
//   卖:先授权这次卖出的数量,发射台 sell 拿回底池币,默认再换回 BNB(WBNB 直接 withdraw;--keep 留着)。
//   已毕业的币自动转到外盘(dexbuy / dexsell)。每笔都先 eth_call 模拟,再经 baw preview(模拟 + 风控),有风险默认不提交。
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { takeAcct, bawSpawn, runBoth } from "../accounts.mjs";
import { checkLiquid } from "../liq.mjs";
import { perBnb, bnbToToken, tokenToBnb } from "../quoteswap.mjs";

export const V3_PAD = "0x15CFD2dc8278Fb87a1783ef42111618E20874365";
export const V3_ROUTER = "0xE040445690Aa56C8b68B7f7038C7b2562B5079C4";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const VIRTUAL_TOKEN = 1_066_666_666_666_666_666_666_666_667n;
const PAD = new ethers.Interface([
  "function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)",
  "function kindOf(address token) view returns (uint8)",
  "function isAgent(address account) view returns (bool)",
  "function walletRoom(address token, address buyer) view returns (uint256)",
  "function buy(address token, uint256 quoteIn, uint256 minTokensOut) returns (uint256)",
  "function sell(address token, uint256 tokensIn, uint256 minQuoteOut) returns (uint256)",
  "error UnknownToken()", "error AlreadyGraduated()", "error ZeroAmount()", "error Slippage()", "error NotAgent()", "error WalletCapReached()",
]);
const ROUTER = new ethers.Interface([
  "function v3BuyBNB(address token, uint256 minTokensOut, uint256 deadline) payable returns (uint256)",
  "error Expired()", "error UnknownToken()", "error NotWbnbQuote()", "error NotEnoughValue()", "error TooLittleReceived(uint256 received, uint256 minimum)",
]);
const E = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256)", "function symbol() view returns (string)", "function withdraw(uint256)"]);
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const ACCT = takeAcct(args);
if (ACCT === "both") { runBoth(import.meta.url, args); await new Promise(() => {}); }
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry"), KEEP = flag("--keep"), APP_CONFIRM = flag("--app-confirm"), ACCEPT_RISK = flag("--accept-risk");
const slip = Number(opt("--slip") ?? "5"), swapSlip = opt("--swap-slip") ?? "3";
const wantTokens = opt("--tokens"), wantBnb = opt("--bnb"), maxBnbRaw = opt("--max-bnb");
const maxBnb = maxBnbRaw === null ? null : Number(maxBnbRaw);
const [side, ca, pctRaw] = args;
const USAGE = "用法 node gangv3.mjs buy <CA> [--tokens 数量 | --bnb 数量] [--max-bnb X] [--slip 5] | sell <CA> <百分比1-100> [--slip 5] [--keep] [--acct 1|2|both] [--dry]";
if (!["buy", "sell"].includes(side) || !ethers.isAddress(ca ?? "") || !(slip > 0 && slip <= 50)) die(USAGE);
if (side === "sell" && !(/^\d+(\.\d{1,2})?$/.test(pctRaw ?? "") && Number(pctRaw) > 0 && Number(pctRaw) <= 100)) die(USAGE);
if (maxBnb !== null && !(maxBnb > 0)) die("--max-bnb 要是正数");

function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(ACCT, [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}
const call = async (to, iface, fn, a = [], extra = {}) => iface.decodeFunctionResult(fn, await provider.call({ to, data: iface.encodeFunctionData(fn, a), ...extra }));
const balanceOf = async (token, who) => (await call(token, E, "balanceOf", [who]))[0];
const minOf = (x) => (x * BigInt(Math.round((100 - slip) * 100))) / 10000n;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 1800);
function why(e) {
  const data = e?.data ?? e?.info?.error?.data;
  for (const I of [PAD, ROUTER]) {
    try {
      const d = I.parseError(data);
      const m = { NotAgent: "这个钱包没有 Agent ID,V3 内盘买卖不了", WalletCapReached: "已经买到单钱包上限(总量 1%)", AlreadyGraduated: "已经毕业了", Slippage: "价格变动超过滑点",
        TooLittleReceived: "到手少于最少数量(价格变动超过滑点)", UnknownToken: "不是 V3 发射台上的币", NotEnoughValue: "BNB 不够", Expired: "交易过期了" }[d?.name];
      if (m) return m;
      if (d) return d.name;
    } catch {}
  }
  return e?.shortMessage ?? e?.message ?? String(e);
}

let W = null;
try { W = readFileSync(new URL(ACCT === "2" ? "../.wallet2" : "../.wallet", import.meta.url), "utf8").trim(); } catch {}
if (!/^0x[0-9a-fA-F]{40}$/.test(W ?? "")) W = (await baw(["wallet", "address"]))?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
if (!W) die("拿不到钱包地址");

const c = await call(V3_PAD, PAD, "curves", [ca]);
if (c.creator === ethers.ZeroAddress) die("不是 Gang V3 发射台上的币(打新币或别的平台的币不在这里交易)");
const sym = await call(ca, E, "symbol").then((r) => r[0]).catch(() => "?");
const quote = ethers.getAddress(c.quote), isWbnb = quote.toLowerCase() === WBNB.toLowerCase();
const qSym = isWbnb ? "WBNB" : await call(quote, E, "symbol").then((r) => r[0]).catch(() => "底池币");

// 已毕业:转到外盘脚本(同样的账号、比例)
if (c.graduated) {
  let extra;
  if (side === "sell") extra = [ca, String(pctRaw)];
  else {
    const want = wantTokens ? Number(wantTokens) : 1e7;
    let bnb = wantBnb ? Number(wantBnb) : null;
    if (!bnb) {
      const q = await baw(["market-order", "quote", "--fromTokenQty", "0.01", "--fromToken", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "--toToken", ca, "--binanceChainId", "56", "--slippage", "10"]).catch(() => null);
      const per = q?.success ? Number(q.data.toCoinAmount) / 0.01 : null;
      if (!(per > 0)) die("已毕业,但外盘报不出价,先不买");
      bnb = Math.ceil((want / per) * 1.03 * 1e6) / 1e6;
    }
    if (maxBnb !== null && bnb > maxBnb) die(`已毕业,外盘买约需 ${bnb} BNB,超过上限 ${maxBnb} BNB,不买(钱没动)`);
    extra = [ca, String(bnb), "--mid", quote];
  }
  log(`${sym} 已经毕业(pair ${c.pair}),改走外盘(${side === "buy" ? "dexbuy" : "dexsell"}.mjs)`);
  const ps = spawn(process.execPath, [fileURLToPath(new URL(`../dex${side}.mjs`, import.meta.url)), ...extra, "--acct", ACCT, ...(DRY ? ["--dry"] : [])], { stdio: "inherit" });
  ps.on("close", (code) => process.exit(code ?? 1));
  await new Promise(() => {});
}

// 执行一笔:baw preview → 检查 → execute → 等上链。返回回执;要去 App 确认的返回 { pending: true };--dry 返回 null
const mediumOnly = (list) => list.length > 0 && list.every((x) => /^medium_/.test(String(x?.code ?? "")));
async function run(label, to, data, value = 0n, { allowApp = false } = {}) {
  const p = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", to, "--value", value.toString(), "--inputData", data]);
  if (!p.success) die(`${label} preview 失败:${JSON.stringify(p.error ?? p).slice(0, 300)}`);
  const risks = p.data.risks?.riskDetails || [];
  if (p.data.requireConfirmation && !(allowApp && APP_CONFIRM)) die(`${label} 要去 Binance App 批准(钱包判成了有风险的交易),按你的设置不提交${allowApp ? "(要提交就勾选「需要时去 App 确认」/ 加 --app-confirm)" : ""}`);
  if (risks.length) {
    log(`⚠️ ${label} 钱包风险提示:${JSON.stringify(risks)}`);
    if (!(allowApp && APP_CONFIRM && p.data.requireConfirmation && mediumOnly(risks)) && !ACCEPT_RISK) die(`${label} 有风险提示,不执行`);
  }
  if (DRY) { log(`${label} preview 通过(--dry 不执行)`); return null; }
  const ex = await baw(["contract-call", "execute", "--requestId", p.data.requestId]);
  if (!ex.success) die(`${label} execute 失败:${JSON.stringify(ex.error ?? ex).slice(0, 300)}`);
  if (ex.data.status === "PENDING_CONFIRMATION") { log(`⏳ ${label} 已提交,请在 Binance App 里确认(orderId ${ex.data.orderId}),最多等 5 分钟…`); return { pending: true }; }
  if (!ex.data.txHash) die(`${label} 没拿到 txHash(${ex.data.status}),去 Binance App 看一下,别重复提交`);
  log(`${label} 已提交 ${ex.data.txHash}`);
  const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
  if (!rc) die(`${label} 60 秒没确认,别重复提交:${ex.data.txHash}`);
  if (rc.status !== 1) die(`${label} 链上失败:${ex.data.txHash}`);
  log(`${label} ✓ 上链 区块 ${rc.blockNumber}`);
  return rc;
}

if (side === "buy") {
  const [agent, room] = await Promise.all([call(V3_PAD, PAD, "isAgent", [W]).then((r) => r[0]), call(V3_PAD, PAD, "walletRoom", [ca, W]).then((r) => r[0])]);
  if (!agent) die(`钱包 ${W} 没有 Agent ID,V3 内盘买不了(先在 Binance App 领 .ai ID)`);
  if (room === 0n) die("这个币你已经买到单钱包上限(总量 1%)了");
  // 要花多少底池币:--bnb 直接用;否则按曲线公式算买到目标数量的花费(恒积:x = 虚拟代币 − 已卖,y = 虚拟 + 真实底池币),再加 1% 手续费和 2% 余量
  let quoteIn;
  let target = wantTokens ? ethers.parseEther(wantTokens) : room;
  if (target > room) { log(`要买 ${ethers.formatEther(target)} 个,超过剩余额度,按剩余 ${ethers.formatEther(room)} 个买`); target = room; }
  if (wantBnb) quoteIn = ethers.parseEther(String(wantBnb));
  else {
    const x = VIRTUAL_TOKEN - c.sold, y = c.virtualQuote + c.realQuote;
    if (target >= x) die("曲线上剩的币不够");
    const net0 = (y * target) / (x - target);
    // 买到上限时多带 2%(超出上限的部分合约会退回);只买一部分时不多带,免得买多
    quoteIn = ((net0 * 10000n) / 9900n) * (target === room ? 102n : 100n) / 100n + 1n;
  }
  log(`${sym} ${ca}  底池 ${qSym}  ${wantBnb ? `花 ${ethers.formatEther(quoteIn)} ${qSym}` : `目标 ${ethers.formatEther(target)} 个,约需 ${Number(ethers.formatEther(quoteIn)).toFixed(6)} ${qSym}(含 1% 手续费${target === room ? " + 2% 余量,超出上限的退回" : ""})`}`);
  if (isWbnb) {
    if (maxBnb !== null && quoteIn > ethers.parseEther(String(maxBnb))) die(`约需 ${ethers.formatEther(quoteIn)} BNB,超过上限 ${maxBnb} BNB,不买(钱没动)`);
    let out;
    try { out = (await call(V3_ROUTER, ROUTER, "v3BuyBNB", [ca, 0n, deadline()], { from: W, value: quoteIn }))[0]; } catch (e) { die(`模拟失败:${why(e)}(钱没动)`); }
    const minOut = minOf(out);
    log(`经 GangRouter 直接付 BNB:预计 ${ethers.formatEther(out)} 个,最少 ${ethers.formatEther(minOut)}(滑点 ${slip}%);超过上限的部分以 WBNB 退回钱包`);
    const rc = await run("买入", V3_ROUTER, ROUTER.encodeFunctionData("v3BuyBNB", [ca, minOut, deadline()]), quoteIn);
    if (rc) log(`✓ 完成  现在持有 ${ethers.formatEther(await balanceOf(ca, W))} 个 ${sym}`);
    process.exit(0);
  }
  // 其他底池币:不够就用 BNB 换(多带 3%),再授权 + 发射台 buy
  if (maxBnb !== null) {
    const pb = await perBnb(baw, quote, swapSlip).catch(() => null);
    if (!(pb?.perBnb > 0)) die(`底池币 ${qSym} 拿不到 BNB 报价,算不出花费,按 --max-bnb 的要求不买`);
    const cost = Number(ethers.formatEther(quoteIn)) / pb.perBnb;
    if (cost > maxBnb) die(`约需 ${cost.toFixed(4)} BNB,超过上限 ${maxBnb} BNB,不买(钱没动)`);
  }
  let have = await balanceOf(quote, W);
  if (have < quoteIn) {
    const deficit = quoteIn - have;
    { const lq = await checkLiquid(quote); if (!lq.ok) die(lq.msg + "(钱没动)"); }
    let pb;
    try { pb = await perBnb(baw, quote, swapSlip); } catch (e) { die(e.message); }
    const slipMul = pb.via === "usdt" ? (1 + Number(swapSlip) / 100) ** 2 : 1 + Number(swapSlip) / 100;
    const bnbAmt = ((Number(ethers.formatEther(deficit)) / pb.perBnb) * slipMul * 1.03).toFixed(6);
    log(`${qSym} 不够,用 ${bnbAmt} BNB 兑换(约 ${pb.perBnb.toFixed(4)} 个/BNB${pb.via === "usdt" ? ",经 USDT 中转" : ""})`);
    if (DRY) { log("--dry:不兑换,也不买"); process.exit(0); }
    try { await bnbToToken({ baw, wallet: W, token: quote, bnbAmt, slip: swapSlip, balanceOf, log, sym: qSym }); } catch (e) { die(`兑换失败:${e.message}`); }
    for (let i = 0; i < 15; i++) { have = await balanceOf(quote, W); if (have >= quoteIn) break; await sleep(400); }
    if (have < quoteIn) { if (have * 100n < quoteIn * 97n) die(`${qSym} 还是不够(有 ${ethers.formatEther(have)},需 ${ethers.formatEther(quoteIn)})`); quoteIn = have; }
  }
  if ((await call(quote, E, "allowance", [W, V3_PAD]))[0] < quoteIn) {
    log(`授权 ${ethers.formatEther(quoteIn)} ${qSym} 给 V3 发射台(只授权这一次的数量)`);
    if (DRY) { log("--dry:需要先授权,授权和买入都不做"); process.exit(0); }
    await run("授权", quote, E.encodeFunctionData("approve", [V3_PAD, quoteIn]));
  }
  let out;
  try { out = (await call(V3_PAD, PAD, "buy", [ca, quoteIn, 0n], { from: W }))[0]; } catch (e) { die(`模拟失败:${why(e)}`); }
  const minOut = minOf(out);
  log(`预计 ${ethers.formatEther(out)} 个,最少 ${ethers.formatEther(minOut)}(滑点 ${slip}%)`);
  const rc = await run("买入", V3_PAD, PAD.encodeFunctionData("buy", [ca, quoteIn, minOut]));
  if (rc) log(`✓ 完成  现在持有 ${ethers.formatEther(await balanceOf(ca, W))} 个 ${sym}`);
} else {
  const bal = await balanceOf(ca, W);
  if (bal === 0n) die(`${W} 没有 ${sym}`);
  const amount = Number(pctRaw) >= 100 ? bal : (bal * BigInt(Math.round(Number(pctRaw) * 100))) / 10000n;
  log(`${sym} ${ca}  卖 ${ethers.formatEther(amount)} 个(${pctRaw}%),拿回 ${qSym}`);
  if ((await call(ca, E, "allowance", [W, V3_PAD]))[0] < amount) {
    log(`先授权 ${ethers.formatEther(amount)} 个给 V3 发射台(只授权这次卖出的数量)`);
    if (DRY) { log("--dry:需要先授权,授权和卖出都不做(卖出要等授权上链后才能模拟)"); process.exit(0); }
    const ap = await run("授权", ca, E.encodeFunctionData("approve", [V3_PAD, amount]), 0n, { allowApp: true });
    if (ap?.pending) for (let i = 0; i < 60 && (await call(ca, E, "allowance", [W, V3_PAD]))[0] < amount; i++) await sleep(5000);
    if ((await call(ca, E, "allowance", [W, V3_PAD]))[0] < amount) die("授权 5 分钟内没确认上链,卖出没做");
  }
  let out;
  try { out = (await call(V3_PAD, PAD, "sell", [ca, amount, 0n], { from: W }))[0]; } catch (e) { die(`模拟失败:${why(e)}`); }
  const minOut = minOf(out);
  log(`预计拿回 ${ethers.formatEther(out)} ${qSym}(已扣 1% 手续费,内盘不收税),最少 ${ethers.formatEther(minOut)}(滑点 ${slip}%)`);
  const before = await balanceOf(quote, W);
  const rc = await run("内盘卖出", V3_PAD, PAD.encodeFunctionData("sell", [ca, amount, minOut]), 0n, { allowApp: true });
  if (!rc || KEEP) process.exit(0);
  let got = 0n;
  for (let i = 0; i < (rc.pending ? 100 : 10) && got <= 0n; i++) { got = (await balanceOf(quote, W)) - before; if (got <= 0n) await sleep(rc.pending ? 3000 : 400); }
  if (got <= 0n) die("卖出已提交,但没看到底池币到账,先查交易");
  log(`拿回 ${ethers.formatEther(got)} ${qSym}`);
  if (isWbnb) {
    await run("WBNB→BNB", WBNB, E.encodeFunctionData("withdraw", [got]));
    log(`✓ 完成,到手 ${ethers.formatEther(got)} BNB`);
    process.exit(0);
  }
  { const lq = await checkLiquid(quote); if (!lq.ok) { log(`⚠️ ${lq.msg}。卖出已完成,${qSym} 留在钱包里(面板「底池币余额」可以之后再换)`); process.exit(0); } }
  try { const back = await tokenToBnb({ baw, wallet: W, token: quote, amountWei: got, slip: swapSlip, balanceOf, log, sym: qSym }); log(`✓ 完成,换回 ${ethers.formatEther(back)} BNB`); }
  catch (e) { die(`${qSym} 换 BNB 失败(卖出已完成,底池币留在钱包里):${e.message}`); }
}

#!/usr/bin/env node
// four.meme "Binance Agent ID Exclusive"(preset 1778027615735)买入,走 baw contract-call(和 fast.mjs 同一套)。
//
//   node fourbuy.mjs <CA> <数量> [--slip 30] [--swap-slip 5] [--quote] [--proof 0x..] [--dry] [--any-preset]
//   node fourbuy.mjs --watch <数量> [同上]      等 735 的第一个币出来就买
//   加 --sim:只做链上模拟、打印 calldata,不调 baw(FOURBUY_WALLET=0x.. 可以换模拟用的地址)
//
// 新模式(Agent ID)的币:门槛只有 735 白名单(four.meme 后台机器人 0x74d86638 逐个加地址),不需要 proof。
//   在白名单 → 直接调 Core.buyByBudget(proof=0x);
//   不在白名单 → 兜底试币安钱包兑换(baw market-order swap,1% 上限按钱包报价控制,--gas LOW|MEDIUM|HIGH)。
//   别的币加 --via-wallet 也走钱包兑换(预演用)。
//
// 数量默认按 BNB 算。底池(报价币)是 ERC20(比如 USDT、U)时和 flap 脚本一样:
//   默认先用 baw market-order 把这些 BNB 换成底池币(--swap-slip 默认 5%),按实际到账数授权给 Core,再用底池币买;
//   加 --quote 则数量 = 底池币,直接用钱包里已有的,不兑换。
//   --dry 不兑换不授权:只给兑换报价和预计能买到多少;如果钱包里底池币和授权都够,会再 preview 一次买入。
//
// 流程:Core.tokens 查预设和报价币 → 打印资格(白名单 / Agent ID)→ Tools.estimateBuyByBudget 用你的钱包地址模拟
//      → 超过单地址 1% 就改成 buy(恰好买到上限)→ baw preview(模拟 + 风险检查)→ execute。
//
// 下面三件事是按合约推断的,遇到新币先 --dry 跑一次确认:
//   1. 资格:白名单合约按 (预设, 地址) 记;也可能只看是否持有 SPACE ID Agent ID。脚本两样都打印,
//      真正能不能买以 estimate / preview 的结果为准。
//   2. proof:SDK 默认 '0x';如果这个模式要后端签的证明,estimate 会回滚,用 --proof 传进去。
//   3. 报价币:BNB 和 ERC20 底池都支持(ERC20 由 Core 用 transferFrom 拉走,所以授权对象是 Core)。
import { spawn } from "node:child_process";
import { bawSpawn } from "./accounts.mjs";
import { checkLiquid } from "./liq.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";

const PRESET = 1778027615735n;
const CORE = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
const TOOLS = "0x97da82f56fef1a0b974587a48135fa9da2a4e905";
const WHITELIST = "0x7b377ad70a20556f4778c4cd878a68a7e7efabbc";   // WhitelistManager(按预设管理)
const AGENT_ID = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";    // SPACE ID Agent ID(.ai)
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const TOKEN_CREATED = "0x7dae4dcd1b20eb0445e7cc1d02b3e2e7f32fa63081a0e764732c269f2b8f228f"; // Core TokenCreated,topic1 = presetId
const WALLET_CACHE = new URL("./.wallet", import.meta.url);

const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;   // 等回执时每 0.3 秒查一次(ethers 默认 4 秒)
// getLogs:dataseed 不支持,换能拉日志的节点
const logProvider = new ethers.JsonRpcProvider(process.env.BSC_LOG_RPC || process.env.BSC_RPC || "https://rpc-bsc.48.club", net, { staticNetwork: net });

const core = new ethers.Contract(CORE, [
  "function tokens(address) view returns (uint32 version,address creator,uint256 presetId,address token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address tokenModule,address customData,uint256 createBlock,bool exists,bool paused,bool antiSniperEnabled)",
  "function buy(address token,uint256 amount,uint256 maxPayAmount,uint256 options,bytes proof) payable",
  "function buyByBudget(address token,uint256 maxPayAmount,uint256 minAmountOut,uint256 options,bytes proof) payable",
], provider);
const tools = new ethers.Contract(TOOLS, [
  "function estimateBuy(address token,address trader,uint256 amount,uint256 options,bytes proof) view returns (uint256 curveQuote,uint256 totalFee,uint256 userPays,uint256 userReceives,uint256 tokenAmount,uint256 executionPrice)",
  "function estimateBuyByBudget(address token,address trader,uint256 maxPayAmount,uint256 options,bytes proof) view returns (uint256 curveQuote,uint256 totalFee,uint256 userPays,uint256 userReceives,uint256 tokenAmount,uint256 executionPrice)",
], provider);
const erc20 = (a) => new ethers.Contract(a, [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
], provider);
const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";   // baw 里原生 BNB 的写法

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (x) => BigInt(x).toString(16).padStart(64, "0");

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry"), ANY = flag("--any-preset"), WATCH = flag("--watch");
// --sim:只做链上模拟和拼交易,完全不调 baw(钱包地址用 FOURBUY_WALLET 或 .wallet 缓存)
const SIM = flag("--sim");
const USE_QUOTE = flag("--quote");
// --via-wallet:非新模式的币也走币安钱包兑换下单(预演用,比如拿普通 four 币测);新模式的币默认就走这条
const VIA = flag("--via-wallet");
const slip = Number(opt("--slip") ?? "30");
const swapSlip = opt("--swap-slip") ?? "5";
const GAS = (opt("--gas") ?? "MEDIUM").toUpperCase();   // 钱包下单的 gas 档:LOW / MEDIUM / HIGH
const proof = opt("--proof") ?? "0x";
const [first, second] = args;
const ca = WATCH ? null : first;
const amt = WATCH ? first : second;
if ((!WATCH && (!ca || !ethers.isAddress(ca))) || !amt || !/^\d+(\.\d{1,18})?$/.test(amt) || !(slip >= 0 && slip < 100) || !ethers.isHexString(proof))
  die("用法 node fourbuy.mjs <CA> <数量> [--slip 30] [--swap-slip 5] [--quote] [--proof 0x..] [--dry] [--any-preset]\n     node fourbuy.mjs --watch <数量> [同上]");
if (!(Number(swapSlip) > 0 && Number(swapSlip) < 50)) die("--swap-slip 要在 0~50 之间");
const keepBps = BigInt(Math.round((100 - slip) * 100));

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
// preview → 模拟 / 风险检查 → execute(和 fast.mjs 一样:任何风险项都不执行)
async function send(label, W, to, value, data) {
  if (SIM) { log(`${label}(--sim 不调 baw)to=${to} value=${value} wei
  calldata=${data}`); process.exit(0); }
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

/** 合约回滚原因:字符串直接给;自定义错误给选择器,再去 openchain 查名字 */
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

/** 打印资格:预设白名单开没开、你在不在白名单、有没有 Agent ID。只打印,不拦 —— 以模拟结果为准 */
async function eligibility(W) {
  const c = (to, data) => provider.call({ to, data }).catch(() => null);
  const [on, listed, agentBal, handle] = await Promise.all([
    c(WHITELIST, "0x1d9cddf8" + pad(PRESET)),                // 预设白名单开关
    c(WHITELIST, "0x371befa6" + pad(PRESET) + pad(W)),       // (预设, 地址) 是否在白名单
    c(AGENT_ID, "0x70a08231" + pad(W)),                      // balanceOf
    c(AGENT_ID, ethers.id("handleOf(address)").slice(0, 10) + pad(W)),
  ]);
  let name = null;
  try { if (handle && handle.length > 130) name = ethers.AbiCoder.defaultAbiCoder().decode(["string"], handle)[0] || null; } catch {}
  const b = (x) => (x == null ? "读不到" : BigInt(x) ? "是" : "否");
  log(`资格:预设白名单开启=${b(on)} · 你在白名单=${b(listed)} · 持有 Agent ID=${agentBal == null ? "读不到" : BigInt(agentBal).toString() + " 个"}${name ? "(" + name + ".ai)" : ""}`);
  return { listed: listed != null && BigInt(listed) !== 0n };
}

const mined = async (h, label) => {
  const rc = await provider.waitForTransaction(h, 1, 60_000).catch(() => null);
  if (!rc) die(`${label} 60 秒没确认,别重复提交:${h}`);
  if (rc.status !== 1) die(`${label} 链上失败:${h}`);
};

/** BNB → 底池币(baw market-order),返回实际到账数量 */
async function swapToQuote(W, quote, sym) {
  { const lq = await checkLiquid(quote, sym); if (!lq.ok) die(lq.msg + "(钱没动)"); }
  const c = erc20(quote);
  const before = await c.balanceOf(W);
  const sw = await baw(["market-order", "swap", "--fromTokenQty", amt, "--fromToken", BNB, "--toToken", quote, "--binanceChainId", "56", "--slippage", swapSlip]);
  if (!sw.success) {
    // 30003001 Non-Tradable Token:Agentic Wallet 的"可交易代币"设置没放开这个币(会直接被拦,钱不动)
    if (sw.error?.code === 30003001) die(`兑换被钱包拦了:${sym} 不在 Agentic Wallet 的可交易代币设置里,钱没动。\n  → 币安 App → Agentic Wallet 页面,把 ${sym}(${quote})加进可交易代币后重跑;或者钱包里已有 ${sym} 就加 --quote 直接用`);
    die(`兑换失败:${JSON.stringify(sw.error ?? sw)}`);
  }
  let o;
  for (let i = 0; i < 60; i++) {
    o = (await baw(["market-order", "list", "--orderId", sw.data.orderId]))?.data?.list?.[0];
    if (o?.status === "FINISHED" || o?.status === "FAILED") break;
    await sleep(400);   // 兑换订单状态 0.4 秒查一次
  }
  if (o?.status !== "FINISHED") die(`兑换没成交(${o?.status}),orderId ${sw.data.orderId},别重复提交`);
  let after = before;
  for (let i = 0; i < 15 && after <= before; i++) { after = await c.balanceOf(W); if (after <= before) await sleep(400); }
  if (after <= before) die(`兑换完成但余额没变,查 orderId ${sw.data.orderId}`);
  log(`兑换到账 ${ethers.formatUnits(after - before, await c.decimals())} ${sym}`);
  return after - before;
}

/**
 * 走币安钱包自己的兑换下单(baw market-order swap BNB → 代币)。
 * Agent ID 模式直接调 Core 要白名单 + 后端 proof,自己拼不出来;
 * 币安的兑换能给普通 four.meme 内盘币报价(和链上模拟一致),
 * 未开放的币会报 "No liquidity" —— 推断开放后由币安后台处理白名单和 proof,所以新模式默认走这条。
 * 1% 上限:先按金额报价,超了就按比例缩小 BNB 再报一次。
 */
async function buyViaWallet(W, token, t) {
  if (SIM) die("--sim 不调 baw,走钱包兑换没法模拟;用 --dry(只报价不下单)");
  const quoteFor = async (bnb) => {
    const r = await baw(["market-order", "quote", "--fromTokenQty", bnb, "--fromToken", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "--toToken", token, "--binanceChainId", "56", "--slippage", String(slip)]);
    if (!r.success) die(`钱包报价失败:${JSON.stringify(r.error ?? r)}${/liquidity/i.test(r?.error?.message ?? "") ? "\n  → 币安还不能给这个币下单(没对外开放 / 你不在白名单),这个盘子买不了" : ""}`);
    return ethers.parseUnits(String(r.data.toCoinAmount), 18);
  };
  const held = await erc20(token).balanceOf(W).catch(() => 0n);
  const cap = t.maxSupply / 100n - held;
  if (cap <= 0n) die(`已经持有 ${ethers.formatEther(held)},到 1% 上限了`);

  let bnb = amt;
  let got = await quoteFor(bnb);
  log(`钱包报价:${bnb} BNB ≈ ${ethers.formatEther(got)} 个`);
  for (let i = 0; i < 2 && got > cap; i++) {
    // 曲线越买越贵,按比例缩小会略少于 1%,再留 3% 余量
    const scaled = (ethers.parseEther(bnb) * cap * 97n) / (got * 100n);
    bnb = ethers.formatEther((scaled / 10n ** 12n) * 10n ** 12n);   // 截到 6 位小数,钱包下单不一定接受 18 位
    got = await quoteFor(bnb);
    log(`超过单地址 1% 上限,改成 ${bnb} BNB ≈ ${ethers.formatEther(got)} 个`);
  }
  if (got > cap) die(`缩了两次还是超过 1% 上限(${ethers.formatEther(got)} > ${ethers.formatEther(cap)}),不买`);
  if (DRY) { log(`--dry:钱包能下单,会用 ${bnb} BNB 买约 ${ethers.formatEther(got)} 个(滑点 ${slip}%),不执行`); process.exit(0); }

  const before = held;
  const sw = await baw(["market-order", "swap", "--fromTokenQty", bnb, "--fromToken", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "--toToken", token, "--binanceChainId", "56", "--slippage", String(slip), "--gasLevel", GAS]);
  if (!sw.success) {
    if (sw.error?.code === 30003001) die(`下单被钱包拦了:这个币不在 Agentic Wallet 的可交易代币设置里,钱没动。\n  → 币安 App → Agentic Wallet 页面放开可交易代币(新币来不及一个个加,建议设成允许全部)`);
    die(`钱包下单失败:${JSON.stringify(sw.error ?? sw)}`);
  }
  let o;
  for (let i = 0; i < 60; i++) {
    o = (await baw(["market-order", "list", "--orderId", sw.data.orderId]))?.data?.list?.[0];
    if (o?.status === "FINISHED" || o?.status === "FAILED") break;
    await sleep(400);   // 兑换订单状态 0.4 秒查一次
  }
  if (o?.status !== "FINISHED") die(`钱包订单没成交(${o?.status}),orderId ${sw.data.orderId},别重复提交`);
  let after = before;
  for (let i = 0; i < 15 && after <= before; i++) { after = await erc20(token).balanceOf(W); if (after <= before) await sleep(400); }
  log(`✓ 钱包下单成交 orderId ${sw.data.orderId} · 现在持有 ${ethers.formatEther(after)}`);
  process.exit(0);
}

async function buyOne(W, token) {
  const t = await core.tokens(token).catch(() => null);
  if (!t || !t.exists) die(`${token} 不是 OpenFour 的币(Core.tokens 查不到)`);
  const quote = t.quoteAsset;
  const isBnb = quote.toLowerCase() === WBNB;
  const q = erc20(quote);
  const [sym, dec] = isBnb ? ["BNB", 18n] : await Promise.all([q.symbol().catch(() => "?"), q.decimals().then(BigInt).catch(() => 18n)]);
  const fmtQ = (x) => `${ethers.formatUnits(x, dec)} ${sym}`;
  log(`${t.symbol} preset ${t.presetId} 底池 ${sym}${isBnb ? "" : " " + quote} 总量 ${ethers.formatEther(t.maxSupply)}${t.paused ? " ⚠️已暂停" : ""}`);
  if (t.presetId !== PRESET && !ANY) die(`这个币不是 Agent ID 模式(preset ${t.presetId});测试别的币加 --any-preset`);
  // 新模式的门槛只有白名单(白名单里的地址用普通 buyByBudget、proof=0x 就能买;
  // 发币者自己不能在内盘买;不在白名单的地址 Tools 报价为 0、buyByBudget 回滚 CoreErrBudgetNotExecutable)。
  // 在白名单 → 直接调 Core(快、已验证);不在 → 试一下币安钱包兑换兜底,多半也买不了
  if (t.presetId === PRESET) {
    const { listed } = await eligibility(W);
    if (!listed && !VIA) { log("你的地址不在 735 白名单里,直接调合约买不了;试一下币安钱包兑换"); return buyViaWallet(W, token, t); }
  }
  if (VIA) return buyViaWallet(W, token, t);

  // 1. 定下要花多少底池币(pay)。BNB 池直接是数量;ERC20 池按 flap 脚本的规则
  let pay, needSwap = false;
  if (isBnb) {
    if (USE_QUOTE) die("这是 BNB 底池,不需要 --quote");
    pay = ethers.parseEther(amt);
  } else if (USE_QUOTE) {
    pay = ethers.parseUnits(amt, dec);
    const bal = await q.balanceOf(W);
    if (bal < pay && !SIM) die(`钱包里只有 ${fmtQ(bal)},不够 ${fmtQ(pay)}`);
  } else if (SIM) {
    die("--sim 不调 baw,拿不到兑换报价;测 ERC20 底池请加 --quote,数量按底池币算");
  } else if (DRY) {
    const qt = await baw(["market-order", "quote", "--fromTokenQty", amt, "--fromToken", BNB, "--toToken", quote, "--binanceChainId", "56", "--slippage", swapSlip]);
    if (!qt.success) die(`兑换报价失败:${JSON.stringify(qt.error ?? qt)}`);
    const est = ethers.parseUnits(String(qt.data.toCoinAmount), dec);
    pay = est - (est * BigInt(Math.round(Number(swapSlip) * 100))) / 10000n;   // 按最差成交算
    log(`兑换报价 ${amt} BNB ≈ ${qt.data.toCoinAmount} ${sym},按滑点 ${swapSlip}% 最少 ${fmtQ(pay)}`);
    needSwap = true;
  } else {
    // 兑换前先用一点点底池币模拟一次:资格 / proof 不过就停,免得 BNB 白换成底池币
    try { await tools.estimateBuyByBudget.staticCall(token, W, 10n ** (dec > 2n ? dec - 2n : 0n), 0, proof, { from: W }); }
    catch (e) { die(`兑换前预检被拒(没换币):${await why(e)}\n  → 资格不够或需要 proof`); }
    pay = await swapToQuote(W, quote, sym);
  }

  // 2. 按这笔底池币模拟(trader = 你的钱包)
  let est;
  try { est = await tools.estimateBuyByBudget.staticCall(token, W, pay, 0, proof, { from: W }); }
  catch (e) { die(`模拟买入被拒:${await why(e)}\n  → 资格不够或需要 proof(用 --proof 传后端给的证明)`); }
  if (est.tokenAmount === 0n) {
    // Agent ID 模式下不在白名单 / 是发币者本人 → Tools 报价为 0(不报错),不能当成"已毕业"
    if (t.presetId === PRESET) die("新模式报价为 0:你在白名单里但这个币不让你买(比如你是发币者本人),或者曲线已结束");
    die("模拟能买到 0 个:曲线已结束(已毕业)或已暂停");
  }
  log(`模拟:付 ${fmtQ(est.userPays)}(手续费 ${fmtQ(est.totalFee)})得 ${ethers.formatEther(est.tokenAmount)} 个`);

  // 3. 单地址 1% 上限:超了就改成恰好买到上限
  const held = await erc20(token).balanceOf(W).catch(() => 0n);
  const cap = t.maxSupply / 100n - held;
  if (cap <= 0n) die(`已经持有 ${ethers.formatEther(held)},到 1% 上限了`);
  let data, spend;
  if (est.tokenAmount > cap) {
    let e2;
    try { e2 = await tools.estimateBuy.staticCall(token, W, cap, 0, proof, { from: W }); }
    catch (e) { die(`按上限 ${ethers.formatEther(cap)} 个模拟失败:${await why(e)}`); }
    let maxPay = (e2.userPays * (10000n + BigInt(Math.round(slip * 100)))) / 10000n;
    // 不能超过给定金额:ERC20 手里就这么多;BNB 也不能超(按"1% + 滑点"算出的上限可能比预算多)
    if (maxPay > pay) maxPay = pay;
    log(`超过单地址 1% 上限,改成买 ${ethers.formatEther(cap)} 个,最多付 ${fmtQ(maxPay)}${isBnb ? "" : "(多出的底池币留在钱包)"}`);
    data = core.interface.encodeFunctionData("buy", [token, cap, maxPay, 0, proof]);
    spend = maxPay;
  } else {
    const minOut = (est.tokenAmount * keepBps) / 10000n;
    data = core.interface.encodeFunctionData("buyByBudget", [token, pay, minOut, 0, proof]);
    spend = pay;
    log(`buyByBudget 预算 ${fmtQ(pay)},最少到手 ${ethers.formatEther(minOut)} 个(滑点 ${slip}%)`);
  }

  // 4. ERC20 底池:授权 Core(不够才授权,和 flap 脚本一样按本次金额授权)
  if (!isBnb) {
    const allow = await q.allowance(W, CORE);
    if (allow < spend) {
      const approveData = q.interface.encodeFunctionData("approve", [CORE, spend]);
      if (SIM) log(`授权(--sim 不调 baw)${sym} → Core ${fmtQ(spend)} calldata=${approveData}`);
      else if (DRY || needSwap) { log(`--dry:需要先${needSwap ? "兑换、再" : ""}授权 ${fmtQ(spend)} 给 Core,买入的 preview 跳过`); process.exit(0); }
      else await mined(await send("授权", W, quote, 0n, approveData), "授权");
    } else if (needSwap) { log("--dry:还没兑换,钱包里底池币不够,买入的 preview 跳过"); process.exit(0); }
  }

  const h = await send("买入", W, CORE, isBnb ? spend : 0n, data);
  await mined(h, "买入");
  log(`✓ 成交 https://bscscan.com/tx/${h} · 现在持有 ${ethers.formatEther(await erc20(token).balanceOf(W))}`);
}

/** 盯 Core 的 TokenCreated(presetId = 735),第一个币出来就买。每秒拉一次日志 */
async function watchFirst() {
  let from = await logProvider.getBlockNumber();
  log(`盯 preset ${PRESET} 的新币,从块 ${from} 开始(Ctrl+C 退出)`);
  for (;;) {
    const head = await logProvider.getBlockNumber().catch(() => from);
    if (head >= from) {
      const logs = await logProvider.getLogs({ address: CORE, topics: [TOKEN_CREATED, "0x" + pad(PRESET)], fromBlock: from, toBlock: head }).catch((e) => { log(`getLogs 出错:${e.shortMessage || e.message}`); return null; });
      if (logs) {
        if (logs.length) {
          const token = ethers.getAddress("0x" + logs[0].topics[3].slice(26));
          log(`🆕 第一个币 ${token} 块 ${logs[0].blockNumber} tx ${logs[0].transactionHash}`);
          return token;
        }
        from = head + 1;
      }
    }
    await sleep(1000);
  }
}

const W = await wallet();
log(`钱包 ${W}${DRY ? "(--dry:只 preview 不执行)" : ""}`);
await buyOne(W, WATCH ? await watchFirst() : ethers.getAddress(ca));

// 下单前估算:预计获得 / 最少获得(按滑点)/ 手续费。只读,不下单。
//   four 内盘:Tools.estimateBuyByBudget / estimateSell(合约精确报价,含手续费,用你的钱包地址算,会体现 1% 上限)
//   Gang V1 内盘:发射台 quoteBuy / quoteSell
//   Gang V2 内盘:按现价估(曲线越买越贵,实际略差),平台费 1%
//   外盘:币安钱包 market-order quote
//   ID Agent 内盘:不估(以成交为准)
import { ethers } from "ethers";
import { provider } from "./detect.mjs";
import { bawJson } from "./session.mjs";
import { FLAP_PORTAL } from "./flapnft.mjs";

const FOUR_TOOLS = "0x97DA82f56FEF1A0B974587a48135fa9dA2A4E905";
const GANG_V1 = "0x315Ba2e8952D06094CC636b2B84229FA32fb23A7";
const PROBE = "0x000000000000000000000000000000000000dEaD";
const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const iface = new ethers.Interface([
  "function estimateBuyByBudget(address token,address trader,uint256 maxPayAmount,uint256 options,bytes proof) view returns (uint256 curveQuote,uint256 totalFee,uint256 userPays,uint256 userReceives,uint256 tokenAmount,uint256 executionPrice)",
  "function estimateSell(address,address,uint256,uint256,bytes) view returns (tuple(uint256 curveQuote,uint256 totalFee,uint256 userPays,uint256 userReceives,uint256 tokenAmount,uint256 executionPrice))",
  "function quoteBuy(address,address,uint256) view returns (uint256 tokensOut,uint256 bnbIn,uint256 fee)",
  "function quoteSell(address,uint256) view returns (uint256 bnbOut,uint256 fee)",
  "function balanceOf(address) view returns (uint256)",
]);
const call = (to, fn, a) => provider.call({ to, data: iface.encodeFunctionData(fn, a) }).then((r) => iface.decodeFunctionResult(fn, r));
const fmt = (x) => Number(ethers.formatEther(x));
const nf = (x) => (x >= 1000 ? Math.round(x).toLocaleString("en-US") : Number(x.toPrecision(4)).toString());
// 按比例买的参数 → 占总量的百分比:1pct = 1,half = 0.5,p0.3 = 0.3;不是按比例就返回 null
const pctArg = (a) => (a === "1pct" ? 1 : a === "half" ? 0.5 : /^p\d/.test(String(a)) ? Number(String(a).slice(1)) : null);
const pctOf = (bal, pct) => (bal * BigInt(pct)) / 100n;

// d = detect() 的结果;acct = "1" | "2"(两个号时按第一个号估);arg = "1pct" | "half" | BNB 数量 | 卖出百分比
export async function quote(d, { action, acct, arg, slip }) {
  const W = d.wallets[acct] ?? Object.values(d.wallets)[0] ?? PROBE;
  const unit = d.quote && d.quote.length < 10 ? d.quote : "底池币";
  const keep = (x) => x * (1 - slip / 100);
  const sym = d.symbol;
  const out = (get, getUnit, fee, feeUnit, note) => ({ get, getUnit, min: get == null ? null : keep(get), fee, feeUnit, note });
  const inner = d.stage === "inner";
  const bal = action === "sell" ? await call(d.ca, "balanceOf", [W]).then((r) => r[0]).catch(() => 0n) : 0n;
  if (action === "sell" && bal === 0n) return { note: "这个号没有持仓" };

  if (inner && d.platform === "four") {
    if (action === "buy") {
      const pay = pctArg(arg) !== null ? (d.cost1pct ?? 0) * pctArg(arg) * 1.05 : Number(arg);
      if (!(pay > 0)) return { note: "报不出价" };
      const e = await call(FOUR_TOOLS, "estimateBuyByBudget", [d.ca, W, ethers.parseEther(pay.toFixed(12)), 0, "0x"]).catch(() => null);
      if (!e) return { note: "合约报价失败(可能没资格或已买满)" };
      return out(fmt(e.tokenAmount), sym, fmt(e.totalFee), unit, `实付约 ${nf(fmt(e.userPays))} ${unit}(单号上限 1%,多的退回)`);
    }
    const e = await call(FOUR_TOOLS, "estimateSell", [d.ca, W, pctOf(bal, arg), 0, "0x"]).then((r) => r[0]).catch(() => null);
    if (!e) return { note: "合约报价失败" };
    return out(fmt(e.userReceives), unit, fmt(e.totalFee), unit);
  }
  if (inner && d.platform === "gangv1") {
    if (action === "buy") {
      const q = await call(GANG_V1, "quoteBuy", [d.ca, W, ethers.parseEther("10")]).catch(() => null);
      if (!q || q.tokensOut === 0n) return { note: "这个号已经买满或报价失败" };
      const k = pctArg(arg) ?? 1;
      return out(fmt(q.tokensOut) * k, sym, fmt(q.fee) * k, "BNB", `花费约 ${nf(fmt(q.bnbIn + q.fee) * k)} BNB`);
    }
    const q = await call(GANG_V1, "quoteSell", [d.ca, pctOf(bal, arg)]).catch(() => null);
    if (!q) return { note: "报价失败" };
    return out(fmt(q.bnbOut), "BNB", fmt(q.fee), "BNB");
  }
  // Flap Portal 盘(门槛盘):Portal 自己的 quoteExactInput(按这个钱包报价,门槛和 2% 额度都算进去)
  if (inner && d.platform === "flapportal") {
    const PI = new ethers.Interface(["function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount)) returns (uint256)"]);
    const q = (a) => provider.call({ from: W, to: FLAP_PORTAL, data: PI.encodeFunctionData("quoteExactInput", [a]) }).then((r) => PI.decodeFunctionResult("quoteExactInput", r)[0]).catch(() => null);
    if (d.nftGate && d.nftGate.wallets?.[acct] === 0) return { note: "这个号没有门槛要求的 NFT,买卖会被跳过" };
    if (action === "buy") {
      const bnb = pctArg(arg) !== null ? (d.cost1pctBnb ?? 0) * pctArg(arg) * 1.05 : Number(arg);
      if (!(bnb > 0)) return { note: "报不出价" };
      const got = await q([ethers.ZeroAddress, d.ca, ethers.parseEther(bnb.toFixed(12))]);
      if (got === null || got === 0n) return { note: "报价失败(可能 2% 额度用完)" };
      return out(fmt(got), sym, null, null, `花费约 ${nf(bnb)} BNB(超过 2% 额度的部分退回)`);
    }
    const got = await q([d.ca, ethers.ZeroAddress, pctOf(bal, arg)]);
    if (got === null) return { note: "报价失败" };
    return out(fmt(got), "BNB", null, null);
  }
  if (inner && (d.platform === "gangv2" || d.platform === "gangv3")) {
    const p = d.priceQuote;
    if (!(p > 0)) return { note: "读不到现价" };
    if (action === "buy") {
      const tokens = (pctArg(arg) ?? 1) * 1e7;
      return out(tokens, sym, tokens * p * 0.01, unit, `花费约 ${nf(tokens * p * 1.01)} ${unit}(按现价,实际略高)`);
    }
    const v = fmt(pctOf(bal, arg)) * p;
    return out(v * 0.99, unit, v * 0.01, unit, "按现价估,实际略低");
  }
  if (!inner || d.platform === "dex") {
    const [from, to, qty] = action === "buy"
      ? [BNB, d.ca, arg]
      : [d.ca, BNB, ethers.formatEther(pctOf(bal, arg))];
    const q = await bawJson(acct in d.wallets ? acct : "1", ["market-order", "quote", "--fromTokenQty", qty, "--fromToken", from, "--toToken", to, "--binanceChainId", "56", "--slippage", String(slip)], 20_000);
    if (!q.success) return { note: "币安钱包报价失败:" + (q.error?.message ?? "").slice(0, 80) };
    const get = Number(q.data.toCoinAmount);
    const min = Number(q.data.minReceiveAmount ?? q.data.minToCoinAmount ?? NaN);
    const r = out(get, q.data.toCoinSymbol ?? (action === "buy" ? sym : "BNB"), null, null, "币安钱包兑换报价");
    if (isFinite(min)) r.min = min;
    return r;
  }
  return { note: "这个平台不预估,以成交为准" };
}

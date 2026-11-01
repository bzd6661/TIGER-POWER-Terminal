// PancakeSwap V3 直接兑换:币安钱包的兑换(market-order)走不通时的后备,比如 Ondo 股票代币(FXIon 等)在美股休市时
//   币安会报 "no available liquidity. Please trade during stock market opening hours",但链上 Pancake V3 池子一直能换。
//   只报价 / 拼 calldata,真正提交由调用方走 baw contract-call(preview + 风控)。BNB 付进去时 Router 自己包成 WBNB。
import { ethers } from "ethers";

export const V3_SWAP_ROUTER = "0x1b81D678ffb9C0263b24A97847620C99d213eB14";
const QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const FEES = [100, 500, 2500, 10000];
const Q = new ethers.Interface([
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160,uint32,uint256)",
]);
export const V3R = new ethers.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);

// 币安那边是「休市 / 没有流动性」这类错,才值得改走 Pancake
export const MARKET_CLOSED = /no available liquidity|stock market opening hours|316008/i;

// 要买到 amountOut 个 token,用 BNB 最少要付多少:各手续费档的池子都问一遍,取最便宜的。没有池子返回 null
export async function bnbForExactOut(provider, token, amountOut) {
  let best = null;
  for (const fee of FEES) {
    try {
      const r = Q.decodeFunctionResult("quoteExactOutputSingle", await provider.call({ to: QUOTER, data: Q.encodeFunctionData("quoteExactOutputSingle", [[WBNB, token, amountOut, fee, 0n]]) }));
      if (!best || r[0] < best.bnbIn) best = { fee, bnbIn: r[0] };
    } catch { /* 这一档没池子或深度不够 */ }
  }
  return best;
}

// 付 BNB(value = amountIn)换 token,至少拿到 minOut,到账 recipient
export const buyWithBnbCalldata = ({ token, fee, recipient, amountIn, minOut }) =>
  V3R.encodeFunctionData("exactInputSingle", [[WBNB, token, fee, recipient, BigInt(Math.floor(Date.now() / 1000) + 1800), amountIn, minOut, 0n]]);

// ---- 卖:代币 → WBNB(Pancake V3)→ BNB。自己走 baw contract-call:preview 有风险提示或要去 App 批准就不提交,直接报错 ----
const QI = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
]);
const T = new ethers.Interface(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256)", "function balanceOf(address) view returns (uint256)", "function withdraw(uint256)"]);

// amountIn 个 token 能换多少 WBNB:各档池子取最多的。没有池子返回 null
export async function bnbForExactIn(provider, token, amountIn) {
  let best = null;
  for (const fee of FEES) {
    try {
      const r = QI.decodeFunctionResult("quoteExactInputSingle", await provider.call({ to: QUOTER, data: QI.encodeFunctionData("quoteExactInputSingle", [[token, WBNB, amountIn, fee, 0n]]) }));
      if (!best || r[0] > best.bnbOut) best = { fee, bnbOut: r[0] };
    } catch {}
  }
  return best;
}

export async function pancakeSellToBnb({ baw, provider, wallet, token, amountWei, slip = 3, log, sym = "底池币" }) {
  const q = await bnbForExactIn(provider, token, amountWei);
  if (!q) throw new Error(`Pancake V3 上没有 ${sym}/WBNB 池子`);
  const minOut = (q.bnbOut * BigInt(Math.round((100 - Number(slip)) * 100))) / 10000n;
  log?.(`币安休市换不了 ${sym},改走 Pancake V3(${q.fee / 10000}% 池):${ethers.formatEther(amountWei)} 个 → 约 ${ethers.formatEther(q.bnbOut)} BNB,最少 ${ethers.formatEther(minOut)}`);
  const read = async (to, fn, a) => T.decodeFunctionResult(fn, await provider.call({ to, data: T.encodeFunctionData(fn, a) }))[0];
  const exec = async (label, to, data) => {
    const p = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", wallet, "--to", to, "--value", "0", "--inputData", data]);
    if (!p?.success) throw new Error(`${label} preview 失败:${JSON.stringify(p?.error ?? p).slice(0, 300)}`);
    const risks = p.data.risks?.riskDetails || [];
    if (p.data.requireConfirmation || risks.length) throw new Error(`${label} 钱包有风险提示 / 要去 App 批准,没提交:${JSON.stringify(risks).slice(0, 200)}`);
    const ex = await baw(["contract-call", "execute", "--requestId", p.data.requestId]);
    if (!ex?.success || !ex.data?.txHash) throw new Error(`${label} 提交失败:${JSON.stringify(ex?.error ?? ex?.data ?? ex).slice(0, 300)}`);
    log?.(`${label} 已提交 ${ex.data.txHash}`);
    const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
    if (!rc) throw new Error(`${label} 60 秒没确认,别重复提交:${ex.data.txHash}`);
    if (rc.status !== 1) throw new Error(`${label} 链上失败:${ex.data.txHash}`);
    return rc;
  };
  if ((await read(token, "allowance", [wallet, V3_SWAP_ROUTER])) < amountWei) await exec(`授权 ${sym} 给 Pancake(只授权这次的数量)`, token, T.encodeFunctionData("approve", [V3_SWAP_ROUTER, amountWei]));
  const before = await read(WBNB, "balanceOf", [wallet]);
  await exec(`${sym}→WBNB(Pancake)`, V3_SWAP_ROUTER, V3R.encodeFunctionData("exactInputSingle", [[token, WBNB, q.fee, wallet, BigInt(Math.floor(Date.now() / 1000) + 1800), amountWei, minOut, 0n]]));
  const got = (await read(WBNB, "balanceOf", [wallet])) - before;
  if (got <= 0n) throw new Error(`Pancake 兑换上链了,但没看到 WBNB 到账,先查交易`);
  await exec("WBNB→BNB", WBNB, T.encodeFunctionData("withdraw", [got]));
  return got;
}

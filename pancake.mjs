// PancakeSwap V2 直连:刚毕业的盘,币安钱包的聚合器常要过一阵才收录新池子(报价报「没有路径」),
//   这时直接调 PancakeSwap V2 Router 买。路径自动找:BNB→币 直接有池子就走直连;
//   没有就找「BNB→中间币→币」(Gang 的盘毕业后池子是和底池币配对的,比如 GANG / BNCB)。
//   交易照样走 baw contract-call preview(模拟 + 风控),由调用方决定是否 execute。
import { ethers } from "ethers";

export const ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
export const FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
export const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
// 常见的中间币:USDT、Gang 的底池币们(GANG / BNCB / 币安人生 …)
const MIDS = [
  "0x55d398326f99059fF775485246999027B3197955",   // USDT
  "0x0c6302401aa5325c2e36f170f52c00b1d220b405",   // GANG
  "0x4902c5ebc598265ed2212b559b042de8a5eeec3f",   // BNCB
  "0x924fa68a0fc644485b8df8abfa0a41c2e7744444",   // 币安人生
  "0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec",   // BABAB
];
const I = new ethers.Interface([
  "function getPair(address,address) view returns (address)",
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256) payable",
]);
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
const call = async (to, fn, args) => I.decodeFunctionResult(fn, await provider.call({ to, data: I.encodeFunctionData(fn, args) }));
const pairOf = (a, b) => call(FACTORY, "getPair", [a, b]).then((r) => r[0]).catch(() => ethers.ZeroAddress);

// 找能用的路径;extraMid:额外的中间币(比如 Gang 给的底池币地址)。找不到返回 null
export async function findPath(token, extraMid) {
  token = ethers.getAddress(token);
  const probe = ethers.parseEther("0.001");
  const ok = async (path) => { try { const r = await call(ROUTER, "getAmountsOut", [probe, path]); return r[0].at(-1) > 0n; } catch { return false; } };
  if ((await pairOf(WBNB, token)) !== ethers.ZeroAddress && (await ok([WBNB, token]))) return [WBNB, token];
  const mids = [...new Set([extraMid, ...MIDS].filter(Boolean).map((x) => ethers.getAddress(x)))].filter((m) => m !== WBNB && m !== token);
  for (const m of mids) {
    if ((await pairOf(m, token)) === ethers.ZeroAddress) continue;
    if (await ok([WBNB, m, token])) return [WBNB, m, token];
  }
  return null;
}

// amountIn(wei)沿路径能换到多少(最后一跳)
export async function amountOut(amountIn, path) {
  const r = await call(ROUTER, "getAmountsOut", [amountIn, path]);
  return r[0].at(-1);
}

// 买入的 calldata(支持有税的币;deadline 2 分钟)
export function buyCalldata(minOut, path, to) {
  return I.encodeFunctionData("swapExactETHForTokensSupportingFeeOnTransferTokens", [minOut, path, to, BigInt(Math.floor(Date.now() / 1000) + 120)]);
}

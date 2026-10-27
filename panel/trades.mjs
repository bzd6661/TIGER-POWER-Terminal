// 最近成交:给交易面板的「成交」列表用。只读。
//   Gang V1 / V2:gang.fun 的 /tokens/<ca>/trades、/stocks/tokens/<ca>/trades
//   four Agent 模式:Core 的 TradeExecuted 事件(topic1 = 代币),查最近约 2 万个区块(节点见 logrpc.mjs)
//   其他平台:返回空,页面上提示去 GMGN 看
import { ethers } from "ethers";
import { logRpc } from "./logrpc.mjs";
import { provider } from "./detect.mjs";

const CORE = "0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3";
const coreI = new ethers.Interface([
  "event TradeExecuted(address indexed token, address indexed trader, uint256 indexed presetId, bool isBuy, address quoteAsset, address vault, uint256 requestedTokenAmount, uint256 tokenAmount, uint256 curveQuoteAmount, uint256 traderQuoteAmount, uint256 lastPrice, uint256 slippageLimit, uint256 protocolFee, uint256 taxFee, uint256 devFee, uint256 antiSniperFee, uint256 totalRaised, uint256 remainingForSale)",
]);
const T_TRADE = coreI.getEvent("TradeExecuted").topicHash;
// Agent ID(.ai)名字:SPACE ID 合约 handleOf(address);查过的缓存 1 小时(没有名字也缓存)
const AGENT_ID = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";
const handleSel = ethers.id("handleOf(address)").slice(0, 10);
const handles = new Map();   // addr → { at, name }
export async function handleOf(addr) {
  const hit = handles.get(addr);
  if (hit && Date.now() - hit.at < 3600_000) return hit.name;
  let name = null;
  try {
    const r = await provider.call({ to: AGENT_ID, data: handleSel + ethers.zeroPadValue(addr, 32).slice(2) });
    if (r && r.length > 130) name = ethers.AbiCoder.defaultAbiCoder().decode(["string"], r)[0] || null;
  } catch {}
  if (name && !name.endsWith(".ai")) name += ".ai";
  handles.set(addr, { at: Date.now(), name });
  return name;
}
const fmt = (x) => Number(ethers.formatEther(x));
const cache = new Map();   // ca → { at, data }


async function gangTrades(ca, v2) {
  const j = await fetch(`https://gang.fun/api/${v2 ? "stocks/tokens" : "tokens"}/${ca}/trades?limit=60&offset=0`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
  return (j.items ?? []).map((t) => ({
    ts: t.ts, side: t.side, trader: t.trader, handle: t.traderHandle || null, tx: t.tx,
    // 买入实际付出 = 金额 + 平台费(接口金额不含费;卖出金额就是到手)
    quote: t.side === "buy" ? Number(v2 ? t.quoteIn : t.bnb) + (v2 ? Number(t.taxPlat || 0) + Number(t.taxDiv || 0) : Number(t.fee || 0)) : Number(v2 ? t.quoteIn : t.bnb), tokens: Number(t.tokens), price: Number(t.price),
  }));
}

async function fourTrades(ca) {
  const latest = parseInt(await logRpc("eth_blockNumber", []), 16);
  const topic = ethers.zeroPadValue(ca, 32);
  let logs = [];
  for (let b = latest; b > latest - 20000 && logs.length < 60; b -= 5000) {
    const part = await logRpc("eth_getLogs", [{ address: CORE, topics: [T_TRADE, topic], fromBlock: "0x" + Math.max(0, b - 4999).toString(16), toBlock: "0x" + b.toString(16) }]);
    logs = part.concat(logs);
  }
  // 区块号换时间:用最新块的时间戳 + 平均出块间隔估
  const lb = await provider.getBlock("latest");
  const per = 0.45;
  const items = logs.slice(-60).reverse().map((l) => {
    const d = coreI.parseLog(l).args, blk = parseInt(l.blockNumber, 16);
    const tokens = fmt(d.tokenAmount), quote = fmt(d.traderQuoteAmount);
    // price 用曲线成交后的 lastPrice(每个代币多少 BNB),和 Gang 的 price 口径一致
    return { ts: Math.round(lb.timestamp - (lb.number - blk) * per), side: d.isBuy ? "buy" : "sell", trader: d.trader.toLowerCase(), handle: null, tx: l.transactionHash, quote, tokens, price: fmt(d.lastPrice), remaining: fmt(d.remainingForSale), fee: fmt(d.protocolFee), curve: fmt(d.curveQuoteAmount) };
  });
  const uniq = [...new Set(items.map((t) => t.trader))];
  const names = await Promise.all(uniq.map((a) => handleOf(a)));
  const map = Object.fromEntries(uniq.map((a, i) => [a, names[i]]));
  for (const t of items) t.handle = map[t.trader];
  return items;
}

export async function recentTrades(ca, platform) {
  const key = ca.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 8000) return hit.data;
  let items = [], source = null;
  if (platform === "gangv1" || platform === "gangv2") { items = await gangTrades(key, platform === "gangv2"); source = "gang.fun"; }
  else if (platform === "four") { items = await fourTrades(key); source = "链上"; }
  const data = { source, items };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// AgentCurve 单币曲线(aicurve.fun 的 AIC 等)的成交:合约自己的 Mint / Redeem 事件,从创建区块翻起,之后增量拉。只读。
//   Mint(buyer, tokensOut, reserveAdded, fee, refund):实付 = reserveAdded + fee;Redeem(seller, tokensIn, bnbOut, fee):到手 = bnbOut
//   事件签名合约没公开源码,按 topic 认(2026-11-01 对过链上交易:mint 付的 BNB = reserveAdded + fee + refund)
import { ethers } from "ethers";
import { logRpc, HAS_PRIVATE, PUBLIC_WINDOW } from "./logrpc.mjs";
import { provider } from "./detect.mjs";

const T_MINT = "0x27330bd7589580547b6437e08f9c60653de63691d2d2b2c13bff9ee67da2a68d";
const T_REDEEM = "0x484c40561359f3e3b8be9101897f8680aa82fbe1df9fd9038e0dbc6284032646";
const coder = ethers.AbiCoder.defaultAbiCoder();
const fmt = (x) => Number(ethers.formatEther(x));
const cache = new Map();   // ca → { last, rows, seen, partial }
const busy = new Map();

// 创建区块:二分查 getCode(要能查历史状态的节点;查不到就从 20 万块前开始)
async function createdBlock(ca, head) {
  try {
    let lo = Math.max(0, head - 2_000_000), hi = head;
    if ((await provider.getCode(ca, lo)) !== "0x") return head - 200_000;
    while (lo < hi) { const m = Math.floor((lo + hi) / 2); if ((await provider.getCode(ca, m)) === "0x") lo = m + 1; else hi = m; }
    return lo;
  } catch { return head - 200_000; }
}

async function once(ca) {
  const head = parseInt(await logRpc("eth_blockNumber", []), 16);
  let c = cache.get(ca);
  if (!c) {
    let from = await createdBlock(ca, head), partial = false;
    if (!HAS_PRIVATE && head - from > PUBLIC_WINDOW) { from = head - PUBLIC_WINDOW; partial = true; }
    c = { last: from - 1, rows: [], seen: new Set(), partial };
    cache.set(ca, c);
    if (cache.size > 50) cache.delete(cache.keys().next().value);
  }
  for (let a = c.last + 1; a <= head; a += 5000) {
    const b = Math.min(a + 4999, head);
    const logs = await logRpc("eth_getLogs", [{ address: ca, topics: [[T_MINT, T_REDEEM]], fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }]);
    for (const l of logs) {
      const key = l.transactionHash + ":" + l.logIndex;
      if (c.seen.has(key)) continue;
      c.seen.add(key);
      const buy = l.topics[0] === T_MINT, v = coder.decode(buy ? ["uint256", "uint256", "uint256", "uint256"] : ["uint256", "uint256", "uint256"], l.data);
      const tokens = fmt(v[0]), quote = buy ? fmt(v[1] + v[2]) : fmt(v[1]);
      c.rows.push({ blk: parseInt(l.blockNumber, 16), li: parseInt(l.logIndex, 16), side: buy ? "buy" : "sell", trader: ("0x" + l.topics[1].slice(26)).toLowerCase(),
        tx: l.transactionHash, quote, tokens, price: tokens > 0 ? quote / tokens : 0 });
    }
    c.last = b;
  }
  const lb = await provider.getBlock("latest");
  const ob = await provider.getBlock(lb.number - 20000).catch(() => null);
  const per = ob ? (lb.timestamp - ob.timestamp) / (lb.number - ob.number) : 0.45;
  return c.rows.map((r) => ({ ...r, ts: Math.round(lb.timestamp - (lb.number - r.blk) * per) })).sort((a, b) => b.blk - a.blk || b.li - a.li);
}

// 全部成交(新 → 旧);同一个币同时只拉一次
export function curveTrades(caRaw) {
  const ca = String(caRaw).toLowerCase();
  if (!busy.has(ca)) busy.set(ca, once(ca).finally(() => busy.delete(ca)));
  return busy.get(ca);
}
export const curvePartial = (ca) => !!cache.get(String(ca).toLowerCase())?.partial;

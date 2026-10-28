// Flap 普通 Portal 上的盘,重点是「Agent ID 门槛盘」(NFT 门槛):内盘阶段每笔买卖按 tx.origin 检查是否持有指定 NFT(大多是币安 Agent ID),
//   每个地址最多买总量 2%;发射到外盘(status 4)后门槛失效。管理员只能取消门槛,不能加。
//   发现:Portal 的 FlapNFTGated / FlapNFTGateUpdated / LaunchedToDEX 事件(参数都在 data 里)。首次往回补约 45 万块(约 4 天),之后每 15 秒接着查。
//   登记表存在本机 panel/flapnft.json。不在表里的币(手动搜的)按 nftGate(token) 现查。
//   成交 / K 线:Portal 的 TokenBought / TokenSold 事件(token 不是 indexed,按 Portal 地址拉再筛);交易者是路由合约时换成交易发起人。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { provider } from "./detect.mjs";
import { logRpc, LOG_STEP, HAS_PRIVATE, PUBLIC_WINDOW } from "./logrpc.mjs";
import { loadTrades, saveTrades } from "./cache.mjs";
import { dataFile } from "./datadir.mjs";

export const FLAP_PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
export const AGENT_ID_NFT = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";
const T_GATED = "0x2179156b3d2ade0f0de96eff28a7c29d924002784e113e69108d91a02cbf9098";      // FlapNFTGated(address token,address nft)
const T_GATE_UPD = "0xef4dac2f9b1190c744c50eaead877aa2f222bafb1ef8bb2c60baed13f4b63cd8";   // FlapNFTGateUpdated(address token,address oldNft,address newNft)
const T_DEX = "0x6e4f47630b8745b8cacbd44f42a8a33e7eea7cc08ef22fc7630f4f385784ff7d";        // LaunchedToDEX(address token,address pool,uint256 amount,uint256 eth)
const T_BUY = "0xa800a2038683844fac66747f771bfdfae862eb28b16bcfa387afa9fbacce8ff7";        // TokenBought(uint256 ts,address token,address trader,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)
const T_SELL = "0x03a4693e592f5e75dc7c136acb39b146d2b4966c0e509c34f362dee02b3b861a";       // TokenSold(同上)
const BACKFILL = 450_000;
const ab = ethers.AbiCoder.defaultAbiCoder();
export const portalI = new ethers.Interface([
  "function nftGate(address) view returns (address)",
  "function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount)) returns (uint256)",
  "function buyQuotaOf(address token,address origin) view returns (uint256 bought,uint256 remaining)",
  "function swapExactInput((address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,bytes permitData)) payable returns (uint256)",
  "error NFTGatedOnly(address)", "error BuyCapExceeded(address,uint256,uint256)", "error SlippageTooHigh(uint256,uint256)", "error TokenNotTradable(address)",
]);
const erc = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function name() view returns (string)", "function symbol() view returns (string)"]);

const FILE = dataFile("flapnft.json");
let reg = { tokens: {}, lastBlock: 0 };
try { reg = { tokens: {}, lastBlock: 0, ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch {}
const save = () => { try { writeFileSync(FILE, JSON.stringify(reg)); } catch {} };
const lc = (a) => String(a ?? "").toLowerCase();

// ---------- 链上状态:getTokenV8Safe(按 32 字节字读) ----------
// 字 0 status(1 内盘 / 4 已发射)· 1 reserve · 2 流通量 · 3 价格(报价币 / 个)· 8 发射门槛 · 9 报价币 · 10 能否直接用 BNB · 15 进度(1e18 = 100%)
export const portalStateCall = (ca) => "0x62fafcca" + ethers.zeroPadValue(ca, 32).slice(2);
export async function portalState(ca) {
  return parsePortalState(await provider.call({ to: FLAP_PORTAL, data: portalStateCall(ca) }));
}
export function parsePortalState(raw) {
  if (!raw || raw.length < 2 + 64 * 16) return null;
  const w = (i) => BigInt("0x" + raw.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  const status = Number(w(0));
  if (!status) return null;
  const quote = ethers.getAddress("0x" + w(9).toString(16).padStart(64, "0").slice(-40));
  return {
    status, reserve: w(1), circulating: w(2), price: Number(ethers.formatEther(w(3))), gradSupply: w(8),
    quote: quote === ethers.ZeroAddress ? null : quote, nativeSwap: w(10) !== 0n, progress: Math.min(100, Number(ethers.formatEther(w(15))) * 100),
  };
}
const gateCache = new Map();
export async function gateOf(ca) {
  const k = lc(ca), g = reg.tokens[k];
  if (g && !g.removed) return g.nft;
  if (g?.removed) return null;
  const hit = gateCache.get(k);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const r = await provider.call({ to: FLAP_PORTAL, data: portalI.encodeFunctionData("nftGate", [ca]) }).catch(() => null);
  const v = r ? portalI.decodeFunctionResult("nftGate", r)[0] : null;
  const nft = v && v !== ethers.ZeroAddress ? v : null;
  gateCache.set(k, { at: Date.now(), v: nft });
  return nft;
}
const holdCache = new Map();
export async function holdsNft(nft, wallet, force = false) {
  const k = lc(nft) + lc(wallet), hit = holdCache.get(k);
  if (!force && hit && Date.now() - hit.at < 30_000) return hit.v;
  const r = await provider.call({ to: nft, data: erc.encodeFunctionData("balanceOf", [wallet]) }).catch(() => null);
  const v = r ? Number(BigInt(r)) : null;
  holdCache.set(k, { at: Date.now(), v });
  return v;
}
export const nftName = (nft) => (lc(nft) === lc(AGENT_ID_NFT) ? "币安 Agent ID" : null);

// ---------- 发现门槛盘 ----------
function handle(l) {
  const blk = parseInt(l.blockNumber, 16);
  try {
    if (l.topics[0] === T_GATED) { const [t, nft] = ab.decode(["address", "address"], l.data); reg.tokens[lc(t)] = { ...(reg.tokens[lc(t)] ?? {}), nft, block: blk, at: Date.now() }; }
    else if (l.topics[0] === T_GATE_UPD) { const [t, , nn] = ab.decode(["address", "address", "address"], l.data); const g = (reg.tokens[lc(t)] ??= { block: blk }); if (nn === ethers.ZeroAddress) g.removed = true; else { g.nft = nn; delete g.removed; } }
    else if (l.topics[0] === T_DEX) { const [t] = ab.decode(["address"], l.data); const g = reg.tokens[lc(t)]; if (g) { g.dex = true; g.dexBlock = blk; } }
  } catch {}
}
async function scanRange(from, to) {
  const jobs = [];
  for (let a = from; a <= to; a += LOG_STEP) jobs.push(a);
  let ok = true;
  for (let i = 0; i < jobs.length; i += 6) {
    const rs = await Promise.all(jobs.slice(i, i + 6).map((a) => logRpc("eth_getLogs", [{ fromBlock: "0x" + a.toString(16), toBlock: "0x" + Math.min(to, a + LOG_STEP - 1).toString(16), address: FLAP_PORTAL, topics: [[T_GATED, T_GATE_UPD, T_DEX]] }]).catch(() => { ok = false; return []; })));
    for (const r of rs) for (const l of r.sort((x, y) => parseInt(x.blockNumber, 16) - parseInt(y.blockNumber, 16))) handle(l);
  }
  return ok;
}
let polling = false;
export async function startFlapNft() {
  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      const head = parseInt(await logRpc("eth_blockNumber", []), 16);
      let from = reg.lastBlock ? reg.lastBlock + 1 : head - (HAS_PRIVATE ? BACKFILL : PUBLIC_WINDOW);
      if (!HAS_PRIVATE && head - from > PUBLIC_WINDOW) from = head - PUBLIC_WINDOW;
      if (from <= head) { await scanRange(from, head); reg.lastBlock = head; save(); }
    } catch (e) { console.error("[Flap 门槛盘] 查事件失败", e.message.slice(0, 120)); }
    polling = false;
  };
  await tick();
  setInterval(tick, 15_000).unref();
}
export const isGatedKnown = (ca) => !!reg.tokens[lc(ca)]?.nft;
// 扫链用:还在内盘(没发射、没取消门槛)的门槛盘
export function gatedList() { return Object.entries(reg.tokens).filter(([, g]) => g.nft && !g.removed).map(([ca, g]) => ({ ca, ...g })); }

// 扫链列表用的名字 / 底池币名字(读一次记进登记表)
const metaI = new ethers.Interface(["function symbol() view returns (string)", "function name() view returns (string)"]);
export async function metaOf(ca) {
  const g = reg.tokens[lc(ca)];
  if (g?.symbol) return { symbol: g.symbol, name: g.name ?? "" };
  const [symbol, name] = await Promise.all(["symbol", "name"].map((fn) => provider.call({ to: ca, data: metaI.encodeFunctionData(fn) }).then((r) => metaI.decodeFunctionResult(fn, r)[0]).catch(() => null)));
  if (g && symbol) { g.symbol = symbol; g.name = name ?? ""; save(); }
  return { symbol: symbol ?? "?", name: name ?? "" };
}
// 已发射的(链上读到 status 4)也记进登记表,下次不用再读
export function markDex(ca) { const g = reg.tokens[lc(ca)]; if (g && !g.dex) { g.dex = true; save(); } }

// ---------- 成交:TokenBought / TokenSold ----------
const tradeCache = new Map();   // ca → { upto, trades }
const isContract = new Map(), txFrom = new Map();
async function realTrader(addr, tx) {
  const a = lc(addr);
  if (!isContract.has(a)) { const code = await provider.getCode(a).catch(() => "0x"); isContract.set(a, code !== "0x" && !code.startsWith("0xef0100")); }
  if (!isContract.get(a)) return { trader: a, via: null };
  if (!txFrom.has(tx)) { const t = await provider.getTransaction(tx).catch(() => null); txFrom.set(tx, t?.from ? lc(t.from) : a); if (txFrom.size > 20000) txFrom.clear(); }
  return { trader: txFrom.get(tx), via: a };
}
// 返回新的在前:{ ts, side, trader, via, tx, quote(报价币数量,含手续费), fee, tokens, price }
export async function flapTrades(ca) {
  const k = lc(ca), g = reg.tokens[k];
  // 缓存里有进度就接着翻(哪怕一笔成交都没有),别每次从头扫
  if (!tradeCache.has(k)) { const ch = await loadTrades("flap", k); if (ch?.cursor) tradeCache.set(k, { upto: ch.cursor - 15, trades: ch.rows ?? [] }); }
  const hit = tradeCache.get(k);
  const head = await provider.getBlockNumber();
  const start = hit ? hit.upto + 1 : Math.max(g?.block ?? head - (HAS_PRIVATE ? BACKFILL : PUBLIC_WINDOW), HAS_PRIVATE ? 0 : head - PUBLIC_WINDOW);
  const end = g?.dexBlock ? Math.min(head, g.dexBlock) : head;
  const out = [];
  let ok = true;
  const jobs = [];
  for (let a = start; a <= end; a += LOG_STEP) jobs.push(a);
  for (let i = 0; i < jobs.length; i += 6) {
    const rs = await Promise.all(jobs.slice(i, i + 6).map((a) => logRpc("eth_getLogs", [{ fromBlock: "0x" + a.toString(16), toBlock: "0x" + Math.min(end, a + LOG_STEP - 1).toString(16), address: FLAP_PORTAL, topics: [[T_BUY, T_SELL]] }]).catch(() => { ok = false; return []; })));
    for (const r of rs) for (const l of r) {
      if (lc("0x" + l.data.slice(2 + 64 + 24, 2 + 128)) !== k) continue;   // 第 2 个字是 token
      const [ts, , trader, amount, eth, fee, post] = ab.decode(["uint256", "address", "address", "uint256", "uint256", "uint256", "uint256"], l.data);
      const tokens = Number(ethers.formatEther(amount)), quote = Number(ethers.formatEther(eth));
      out.push({ ts: Number(ts), side: l.topics[0] === T_BUY ? "buy" : "sell", rawTrader: trader, tx: l.transactionHash, quote, fee: Number(ethers.formatEther(fee)), tokens,
        price: Number(ethers.formatEther(post)) || (tokens ? quote / tokens : 0), blk: parseInt(l.blockNumber, 16), li: parseInt(l.logIndex, 16) });
    }
  }
  // 交易者是合约(路由 / 聚合器)时换成交易发起人;并发 6
  for (let i = 0; i < out.length; i += 6) await Promise.all(out.slice(i, i + 6).map(async (t) => Object.assign(t, await realTrader(t.rawTrader, t.tx))));
  const merged = [...out.map(({ rawTrader, ...t }) => t), ...(hit?.trades ?? [])];
  const seen = new Set(), trades = merged.filter((t) => { const key = t.tx + ":" + t.li; if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => b.blk - a.blk || b.li - a.li);
  if (ok) { if (HAS_PRIVATE) saveTrades("flap", k, out.map(({ rawTrader, ...t }) => t), end, (t) => t.tx + ":" + t.li); tradeCache.set(k, { upto: end, trades }); if (tradeCache.size > 30) tradeCache.delete(tradeCache.keys().next().value); }
  return trades;
}

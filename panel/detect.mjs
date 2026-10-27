// 识别一个 CA:哪个平台、内盘还是外盘、两个账号各持有多少、现在值多少、买 1% 要多少。只读,不发交易。
import { ethers } from "ethers";
import { addresses } from "./session.mjs";
import { portalState, gateOf, holdsNft, nftName } from "./flapnft.mjs";
import { bnbUsd } from "./prices.mjs";

const net = ethers.Network.from(56);
// batchMaxCount:同一时刻的请求会被打成一批发出去,公共节点对「一批里的 eth_call 数量」限流(-32005),所以一批最多 10 个
export const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net, batchMaxCount: 10 });

const FOUR_CORE = "0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3";
const FOUR_TOOLS = "0x97DA82f56FEF1A0B974587a48135fa9dA2A4E905";
const FOUR_AGENT_PRESET = 1778027615735n;
const IDAGENT_FACTORY = "0xC55820f24015bE7c4f18949D9e1363A3609B300e";
const GANG_V1 = "0x315Ba2e8952D06094CC636b2B84229FA32fb23A7";
// 报"买 1% 要多少"用一个没有持仓的地址,免得已买满的账号报不出价
const PROBE = "0x000000000000000000000000000000000000dEaD";

const iface = new ethers.Interface([
  "function tokens(address) view returns (uint32 version,address creator,uint256 presetId,address token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address tokenModule,address customData,uint256 createBlock,bool exists,bool paused,bool antiSniperEnabled)",
  "function estimateBuy(address,address,uint256,uint256,bytes) view returns (tuple(uint256 curveQuote,uint256 totalFee,uint256 userPays,uint256 userReceives,uint256 tokenAmount,uint256 executionPrice))",
  "function estimateSell(address,address,uint256,uint256,bytes) view returns (tuple(uint256 curveQuote,uint256 totalFee,uint256 userPays,uint256 userReceives,uint256 tokenAmount,uint256 executionPrice))",
  "function phase() view returns (uint8)",
  "function marketOfToken(address) view returns (address)",
  "function quoteToken() view returns (address)",
  "function sharesOf(address) view returns (uint256)",
  "function quoteSellExactShares(address,uint256) view returns (uint256)",
  "function token() view returns (address)",
  "function predictedToken() view returns (address)",
  "function poolWei() view returns (uint256)",
  "function CAP() view returns (uint256)",
  "function quoteBuy(address,address,uint256) view returns (uint256 tokensOut,uint256 bnbIn,uint256 fee,uint256 refund)",
  "function quoteSell(address,uint256) view returns (uint256 bnbOut,uint256 fee)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const call = (to, fn, a = []) => provider.call({ to, data: iface.encodeFunctionData(fn, a) }).then((r) => iface.decodeFunctionResult(fn, r));
const one = (to, fn, a = []) => call(to, fn, a).then((r) => r[0]);
const fmt = (x, d = 18) => Number(ethers.formatUnits(x, d));


// 公共节点并发多了会偶尔拒绝请求:失败的读再试两次(隔 0.3 / 0.6 秒)
export async function retry(fn, n = 3) {
  for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= n - 1) throw e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); } }
}
const symCache = new Map();   // 代币名字不会变,查到就记住
async function erc20Info(ca) {
  const k = ca.toLowerCase(), hit = symCache.get(k);
  const [symbol, name, decimals, supply] = await Promise.all([
    hit ? hit.symbol : retry(() => one(ca, "symbol")).catch(() => null),
    hit ? hit.name : retry(() => one(ca, "name")).catch(() => ""),
    hit ? hit.decimals : retry(() => one(ca, "decimals")).catch(() => 18),
    retry(() => one(ca, "totalSupply")).catch(() => 0n),
  ]);
  if (symbol) symCache.set(k, { symbol, name, decimals });
  return { symbol: symbol ?? "?", name, decimals: Number(decimals), supply };
}

async function detectFour(ca, W) {
  const t = await call(FOUR_CORE, "tokens", [ca]).catch(() => null);
  if (!t || !t.exists) return null;
  const phase = Number(await one(t.vault, "phase").catch(() => 0));
  const inner = phase === 1;
  const onePct = t.maxSupply / 100n;
  const res = {
    platform: "four", platformLabel: t.presetId === FOUR_AGENT_PRESET ? "four.meme · Agent ID 模式" : `four.meme · preset ${t.presetId}`,
    stage: inner ? "inner" : "outer", quote: t.quoteAsset === ethers.ZeroAddress || t.quoteAsset.toLowerCase() === "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c" ? "BNB" : t.quoteAsset,
    supply: fmt(t.maxSupply), saleAmount: fmt(t.saleAmount), paused: t.paused, onePctTokens: fmt(onePct), holdings: {},
  };
  if (inner) {
    // 依次用 空地址 / 账号1 / 账号2 报价,取第一个报得出价的(没资格或已买满的地址会报 0)
    const est = async (amount) => {
      for (const who of [PROBE, W[1], W[2]].filter(Boolean)) {
        const r = await call(FOUR_TOOLS, "estimateBuy", [ca, who, amount, 0, "0x"]).then((x) => x[0]).catch(() => null);
        if (r && r.userPays > 0n) return r;
      }
      return null;
    };
    const [e1, eHalf] = await Promise.all([est(onePct), est(onePct / 2n)]);
    if (e1) res.cost1pct = fmt(e1.userPays);
    if (eHalf) res.costHalfPct = fmt(eHalf.userPays);
  }
  for (const [k, w] of Object.entries(W)) {
    const bal = await one(ca, "balanceOf", [w]);
    const h = { tokens: fmt(bal), pctOfSupply: t.maxSupply ? Number((bal * 10000n) / t.maxSupply) / 100 : 0 };
    if (bal > 0n && inner) {
      const e = await call(FOUR_TOOLS, "estimateSell", [ca, w, bal, 0, "0x"]).then((r) => r[0]).catch(() => null);
      if (e) h.value = fmt(e.userReceives);
    }
    res.holdings[k] = h;
  }
  return res;
}

async function detectIdAgent(ca, W) {
  const market = await one(IDAGENT_FACTORY, "marketOfToken", [ca]).catch(() => ethers.ZeroAddress);
  if (market === ethers.ZeroAddress) return null;
  const [phase, quote] = await Promise.all([one(market, "phase"), one(market, "quoteToken")]);
  const inner = Number(phase) === 1;
  const res = { platform: "idagent", platformLabel: "Flap 内盘", stage: inner ? "inner" : "outer", market, quote: quote === ethers.ZeroAddress ? "BNB" : quote, holdings: {} };
  if (inner) {
    const [pool, cap] = await Promise.all([one(market, "poolWei").catch(() => null), one(market, "CAP").catch(() => null)]);
    if (pool !== null && cap) res.progress = Number((pool * 10000n) / cap) / 100;
  }
  const tokenAddr = inner ? null : await one(market, "token").catch(() => null);
  for (const [k, w] of Object.entries(W)) {
    const shares = await one(market, "sharesOf", [w]).catch(() => 0n);
    const h = { shares: fmt(shares) };
    if (shares > 0n && inner) h.value = fmt(await one(market, "quoteSellExactShares", [w, shares]).catch(() => 0n));
    if (tokenAddr) h.tokens = fmt(await one(tokenAddr, "balanceOf", [w]).catch(() => 0n));
    res.holdings[k] = h;
  }
  return res;
}

// 底池币美元价(DexScreener,取 BSC 上流动性最大的池子),缓存 60 秒
const dexUsdCache = new Map();
export async function dexUsd(addr) {
  const hit = dexUsdCache.get(addr);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const v = await fetch("https://api.dexscreener.com/tokens/v1/bsc/" + addr, { signal: AbortSignal.timeout(8000) }).then((r) => r.json())
    .then((ps) => (Array.isArray(ps) ? ps : []).filter((p) => p.baseToken?.address?.toLowerCase() === addr && Number(p.priceUsd)).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0])
    .then((p) => (p ? Number(p.priceUsd) : null)).catch(() => hit?.v ?? null);
  dexUsdCache.set(addr, { at: Date.now(), v });
  return v;
}

// Gang 分红:taxed=true 的税币,1% 买卖税的一半按持仓分给持有 ≥1 万枚的地址(用底池币发,经分红金库);taxed=false 毕业后 0 税、不分红
export function divOf(d) {
  if (!d) return null;
  return { sym: d.quoteSymbol ?? null, vault: d.vault ?? null, totalUsd: Number(d.totalUsd) || 0, d7Usd: Number(d.d7Usd) || 0, per10kUsd: Number(d.per10kUsd) || 0, apr: Number(d.apr) || 0 };
}

async function detectGang(ca, W) {
  const r = await fetch(`https://gang.fun/api/tokens/${ca.toLowerCase()}`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!r || !r.ok) return null;
  const d = await r.json().catch(() => null);
  if (!d || !d.address) return null;
  const v2 = d.track === "stocks";
  const res = {
    platform: v2 ? "gangv2" : "gangv1", platformLabel: v2 ? `Gang V2 · 底池 ${d.quoteSymbol}` : "Gang 第一代 · 底池 BNB",
    stage: d.graduated ? "outer" : "inner", quote: v2 ? d.quoteSymbol : "BNB", progress: d.progressPct, pair: d.pair,
    holders: d.holders, lastTradeAt: d.lastTradeAt, taxed: d.taxed, dividend: d.taxed === undefined ? null : !!d.taxed, div: divOf(d.dividends), onePctTokens: 10_000_000, holdings: {},
    supply: 1e9, priceQuote: Number(v2 ? d.priceQuote : d.priceBnb) * (v2 && String(d.quoteAddress || "").toLowerCase() === "0x21caef8a43163eea865baee23b9c2e327696a3bf" ? 1e12 : 1),   // gang.fun 按 18 位给 XAUt(6 位)的价格,小 10^12 倍 quoteUsd: Number(d.quoteUsd) || null, mcUsd: Number(d.fdvUsd) || null,
    volume24hUsd: Number(d.volume24hUsd) || null, trades24h: d.trades24h ?? null, creatorHandle: d.creatorHandle ?? null,
    quoteAddress: v2 ? d.quoteAddress?.toLowerCase() ?? null : null,
  };
  // gang.fun 对部分底池币(比如 Ondo 代币化股票 FXIon)给不出美元价(quoteUsd = 0):用 DexScreener 按底池币地址补上,再算市值
  if (v2 && !res.quoteUsd && res.quoteAddress) {
    res.quoteUsd = await dexUsd(res.quoteAddress);
    if (res.quoteUsd && !res.mcUsd && res.priceQuote) res.mcUsd = res.priceQuote * res.supply * res.quoteUsd;
  }
  const price = Number(v2 ? d.priceQuote : d.priceBnb);
  if (!d.graduated) {
    if (v2) res.cost1pct = price * 1e7 * 1.01;   // 近似:现价 × 1000 万 + 1% 手续费(曲线越买越贵,实际略高)
    else {
      const q = await call(GANG_V1, "quoteBuy", [ca, PROBE, ethers.parseEther("10")]).catch(() => null);
      if (q && q.tokensOut > 0n) res.cost1pct = fmt(q.bnbIn + q.fee);
    }
    res.costHalfPct = res.cost1pct ? res.cost1pct / 2 : undefined;
  }
  for (const [k, w] of Object.entries(W)) {
    const bal = await one(ca, "balanceOf", [w]).catch(() => 0n);
    const h = { tokens: fmt(bal) };
    if (bal > 0n && !d.graduated) {
      if (v2) h.value = price * fmt(bal);
      else { const q = await call(GANG_V1, "quoteSell", [ca, bal]).catch(() => null); if (q) h.value = fmt(q.bnbOut); }
    }
    res.holdings[k] = h;
  }
  return res;
}

// Gang V3(合并发射台,2026-10-27 主网):直接读链上 curves();创建者 .ai 名字等从 gang.fun /v3/tokens 接口补(拿不到不影响)
const GANG_V3_PAD = "0x15CFD2dc8278Fb87a1783ef42111618E20874365";
const V3_VIRTUAL_TOKEN = 1_066_666_666_666_666_666_666_666_667n;
const v3I = new ethers.Interface([
  "function curves(address token) view returns (address creator, address quote, uint128 realQuote, uint128 sold, uint128 gradAmt, uint128 virtualQuote, bool graduated, uint16 buyTaxBps, uint16 sellTaxBps, uint16 dividendBps, address pair, address refPair)",
]);
async function detectGangV3(ca, W) {
  const r = await provider.call({ to: GANG_V3_PAD, data: v3I.encodeFunctionData("curves", [ca]) }).catch(() => null);
  if (!r || r === "0x") return null;
  const c = v3I.decodeFunctionResult("curves", r);
  if (c.creator === ethers.ZeroAddress) return null;
  const quote = c.quote.toLowerCase(), wb = quote === "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
  const [qInfo, api] = await Promise.all([
    wb ? null : erc20Info(c.quote).catch(() => null),
    fetch(`https://gang.fun/api/v3/tokens/${ca.toLowerCase()}`, { signal: AbortSignal.timeout(6000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null),
  ]);
  const qSym = wb ? "BNB" : qInfo?.symbol ?? "?";
  const price = Number(ethers.formatEther(((c.virtualQuote + c.realQuote) * 10n ** 18n) / (V3_VIRTUAL_TOKEN - c.sold)));
  const res = {
    platform: "gangv3", platformLabel: `Gang V3 · 底池 ${qSym}`, stage: c.graduated ? "outer" : "inner", quote: qSym, quoteAddress: wb ? null : quote,
    progress: c.graduated ? 100 : c.gradAmt > 0n ? Number((c.realQuote * 10000n) / c.gradAmt) / 100 : 0, pair: c.pair === ethers.ZeroAddress ? null : c.pair,
    supply: 1e9, onePctTokens: 10_000_000, priceQuote: price, holdings: {},
    taxed: Number(c.buyTaxBps) > 0 || Number(c.sellTaxBps) > 0, postTaxBuy: Number(c.buyTaxBps) / 100, postTaxSell: Number(c.sellTaxBps) / 100,
    dividend: Number(c.dividendBps) > 0, dividendPct: Number(c.dividendBps) / 100,
    creatorHandle: api?.creatorHandle ?? null, holders: api?.holders ?? null, lastTradeAt: api?.lastActivityAt ?? null, trades24h: api?.trades24h ?? null,
  };
  res.quoteUsd = wb ? await bnbUsd().catch(() => null) : await dexUsd(quote);
  if (res.quoteUsd) res.mcUsd = price * 1e9 * res.quoteUsd;
  if (!c.graduated) { res.cost1pct = price * 1e7 * 1.01; res.costHalfPct = res.cost1pct / 2; }
  for (const [k, w] of Object.entries(W)) {
    const bal = await one(ca, "balanceOf", [w]).catch(() => 0n);
    const h = { tokens: fmt(bal) };
    if (bal > 0n && !c.graduated) h.value = price * fmt(bal);
    res.holdings[k] = h;
  }
  return res;
}

// Flap 普通 Portal 上的盘(重点是 Agent ID 门槛盘):内盘按 Portal 直接买卖,门槛盘要钱包持有指定 NFT
async function detectFlapPortal(ca, W) {
  const st = await portalState(ca).catch(() => null);
  if (!st) return null;
  const inner = st.status === 1;
  const nft = inner ? await gateOf(ca) : null;
  const qInfo = st.quote ? await erc20Info(st.quote).catch(() => null) : null;
  const res = {
    platform: "flapportal", platformLabel: nft ? `Flap 门槛盘 · 需持有 ${nftName(nft) ?? "指定 NFT"}` : "Flap 内盘(普通)", stage: inner ? "inner" : "outer",
    quote: st.quote ? qInfo?.symbol ?? "?" : "BNB", quoteAddress: st.quote ? st.quote.toLowerCase() : null, nativeSwap: st.nativeSwap,
    progress: inner ? st.progress : undefined, priceQuote: st.price, supply: 1e9, onePctTokens: 10_000_000, holdings: {},
    nftGate: nft ? { nft, name: nftName(nft), wallets: {} } : null,
  };
  res.quoteUsd = st.quote ? await dexUsd(res.quoteAddress) : await bnbUsd().catch(() => null);
  if (res.quoteUsd && st.price) res.mcUsd = st.price * 1e9 * res.quoteUsd;
  // 买 1% 的大概花费(底池币单位 + 折成 BNB):现价 × 1000 万,曲线越买越贵,实际略高
  if (inner && st.price) {
    res.cost1pct = st.price * 1e7 * 1.02; res.costHalfPct = res.cost1pct / 2;
    const px = st.quote ? await bnbUsd().catch(() => null) : null;
    res.cost1pctBnb = !st.quote ? res.cost1pct : res.quoteUsd && px ? (res.cost1pct * res.quoteUsd) / px : null;
  }
  for (const [k, w] of Object.entries(W)) {
    const bal = await one(ca, "balanceOf", [w]).catch(() => 0n);
    const h = { tokens: fmt(bal) };
    if (bal > 0n && inner) h.value = st.price * fmt(bal);
    res.holdings[k] = h;
    if (nft) res.nftGate.wallets[k] = await holdsNft(nft, w);
  }
  return res;
}

async function detectPlain(ca, W, info) {
  const res = { platform: "dex", platformLabel: "其他 / 外盘代币", stage: "outer", quote: "BNB", holdings: {} };
  for (const [k, w] of Object.entries(W)) res.holdings[k] = { tokens: fmt(await one(ca, "balanceOf", [w]).catch(() => 0n), info.decimals) };
  return res;
}

// hint:扫链已经知道这个币是哪个平台时传进来,只问那一家(省掉等最慢的那家接口);问不到再全问一遍
export async function detect(caRaw, { hint } = {}) {
  const ca = ethers.getAddress(caRaw);
  const [code, W] = await Promise.all([provider.getCode(ca), addresses()]);   // W:只算本机已登录的账号
  if (code !== "0x" && hint) {
    const one = hint === "four" ? detectFour : hint === "gangv3" ? detectGangV3 : String(hint).startsWith("gang") ? detectGang : hint === "idagent" ? detectIdAgent : hint === "flapportal" ? detectFlapPortal : null;
    if (one) {
      const [info, hit] = await Promise.all([erc20Info(ca), one(ca, W).catch(() => null)]);
      if (hit) return { ca, symbol: info.symbol, name: info.name, wallets: W, ...hit };
    }
  }
  if (code === "0x") {
    // 还没部署的地址:可能是 Flap 内盘 的预测地址(内盘阶段只有份额)
    const idAgent = await detectIdAgent(ca, W).catch(() => null);
    if (idAgent) return { ca, symbol: "(未部署)", name: "", wallets: W, ...idAgent };
    throw new Error("这个地址上没有合约,也不是已知内盘的预测地址");
  }
  const [info, four, idAgent, gang, gang3, flapP] = await Promise.all([
    erc20Info(ca), detectFour(ca, W).catch(() => null), detectIdAgent(ca, W).catch(() => null), detectGang(ca, W).catch(() => null),
    detectGangV3(ca, W).catch(() => null), detectFlapPortal(ca, W).catch(() => null),
  ]);
  const hit = four || gang || gang3 || idAgent || flapP || (await detectPlain(ca, W, info));
  return { ca, symbol: info.symbol, name: info.name, wallets: W, ...hit };
}

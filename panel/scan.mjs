// 扫链:把 Gang(V1+V2)、four.meme Agent 模式、Flap 内盘 三个 Agent ID 内盘平台的盘子统一成一张表。只读。
//   Gang       :gang.fun 官方接口(/tokens、/stocks/tokens)
//   four Agent :Core 的 TokenCreated / TradeExecuted 事件(按 preset 过滤),历史日志按 logrpc.mjs 的节点顺序查,
//                第一次全量回扫(约 65 段 × 2),之后只扫新区块;进度存到 scan-cache.json,重启不用重扫
//   Flap 内盘   :工厂 markets(i) + Multicall3 一次批量读每个 Market 的状态
import { readFileSync, writeFileSync } from "node:fs";
import { logRpc, HAS_PRIVATE, PUBLIC_WINDOW } from "./logrpc.mjs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { provider, dexUsd, divOf } from "./detect.mjs";
import { gatedList, portalState, metaOf, markDex, FLAP_PORTAL, portalStateCall, parsePortalState } from "./flapnft.mjs";
import { kickGmgn, gmgnInfo, gmgnStatus } from "./enrich.mjs";
import { dataFile } from "./datadir.mjs";

const CACHE = dataFile("scan-cache.json");
const CORE = "0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3";
const FOUR_PRESET = 1778027615735n;
const FOUR_FROM = 129364687;
const IDAGENT_FACTORY = "0xC55820f24015bE7c4f18949D9e1363A3609B300e";
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const QUOTE_SYM = { [WBNB]: "BNB", "0x0000000000000000000000000000000000000000": "BNB", "0x0c6302401aa5325c2e36f170f52c00b1d220b405": "GANG", "0x4902c5ebc598265ed2212b559b042de8a5eeec3f": "BNCB", "0x02fca66c1d1afb4e2a7884261eb00f63598a7436": "NVDAB" };

const coreI = new ethers.Interface([
  "event TokenCreated(uint256 requestId, uint256 indexed presetId, address indexed creator, address indexed token, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, uint256 initialPrice, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address customData, address tokenModule, string tokenMetaUri, uint256 flags, bytes encodedTags)",
  "event TradeExecuted(address indexed token, address indexed trader, uint256 indexed presetId, bool isBuy, address quoteAsset, address vault, uint256 requestedTokenAmount, uint256 tokenAmount, uint256 curveQuoteAmount, uint256 traderQuoteAmount, uint256 lastPrice, uint256 slippageLimit, uint256 protocolFee, uint256 taxFee, uint256 devFee, uint256 antiSniperFee, uint256 totalRaised, uint256 remainingForSale)",
]);
const T_CREATED = coreI.getEvent("TokenCreated").topicHash;
const T_TRADE = coreI.getEvent("TradeExecuted").topicHash;
const PRESET_TOPIC = ethers.zeroPadValue(ethers.toBeHex(FOUR_PRESET), 32);
const fmt = (x) => Number(ethers.formatEther(x));


// ---------- four.meme Agent 模式(增量扫事件) ----------
let four = { lastBlock: FOUR_FROM - 1, tokens: {} };
try { four = JSON.parse(readFileSync(CACHE, "utf8")).four ?? four; } catch {}
let fourBusy = null;
async function syncFour() {
  if (fourBusy) return fourBusy;
  fourBusy = (async () => {
    const latest = parseInt(await logRpc("eth_blockNumber", []), 16);
    // 没配自己的节点:第一次只从最近约 1 小时扫起(公共节点查不了更早的),之后一直往前跟;更早的盘不会出现
    if (!HAS_PRIVATE && latest - four.lastBlock > PUBLIC_WINDOW) { four.lastBlock = latest - PUBLIC_WINDOW; four.feeBackfilled = true; four.partialFrom = four.lastBlock; }
    for (let a = four.lastBlock + 1; a <= latest; a += 5000) {
      const b = Math.min(a + 4999, latest);
      const range = { fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) };
      const [created, trades] = await Promise.all([
        logRpc("eth_getLogs", [{ address: CORE, topics: [T_CREATED, PRESET_TOPIC], ...range }]),
        logRpc("eth_getLogs", [{ address: CORE, topics: [T_TRADE, null, null, PRESET_TOPIC], ...range }]),
      ]);
      for (const l of created) {
        const d = coreI.parseLog(l).args;
        four.tokens[d.token.toLowerCase()] ??= {
          ca: d.token.toLowerCase(), name: d.name, symbol: d.symbol, creator: d.creator, maxSupply: fmt(d.maxSupply), saleAmount: fmt(d.saleAmount),
          quote: QUOTE_SYM[d.quoteAsset.toLowerCase()] ?? d.quoteAsset, createdBlock: parseInt(l.blockNumber, 16),
          buys: 0, sells: 0, volume: 0, traders: [], lastPrice: 0, remaining: fmt(d.saleAmount), raised: 0, lastTradeBlock: 0,
        };
      }
      for (const l of trades) {
        const d = coreI.parseLog(l).args, t = four.tokens[d.token.toLowerCase()];
        if (!t) continue;
        d.isBuy ? t.buys++ : t.sells++;
        t.volume += fmt(d.traderQuoteAmount);
        const tr = d.trader.toLowerCase();
        if (!t.traders.includes(tr)) t.traders.push(tr);
        t.lastPrice = fmt(d.lastPrice); t.remaining = fmt(d.remainingForSale); t.raised = fmt(d.totalRaised);
        t.lastTradeBlock = parseInt(l.blockNumber, 16);
        // 费率 = (平台费 + 代币税 + 开发者费 + 防狙击税) ÷ 曲线金额;和 Tools.estimateBuyByBudget 的报价核对过一致
        const curve = Number(d.curveQuoteAmount);
        if (curve > 0) {
          const bps = Math.round((Number(d.protocolFee) + Number(d.taxFee) + Number(d.devFee) + Number(d.antiSniperFee)) * 1e4 / curve);
          d.isBuy ? (t.feeBuyBps = bps) : (t.feeSellBps = bps);
          t.antiBps = Math.round(Number(d.antiSniperFee) * 1e4 / curve);
        }
      }
      four.lastBlock = b;
    }
    // 一次性回补费率:费率解析是后加的,之前扫过的成交没有记;最近约 1 天的成交重扫一遍,只补费率,不重复计笔数
    if (!four.feeBackfilled) {
      for (let to = four.lastBlock; to > four.lastBlock - 200_000; to -= 5000) {
        const from = to - 4999;
        const trades = await logRpc("eth_getLogs", [{ address: CORE, topics: [T_TRADE, null, null, PRESET_TOPIC], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
        for (const l of trades.reverse()) {   // 新的先来:每个币只取最近一笔买 / 卖
          const d = coreI.parseLog(l).args, t = four.tokens[d.token.toLowerCase()];
          if (!t) continue;
          const curve = Number(d.curveQuoteAmount);
          if (!(curve > 0)) continue;
          const bps = Math.round((Number(d.protocolFee) + Number(d.taxFee) + Number(d.devFee) + Number(d.antiSniperFee)) * 1e4 / curve);
          if (d.isBuy && t.feeBuyBps == null) { t.feeBuyBps = bps; t.antiBps ??= Math.round(Number(d.antiSniperFee) * 1e4 / curve); }
          if (!d.isBuy && t.feeSellBps == null) t.feeSellBps = bps;
        }
      }
      four.feeBackfilled = true;
    }
    writeFileSync(CACHE, JSON.stringify({ four, idBorn }));
  })().finally(() => (fourBusy = null));
  return fourBusy;
}

// ---------- Flap 内盘 创建时间:工厂的 MarketCreated 事件(topic1 = market) ----------
// 第一次往回扫到所有 market 都找到为止(每轮最多 60 次请求,在后台慢慢补),之后只扫新块
const T_ID_CREATED = "0x43b6c538b8819c1b3e890b74547d06fab2c5d4bdd0df442dd16035f7262cd355";
let idBorn = { lastBlock: 0, oldest: 0, map: {} };
try { idBorn = JSON.parse(readFileSync(CACHE, "utf8")).idBorn ?? idBorn; } catch {}
let idBusy = null;
function syncIdBorn(total) {
  if (idBusy) return idBusy;
  idBusy = (async () => {
    const latest = parseInt(await logRpc("eth_blockNumber", []), 16);
    const scanRange = async (a, b) => {
      const logs = await logRpc("eth_getLogs", [{ address: IDAGENT_FACTORY, topics: [T_ID_CREATED], fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }]);
      for (const l of logs) idBorn.map["0x" + l.topics[1].slice(26).toLowerCase()] = parseInt(l.blockNumber, 16);
    };
    if (!idBorn.lastBlock) idBorn = { lastBlock: latest, oldest: latest + 1, map: {} };
    for (let a = idBorn.lastBlock + 1; a <= latest; a += 5000) { const b = Math.min(a + 4999, latest); await scanRange(a, b); idBorn.lastBlock = b; }
    let budget = 60;
    const floor = latest - (HAS_PRIVATE ? 3_000_000 : PUBLIC_WINDOW);   // 有自己的节点最多往回约两周,没有就只查公共节点能查的
    while (Object.keys(idBorn.map).length < total && idBorn.oldest > floor && budget-- > 0) {
      const b = idBorn.oldest - 1, a = Math.max(floor, b - 4999);
      await scanRange(a, b); idBorn.oldest = a;
    }
    writeFileSync(CACHE, JSON.stringify({ four, idBorn }));
  })().catch(() => {}).finally(() => (idBusy = null));
  return idBusy;
}

// 区块号 → 时间:用最新块和一个旧块的时间戳线性估
let clock = null;
async function blockTime() {
  if (clock && Date.now() - clock.at < 60_000) return clock;
  const [lb, ob] = await Promise.all([provider.getBlock("latest"), provider.getBlock(FOUR_FROM).catch(() => null)]);
  const per = ob ? (lb.timestamp - ob.timestamp) / (lb.number - ob.number) : 0.45;
  clock = { at: Date.now(), n: lb.number, ts: lb.timestamp, per };
  return clock;
}
const tsOf = (c, block) => Math.round(c.ts - (c.n - block) * c.per);

// ---------- Flap 内盘(Multicall 批量读) ----------
const mcI = new ethers.Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"]);
const mkI = new ethers.Interface([
  "function phase() view returns (uint8)", "function poolWei() view returns (uint256)", "function CAP() view returns (uint256)",
  "function quoteToken() view returns (address)", "function predictedToken() view returns (address)", "function token() view returns (address)",
  "function buyCount() view returns (uint256)", "function sellCount() view returns (uint256)", "function holderCount() view returns (uint256)",
  "function marketCap() view returns (uint256)", "function launchedAt() view returns (uint256)",
  "function launchConfig() view returns (tuple(string name, string symbol, string uri))",
  "function marketCount() view returns (uint256)", "function markets(uint256) view returns (address)",
]);
const idNames = {};
const idMeta = {};   // market → { creator, feeBuy, feeSell, taxBuy, taxSell }
const READER = "0x18Aa6C93f1887a243fdc348C9A77F5136555174a";
// 内盘实际收的费 = Flap 平台费(链上累计费用 ÷ 累计金额核对过,和代币税设置无关);代币税是发射后才收
const readerI = new ethers.Interface(["function marketDetail(address market) view returns ((address market,address creator,address quoteToken,uint8 quoteDecimals,uint256 capRaw,uint256 poolRaw,uint256 remainingRaw,uint256 progressBps,uint8 phase,address predictedToken,address token,address pair,uint256 curveReserveRaw,uint256 totalShares,uint256 claimedShares,uint256 maxWalletShares,uint256 predictedInitialBuyNetRaw,bytes32 configHash,uint256 flapBuyFeeBps,uint256 flapSellFeeBps,uint256 agentFeeBps,uint256 buyCount,uint256 sellCount,uint256 cumulativeBuyGrossRaw,uint256 cumulativeBuySubmittedRaw,uint256 cumulativeBuyNetRaw,uint256 cumulativeBuyFeesRaw,uint256 cumulativeBuyRefundRaw,uint256 cumulativeBuyShares,uint256 cumulativeBuyCurveRaw,uint256 cumulativeSellDebitRaw,uint256 cumulativeSellPayoutRaw,uint256 cumulativeSellFeesRaw,uint256 cumulativeSellShares,uint256 cumulativeSellCurveRaw,uint256 cumulativeSellReserveRefundRaw,uint256 claimCount,uint256 uniqueBuyerCount,uint256 holderCount,uint256 virtualCurveVolumeRaw,uint256 cumulativeAgentFeesRaw,uint256 launchedAt,uint256 statsStartBlock,bool statsComplete,bool quoteBalanceKnown,uint256 quoteBalanceRaw,bool quoteBackingEnough,bool inventoryKnown,uint256 inventoryRaw,bool inventoryEnough) info)", "function marketSettings(address market) view returns (tuple(tuple(string name,string symbol,string meta,bytes32 salt,address beneficiary,uint16 buyTaxRate,uint16 sellTaxRate,uint16 mktBps,uint16 deflationBps,uint16 dividendBps,uint16 lpBps,uint16 maxWalletBps) launch,address quoteToken,uint8 quoteDecimals,uint256 capRaw,address quoteHelper,bytes32 quoteConfigHash,uint8 curveType,uint256 curveR,uint256 curveH,uint256 curveK,uint256 predictedInitialBuyNetRaw,uint256 virtualReserveAtCapRaw,uint256 maxWalletShares) info)"]);
async function loadIdMeta(markets) {
  const need = markets.filter((m) => m && !idMeta[m]);
  if (!need.length) return;
  const res = await multicall(need.flatMap((m) => [[READER, readerI.encodeFunctionData("marketDetail", [m])], [READER, readerI.encodeFunctionData("marketSettings", [m])]]));
  need.forEach((m, i) => {
    try {
      const d = readerI.decodeFunctionResult("marketDetail", res[i * 2].returnData)[0];
      const st = readerI.decodeFunctionResult("marketSettings", res[i * 2 + 1].returnData)[0][0];
      idMeta[m] = { creator: String(d.creator).toLowerCase(), feeBuy: Number(d.flapBuyFeeBps) / 100, feeSell: Number(d.flapSellFeeBps) / 100, taxBuy: Number(st.buyTaxRate) / 100, taxSell: Number(st.sellTaxRate) / 100 };
    } catch {}
  });
}
async function multicall(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 400) {
    const chunk = calls.slice(i, i + 400);
    const r = await provider.call({ to: MULTICALL, data: mcI.encodeFunctionData("aggregate3", [chunk.map(([t, d]) => ({ target: t, allowFailure: true, callData: d }))]) });
    out.push(...mcI.decodeFunctionResult("aggregate3", r)[0]);
  }
  return out;
}
// 池子已经装满(内盘阶段但再也买不进)
const full = (v) => v.poolWei !== null && v.CAP && BigInt(v.poolWei) >= BigInt(v.CAP);
async function idAgentRows() {
  const n = Number(mkI.decodeFunctionResult("marketCount", await provider.call({ to: IDAGENT_FACTORY, data: mkI.encodeFunctionData("marketCount") }))[0]);
  const addrRes = await multicall(Array.from({ length: n }, (_, i) => [IDAGENT_FACTORY, mkI.encodeFunctionData("markets", [i])]));
  const markets = addrRes.map((r) => (r.success ? mkI.decodeFunctionResult("markets", r.returnData)[0] : null));
  await loadIdMeta(markets).catch(() => {});   // 开发者 + 费率(只读一次)
  const fns = ["phase", "poolWei", "CAP", "quoteToken", "predictedToken", "buyCount", "sellCount", "holderCount", "marketCap", "launchedAt"];
  const needName = markets.filter((m) => m && !idNames[m]);
  const calls = markets.flatMap((m) => (m ? fns.map((f) => [m, mkI.encodeFunctionData(f)]) : []));
  const nameCalls = needName.map((m) => [m, mkI.encodeFunctionData("launchConfig")]);
  const res = await multicall([...calls, ...nameCalls]);
  needName.forEach((m, i) => {
    const r = res[calls.length + i];
    try { const c = mkI.decodeFunctionResult("launchConfig", r.returnData)[0]; idNames[m] = { name: c.name, symbol: c.symbol, uri: c.uri }; } catch { idNames[m] = { name: "?", symbol: "?" }; }
  });
  const rows = [];
  let k = 0;
  markets.forEach((m, idx) => {
    if (!m) return;
    const v = {};
    for (const f of fns) { const r = res[k++]; try { v[f] = r.success ? mkI.decodeFunctionResult(f, r.returnData)[0] : null; } catch { v[f] = null; } }
    const phase = Number(v.phase ?? 0);
    const quote = QUOTE_SYM[String(v.quoteToken).toLowerCase()] ?? "?";
    rows.push({
      platform: "idagent", platformLabel: "Flap 内盘", ca: String(v.predictedToken).toLowerCase(), market: m, index: idx,
      name: idNames[m]?.name, symbol: idNames[m]?.symbol, uri: idNames[m]?.uri, quote,
      creator: idMeta[m]?.creator ?? null, feeBuy: idMeta[m]?.feeBuy ?? null, feeSell: idMeta[m]?.feeSell ?? null, postTaxBuy: idMeta[m]?.taxBuy ?? null, postTaxSell: idMeta[m]?.taxSell ?? null,
      progress: v.CAP ? Math.min(100, (Number(v.poolWei) / Number(v.CAP)) * 100) : null,
      raised: v.poolWei !== null ? fmt(v.poolWei) : null, mcap: null,   // marketCap() 读出来是按上限算的固定值,不显示
      txs: Number(v.buyCount ?? 0) + Number(v.sellCount ?? 0), holders: Number(v.holderCount ?? 0), volume: null,
      // phase 1 = 内盘;2 = 已打满、等开盘;3 = 已开盘
      graduated: phase >= 2 || full(v), status: phase === 3 ? "已开盘" : phase === 2 || full(v) ? "已满待开盘" : "内盘", createdAt: null, graduatedAt: v.launchedAt ? Number(v.launchedAt) : null,
    });
  });
  return rows;
}

// ---------- Gang ----------
const isXaut = (a) => String(a || "").toLowerCase() === "0x21caef8a43163eea865baee23b9c2e327696a3bf";
async function gangRows() {
  const get = async (path) => {
    let out = [];
    for (let off = 0; off < 1000; off += 200) {
      const j = await fetch(`https://gang.fun/api${path}${path.includes("?") ? "&" : "?"}limit=200&offset=${off}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
      const it = j.items ?? [];
      out = out.concat(it);
      if (it.length < 200) break;
    }
    return out;
  };
  const [v1, v2, v3] = await Promise.all([get("/tokens?sort=new"), get("/stocks/tokens"), get("/v3/tokens").catch(() => [])]);
  // gang.fun 给不出美元价的底池币(Ondo 代币化股票 FXIon 等,fdvUsd = 0):按底池币地址用 DexScreener 补
  const qUsd = {};
  for (const q of [...new Set(v2.filter((t) => !Number(t.quoteUsd) && t.quoteAddress).map((t) => t.quoteAddress.toLowerCase()))]) qUsd[q] = await dexUsd(q).catch(() => null);
  const usdOf = (t) => qUsd[String(t.quoteAddress || "").toLowerCase()] || null;
  // gang.fun 接口按 18 位格式化底池币金额:XAUt(6 位)的筹集额 / 价格 / 成交额会小 10^12 倍,这里换回来
  const qk = (t) => (isXaut(t.quoteAddress) ? 1e12 : 1);
  const row = (t, isV2) => ({
    platform: isV2 ? "gangv2" : "gangv1", platformLabel: isV2 ? "Gang V2" : "Gang", ca: t.address.toLowerCase(), name: t.name, symbol: t.symbol,
    quote: isV2 ? t.quoteSymbol : "BNB", progress: Number(t.progressPct), raised: Number(isV2 ? t.raisedQuote : t.raisedBnb) * (isV2 ? qk(t) : 1),
    mcap: Number(isV2 ? t.priceQuote : t.priceBnb) * 1e9 * (isV2 ? qk(t) : 1) || Number(t.fdvBnb) || null, volume: Number(t.volume24hBnb ?? 0) || null, volumeLabel: "24h",
    mcapUsd: Number(t.fdvUsd) || (isV2 && usdOf(t) ? Number(t.priceQuote) * qk(t) * 1e9 * usdOf(t) : null) || null,
    volumeUsd: Number(t.volume24hUsd) || (isV2 && usdOf(t) ? Number(t.volume24hQuote || 0) * qk(t) * usdOf(t) : null) || null,
    txs: t.trades ?? null, holders: t.holders ?? null, graduated: !!t.graduated, createdAt: t.createdAt ?? null, graduatedAt: t.graduatedAt ?? null,
    lastTradeAt: t.lastTradeAt ?? null, taxed: !!t.taxed, dividend: t.taxed === undefined ? null : !!t.taxed, div: divOf(t.dividends),
    creator: String(t.creator || "").toLowerCase() || null, creatorHandle: t.creatorHandle || null, feeBuy: 1, feeSell: 1, postTax: t.taxed ? Number(t.taxBps || 0) / 100 : 0,
  });
  // V3:接口给的是原始单位(realQuote)和底池币单位的价格;WBNB 底池按 BNB 价换美元,其他底池币用 DexScreener
  const bnbPx = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT", { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).then((j) => Number(j.price)).catch(() => null);
  for (const q of [...new Set(v3.filter((t) => t.quoteSymbol !== "WBNB" && t.quoteAddress).map((t) => t.quoteAddress.toLowerCase()))]) if (!(q in qUsd)) qUsd[q] = await dexUsd(q).catch(() => null);
  const row3 = (t) => {
    const wb = t.quoteSymbol === "WBNB", px = wb ? bnbPx : qUsd[String(t.quoteAddress || "").toLowerCase()] ?? null, price = Number(t.priceQuote) || 0;
    return {
      platform: "gangv3", platformLabel: "Gang V3", ca: t.address.toLowerCase(), name: t.name, symbol: t.symbol, quote: wb ? "BNB" : t.quoteSymbol,
      progress: Number(t.progressPct), raised: Number(t.realQuote || 0) / 10 ** Number(t.quoteDecimals ?? 18), mcap: price * 1e9 || null,
      mcapUsd: price && px ? price * 1e9 * px : null, volume: Number(t.volume24hQuote ?? 0) || null, volumeLabel: "24h",
      volumeUsd: px && t.volume24hQuote ? Number(t.volume24hQuote) * px : null,
      txs: t.trades ?? null, holders: null, graduated: !!t.graduated, createdAt: t.createdAt ?? null, graduatedAt: t.graduatedAt ?? null, lastTradeAt: t.lastActivityAt ?? null,
      taxed: Number(t.buyTaxBps) > 0 || Number(t.sellTaxBps) > 0, dividend: Number(t.dividendBps) > 0, dividendPct: Number(t.dividendBps) / 100,
      creator: String(t.creator || "").toLowerCase() || null, creatorHandle: t.creatorHandle || null, feeBuy: 1, feeSell: 1,
      postTaxBuy: Number(t.buyTaxBps) / 100, postTaxSell: Number(t.sellTaxBps) / 100,
    };
  };
  return [...v1.map((t) => row(t, false)), ...v2.map((t) => row(t, true)), ...v3.map(row3)];
}

// ---------- 已开盘的 four / Flap 内盘:外盘实时市值(DexScreener,30 个一批,1 分钟一次) ----------
// 不能用「内盘最后成交价 × 总量」,那是毕业那一刻的市值(four 的曲线参数都一样,所以全是同一个数),不是现在的。
// DexScreener 的价格和链上储备核对过(差 < 1%);找不到外盘池子的就不显示市值。
const dexMc = new Map();
let dexAt = 0, dexBusy = null;
function dexUpdate(cas) {
  if (dexBusy || Date.now() - dexAt < 60_000) return dexBusy;
  dexBusy = (async () => {
    for (let i = 0; i < cas.length; i += 30) {
      const chunk = cas.slice(i, i + 30);
      const r = await fetch("https://api.dexscreener.com/tokens/v1/bsc/" + chunk.join(","), { signal: AbortSignal.timeout(12000) }).then((x) => x.json()).catch(() => null);
      if (!Array.isArray(r)) continue;
      for (const ca of chunk) {
        const ps = r.filter((p) => p.baseToken?.address?.toLowerCase() === ca).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        if (ps[0]) dexMc.set(ca, { mc: Number(ps[0].marketCap || ps[0].fdv) || null, vol: Number(ps[0].volume?.h24) || null, liq: ps[0].liquidity?.usd ?? null, dex: ps[0].dexId });
        else dexMc.set(ca, null);
      }
    }
    dexAt = Date.now();
  })().catch(() => {}).finally(() => (dexBusy = null));
  return dexBusy;
}

// ---------- 汇总 ----------
// 有上一次的结果就直接返回(不让页面等十几秒),超过 15 秒在后台重扫;
// 结果另存一份到 scan-last.json,面板重启后第一次打开也不用等
const LAST_FILE = dataFile("scan-last.json");
let last = null;
try { const d = JSON.parse(readFileSync(LAST_FILE, "utf8")); if (d?.tokens?.length) last = { at: 0, data: d }; } catch {}
let fresh = null, savedAt = 0;
export const tokenMeta = (ca) => last?.data.tokens.find((t) => t.ca === ca);
// 有新盘 / 毕业时让列表尽快更新:后台重扫一次(正在扫就不重复)
export function refreshScan() { if (!fresh) fresh = scanFresh().catch((e) => console.error("[扫链] 后台刷新失败", e.message)).finally(() => (fresh = null)); }
export async function scan({ force = false } = {}) {
  if (!force && last) {
    if (Date.now() - last.at > 15_000 && !fresh) fresh = scanFresh().catch((e) => console.error("[扫链] 后台刷新失败", e.message)).finally(() => (fresh = null));
    return last.data;
  }
  if (!fresh) fresh = scanFresh().finally(() => (fresh = null));
  return fresh;
}
// ---------- Flap 门槛盘(Agent ID 等 NFT 门槛,登记表来自 Portal 链上事件) ----------
async function flapRows(c) {
  const list = gatedList();
  // 还在内盘的门槛盘:一次 multicall 读完所有状态(以前一个盘一个请求,和别的扫链请求挤在一起会被节点限流)
  const live = list.filter((g) => !g.dex);
  const states = new Map();
  if (live.length) {
    const res = await multicall(live.map((g) => [FLAP_PORTAL, portalStateCall(g.ca)]));
    live.forEach((g, i) => { if (res[i]?.success) { try { states.set(g.ca, parsePortalState(res[i].returnData)); } catch {} } });
  }
  const rows = [];
  for (let i = 0; i < list.length; i += 10) {
    rows.push(...(await Promise.all(list.slice(i, i + 10).map(async (g) => {
      const st = g.dex ? null : states.get(g.ca) ?? null;
      if (st?.status === 4) markDex(g.ca);
      const graduated = !!g.dex || st?.status === 4;
      const m = await metaOf(g.ca);
      let quote = "BNB", qUsd = null;
      if (st?.quote) { quote = (await metaOf(st.quote).catch(() => null))?.symbol ?? "?"; qUsd = await dexUsd(st.quote.toLowerCase()).catch(() => null); }
      return {
        platform: "flapportal", platformLabel: "Flap 门槛", ca: g.ca, name: m.name, symbol: m.symbol, quote, nftGate: g.nft,
        progress: graduated ? 100 : st?.progress ?? null, mcap: st?.price ? st.price * 1e9 : null, mcapUsd: st?.price && qUsd ? st.price * 1e9 * qUsd : null,
        graduated, createdAt: c && g.block ? tsOf(c, g.block) : null, graduatedAt: c && g.dexBlock ? tsOf(c, g.dexBlock) : null, lastTradeAt: null,
      };
    }))));
  }
  return rows;
}
// 某一组(Gang / Flap 内盘 / 门槛盘)这一轮没拉下来:先用上一次的数据,提示只写一句人话(原始报错打到日志里)
const lastGood = {};
function group(name, fn, errors) {
  return fn().then((rows) => { lastGood[name] = rows; return rows; }).catch((e) => {
    const msg = String(e?.message ?? e);
    console.error(`[扫链] ${name} 没刷新:`, msg.slice(0, 300));
    const why = /rate limit|-32005|429|Too Many/i.test(msg) ? "节点限流" : /timeout|ETIMEDOUT|aborted/i.test(msg) ? "超时" : "出错";
    errors.push(`${name}:${why}${lastGood[name] ? ",先显示上次的数据" : ",稍后自动重试"}`);
    return lastGood[name] ?? [];
  });
}
async function scanFresh() {
  const errors = [];
  const c0 = await blockTime().catch(() => null);
  const [gang, idAgent, flapG] = await Promise.all([
    group("Gang", gangRows, errors),
    group("Flap 内盘", idAgentRows, errors),
    group("Flap 门槛盘", () => flapRows(c0), errors),
    syncFour().catch((e) => { const m = String(e?.message ?? e); console.error("[扫链] four 没刷新:", m.slice(0, 300)); errors.push("four:" + (/rate limit|-32005|429|Too Many/i.test(m) ? "节点限流" : /timeout|aborted/i.test(m) ? "超时" : "出错") + ",先显示已有的数据"); }),
  ]);
  const c = await blockTime().catch(() => null);
  const fourRows = Object.values(four.tokens).map((t) => ({
    platform: "four", platformLabel: "four Agent", ca: t.ca, name: t.name, symbol: t.symbol, quote: t.quote,
    progress: t.saleAmount ? Math.min(100, ((t.saleAmount - t.remaining) / t.saleAmount) * 100) : null,
    raised: t.raised, mcap: t.lastPrice ? t.lastPrice * t.maxSupply : null, volume: t.volume, volumeLabel: "累计",
    txs: t.buys + t.sells, holders: t.traders.length, holdersLabel: "交易人数",
    // 买入费拆成 基础费 + 防狙击税:防狙击税随开盘时间递减,这里是最近一笔成交时的值(和合约报价核对过,基础费一致)
    creator: String(t.creator || "").toLowerCase() || null, feeBuy: t.feeBuyBps != null ? (t.feeBuyBps - (t.antiBps || 0)) / 100 : null, feeSell: t.feeSellBps != null ? t.feeSellBps / 100 : null, anti: t.antiBps ? t.antiBps / 100 : 0,
    feeAt: t.lastTradeBlock && c ? tsOf(c, t.lastTradeBlock) : null, graduated: t.remaining === 0 && t.raised > 0,
    createdAt: c ? tsOf(c, t.createdBlock) : null, lastTradeAt: c && t.lastTradeBlock ? tsOf(c, t.lastTradeBlock) : null, graduatedAt: null,
  }));
  const bnbUsd = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT", { signal: AbortSignal.timeout(8000) }).then((r) => r.json()).then((j) => Number(j.price)).catch(() => null);
  kickGmgn();
  // 底池是 BNB 的,用 BNB 价把市值 / 成交额换成美元(Gang 接口自己给了美元值)
  for (const t of [...fourRows, ...idAgent, ...flapG]) if (t.quote === "BNB" && bnbUsd) {
    if (t.mcap) t.mcapUsd = t.mcap * bnbUsd;
    if (t.volume) t.volumeUsd = t.volume * bnbUsd;
  }
  syncIdBorn(idAgent.length);   // 后台补,不等
  for (const t of idAgent) { const b = idBorn.map[String(t.market).toLowerCase()]; if (b && c) t.createdAt = tsOf(c, b); }
  // 已开盘的 four / Flap 内盘:换成外盘实时市值和 24h 成交额(第一次等它拉完,之后后台每分钟更新)
  const grads = [...fourRows, ...idAgent, ...flapG].filter((t) => t.graduated && t.ca);
  const p = dexUpdate(grads.map((t) => t.ca));
  if (!dexAt && p) await p;
  for (const t of grads) {
    const d = dexMc.get(t.ca);
    t.mcapAtGrad = t.mcapUsd ?? null;
    t.mcapUsd = d?.mc ?? null;
    if (d) { t.volumeUsd = d.vol; t.volumeLabel = "24h"; t.dexLiqUsd = d.liq; t.dex = d.dex; }
  }
  const tokens = [...gang, ...fourRows, ...idAgent, ...flapG];
  for (const t of tokens) {
    const g = gmgnInfo(t.ca);
    if (!g) continue;
    t.gmgn = {
      mcapUsd: Number(g.usd_market_cap ?? g.market_cap) || null, holders: g.holder_count ?? null, volume24hUsd: Number(g.volume_24h) || null, swaps24h: g.swaps_24h ?? null,
      smart: g.smart_degen_count ?? 0, kol: g.renowned_count ?? 0, top10: g.top_10_holder_rate ?? null, rug: g.rug_ratio ?? null, twitter: g.twitter_handle || null,
    };
  }
  const data = { at: Date.now(), errors, bnbUsd, gmgn: gmgnStatus(), tokens };
  last = { at: Date.now(), data };
  if (Date.now() - savedAt > 60_000) { savedAt = Date.now(); try { writeFileSync(LAST_FILE, JSON.stringify(data)); } catch {} }   // 最多一分钟存一次
  return data;
}
// 交易页只要列表里的几个字段(左侧扫链栏、收藏栏市值、屏蔽开发者):精简版小得多
export function scanLite(data) {
  return {
    at: data.at, bnbUsd: data.bnbUsd, errors: data.errors,
    tokens: data.tokens.map((t) => ({
      ca: t.ca, symbol: t.symbol, name: t.name, platform: t.platform, platformLabel: t.platformLabel, index: t.index, creator: t.creator,
      progress: t.progress, graduated: t.graduated, createdAt: t.createdAt, graduatedAt: t.graduatedAt, lastTradeAt: t.lastTradeAt,
      mcapUsd: t.mcapUsd, holders: t.holders, holdersLabel: t.holdersLabel, gmgn: t.gmgn ? { mcapUsd: t.gmgn.mcapUsd } : undefined,
      // 交易页左侧扫链栏的标签用
      quote: t.quote, postTax: t.postTax, postTaxBuy: t.postTaxBuy, postTaxSell: t.postTaxSell, dividend: t.dividend, dividendPct: t.dividendPct, nftGate: t.nftGate ? true : undefined, anti: t.anti || undefined,
    })),
  };
}

// 实时链上事件:新盘 / 成交 / 毕业,推给页面(SSE)。只读。
//   不用第三方推送,直接订阅链上日志(各事件字段和链上核对过):
//     four Agent 模式:Core 的 TokenCreated / TradeExecuted(presetId = Agent 模板)
//     Gang V1 发射台 + 3 个 V2 发射台:Created / Buy / Sell / Graduated(签名来自官方 gang CLI 的 abi.js)
//     Flap 内盘:工厂的 MarketCreated(topic1 = market),每个市场合约的成交事件 0x4fadb287
//       (topic2 = 交易者;data[0] 0 买 1 卖,data[1] 份额,data[3] 金额 —— 买入是实际付出、卖出是实际到手,和 fsi 一致)
//   两路互补:WebSocket 订阅(快)+ 每 3 秒按区块补查(不漏),按 交易哈希:日志序号 去重。
import { ethers } from "ethers";
import { EventEmitter } from "node:events";
import { provider } from "./detect.mjs";

const WSS = process.env.BSC_WSS || "wss://bsc-rpc.publicnode.com";
const CORE = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
const FOUR_PRESET = 1778027615735n;
const GANG_V1 = "0x315ba2e8952d06094cc636b2b84229fa32fb23a7";
const GANG_V2 = ["0x1b8f3f69dfa0a7f63d308c7eb0fd38d8b099966e", "0xf81c4e51c48466c6025b0165b1ea0f6978c712cb", "0x60aee38576035e757ded30ff8db8a8da476430c1"];
// Gang V3(合并发射台,2026-10-27 主网):Buy / Sell / Graduated 和 V2 字段一样,Created 少一个 taxed
const GANG_V3 = "0x15cfd2dc8278fb87a1783ef42111618e20874365";
const FACTORY = "0xc55820f24015be7c4f18949d9e1363a3609b300e";
const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const T_MARKET_CREATED = "0x43b6c538b8819c1b3e890b74547d06fab2c5d4bdd0df442dd16035f7262cd355";
const T_ID_TRADE = "0x4fadb287b5a184a1d906fa3c6e9dbc3ae273b231ac008bb87357883aebc4b687";

const fourI = new ethers.Interface([
  "event TokenCreated(uint256 requestId, uint256 indexed presetId, address indexed creator, address indexed token, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, uint256 initialPrice, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address customData, address tokenModule, string tokenMetaUri, uint256 flags, bytes encodedTags)",
  "event TradeExecuted(address indexed token, address indexed trader, uint256 indexed presetId, bool isBuy, address quoteAsset, address vault, uint256 requestedTokenAmount, uint256 tokenAmount, uint256 curveQuoteAmount, uint256 traderQuoteAmount, uint256 lastPrice, uint256 slippageLimit, uint256 protocolFee, uint256 taxFee, uint256 devFee, uint256 antiSniperFee, uint256 totalRaised, uint256 remainingForSale)",
]);
const v1I = new ethers.Interface([
  "event Created(address indexed token, address indexed creator, string name, string symbol)",
  "event Buy(address indexed token, address indexed buyer, uint256 bnbIn, uint256 fee, uint256 tokensOut, uint256 realBnb)",
  "event Sell(address indexed token, address indexed seller, uint256 tokensIn, uint256 fee, uint256 bnbOut, uint256 realBnb)",
  "event Graduated(address indexed token, address indexed pair, uint256 tokenAmount, uint256 bnbAmount)",
]);
const v2I = new ethers.Interface([
  "event Created(address indexed token, address indexed creator, string name, string symbol, string logoURI, bool taxed, address indexed quote, address refPair, uint256 gradAmt)",
  "event Buy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 taxDividend, uint256 taxPlatform, uint256 tokensOut, uint256 realQuote)",
  "event Sell(address indexed token, address indexed seller, uint256 tokensIn, uint256 taxDividend, uint256 taxPlatform, uint256 quoteOut, uint256 realQuote)",
  "event Graduated(address indexed token, address indexed pair, address quote, uint256 tokenAmount, uint256 quoteAmount)",
]);
const v3I = new ethers.Interface([
  "event Created(address indexed token, address indexed creator, string name, string symbol, string logoURI, address indexed quote, address refPair, uint256 gradAmt)",
  "event Buy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 taxDividend, uint256 taxPlatform, uint256 tokensOut, uint256 realQuote)",
  "event Sell(address indexed token, address indexed seller, uint256 tokensIn, uint256 taxDividend, uint256 taxPlatform, uint256 quoteOut, uint256 realQuote)",
  "event Graduated(address indexed token, address indexed pair, address quote, uint256 tokenAmount, uint256 quoteAmount)",
]);
const mkI = new ethers.Interface([
  "function marketCount() view returns (uint256)", "function markets(uint256) view returns (address)", "function predictedToken() view returns (address)",
  "function launchConfig() view returns (tuple(string name, string symbol, string uri))",
]);
const mcI = new ethers.Interface(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"]);
const fmt = (x) => Number(ethers.formatEther(x));
const addr = (topic) => "0x" + topic.slice(26).toLowerCase();

export const bus = new EventEmitter();
bus.setMaxListeners(100);
const status = { wsConnected: false, lastEventAt: null, events: 0, wsEvents: 0, pollEvents: 0, reconnects: 0, markets: 0, lastError: null };
export const liveStatus = () => ({ ...status });
// Flap 内盘 市场列表 [[market, { ca, name, symbol }]](给自动领取用)
export const marketList = () => [...marketToken.entries()];

// ---------- Flap 内盘:market → 预测的代币地址 ----------
const marketToken = new Map();   // market → { ca, name, symbol }
async function multicall(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 200) {
    const chunk = calls.slice(i, i + 200);
    const r = await provider.call({ to: MULTICALL, data: mcI.encodeFunctionData("aggregate3", [chunk.map(([t, d]) => ({ target: t, allowFailure: true, callData: d }))]) });
    out.push(...mcI.decodeFunctionResult("aggregate3", r)[0]);
  }
  return out;
}
async function loadMarkets() {
  const n = Number(mkI.decodeFunctionResult("marketCount", await provider.call({ to: FACTORY, data: mkI.encodeFunctionData("marketCount") }))[0]);
  const ms = (await multicall(Array.from({ length: n }, (_, i) => [FACTORY, mkI.encodeFunctionData("markets", [i])]))).map((r) => (r.success ? mkI.decodeFunctionResult("markets", r.returnData)[0].toLowerCase() : null)).filter(Boolean);
  await addMarkets(ms.filter((m) => !marketToken.has(m)));
}
async function addMarkets(ms) {
  if (!ms.length) return;
  const res = await multicall(ms.flatMap((m) => [[m, mkI.encodeFunctionData("predictedToken")], [m, mkI.encodeFunctionData("launchConfig")]]));
  ms.forEach((m, i) => {
    try {
      const ca = mkI.decodeFunctionResult("predictedToken", res[i * 2].returnData)[0].toLowerCase();
      let name = "", symbol = "";
      try { const c = mkI.decodeFunctionResult("launchConfig", res[i * 2 + 1].returnData)[0]; name = c.name; symbol = c.symbol; } catch {}
      marketToken.set(m, { ca, name, symbol });
    } catch {}
  });
  status.markets = marketToken.size;
}

// ---------- 解码 ----------
function decode(l) {
  const a = l.address.toLowerCase(), t0 = l.topics[0];
  const base = { tx: l.transactionHash, blk: Number(l.blockNumber), li: Number(l.logIndex) };
  try {
    if (a === CORE) {
      const ev = fourI.parseLog(l);
      if (ev.name === "TradeExecuted") {
        if (ev.args.presetId !== FOUR_PRESET) return null;
        const d = ev.args;
        return { ...base, type: "trade", platform: "four", ca: d.token.toLowerCase(), side: d.isBuy ? "buy" : "sell", trader: d.trader.toLowerCase(), quote: fmt(d.traderQuoteAmount), tokens: fmt(d.tokenAmount), price: fmt(d.lastPrice), quoteSym: "BNB" };
      }
      if (ev.name === "TokenCreated") {
        if (ev.args.presetId !== FOUR_PRESET) return null;
        return { ...base, type: "launch", platform: "four", ca: ev.args.token.toLowerCase(), name: ev.args.name, symbol: ev.args.symbol, creator: ev.args.creator.toLowerCase() };
      }
      return null;
    }
    const isV1 = a === GANG_V1, isV3 = a === GANG_V3, isV2 = GANG_V2.includes(a) || isV3;
    if (isV1 || isV2) {
      let ev = null; try { ev = (isV1 ? v1I : isV3 ? v3I : v2I).parseLog(l); } catch {}
      if (!ev) return null;
      const d = ev.args, platform = isV1 ? "gangv1" : isV3 ? "gangv3" : "gangv2";
      if (ev.name === "Buy") {
        // 实际付出 = 金额 + 手续费(V1 fee;V2 两种税)
        const paid = isV1 ? fmt(d.bnbIn) + fmt(d.fee) : fmt(d.quoteIn) + fmt(d.taxDividend) + fmt(d.taxPlatform);
        return { ...base, type: "trade", platform, ca: d.token.toLowerCase(), side: "buy", trader: d.buyer.toLowerCase(), quote: paid, tokens: fmt(d.tokensOut), price: fmt(d.tokensOut) ? (isV1 ? fmt(d.bnbIn) : fmt(d.quoteIn)) / fmt(d.tokensOut) : 0 };
      }
      if (ev.name === "Sell") {
        const got = isV1 ? fmt(d.bnbOut) : fmt(d.quoteOut);
        return { ...base, type: "trade", platform, ca: d.token.toLowerCase(), side: "sell", trader: d.seller.toLowerCase(), quote: got, tokens: fmt(d.tokensIn), price: fmt(d.tokensIn) ? got / fmt(d.tokensIn) : 0 };
      }
      if (ev.name === "Created") return { ...base, type: "launch", platform, ca: d.token.toLowerCase(), name: d.name, symbol: d.symbol, creator: d.creator.toLowerCase() };
      if (ev.name === "Graduated") return { ...base, type: "graduate", platform, ca: d.token.toLowerCase(), pair: d.pair.toLowerCase() };
      return null;
    }
    if (a === FACTORY && t0 === T_MARKET_CREATED) {
      const m = addr(l.topics[1]);
      return { ...base, type: "launch", platform: "idagent", market: m, ca: marketToken.get(m)?.ca ?? null };
    }
    if (t0 === T_ID_TRADE && marketToken.has(a)) {
      const w = (l.data.slice(2).match(/.{64}/g) || []).map((x) => BigInt("0x" + x));
      const sell = w[0] === 1n, shares = fmt(w[1]), amount = fmt(w[3]);
      const mt = marketToken.get(a);
      return { ...base, type: "trade", platform: "idagent", market: a, ca: mt.ca, side: sell ? "sell" : "buy", trader: addr(l.topics[2]), quote: amount, tokens: shares, price: shares ? amount / shares : 0 };
    }
  } catch {}
  return null;
}

// ---------- 去重 + 发出 ----------
const seen = new Map();   // key → 时间
async function handle(l, via) {
  if (l.removed) return;
  const key = l.transactionHash + ":" + Number(l.logIndex);
  if (seen.has(key)) return;
  seen.set(key, Date.now());
  if (seen.size > 20000) for (const [k, t] of seen) { if (Date.now() - t > 600_000) seen.delete(k); if (seen.size < 15000) break; }
  let ev = decode(l);
  // 新的 Flap 内盘 市场:补进地址表,并把这个市场加进订阅
  if (ev?.type === "launch" && ev.platform === "idagent") {
    await addMarkets([ev.market]).catch(() => {});
    const mt = marketToken.get(ev.market);
    ev = { ...ev, ca: mt?.ca ?? null, name: mt?.name, symbol: mt?.symbol };
    resubscribe();
  }
  if (!ev) return;
  ev.ts = Math.floor(Date.now() / 1000);   // 推送时间(和出块时间差不到几秒)
  status.events++; status.lastEventAt = Date.now();
  via === "ws" ? status.wsEvents++ : status.pollEvents++;
  bus.emit("event", ev);
}

// ---------- WebSocket 订阅 ----------
let ws = null, subId = null, wsTimer = null, lastWsMsg = 0;
const watchList = () => [CORE, GANG_V1, ...GANG_V2, GANG_V3, FACTORY, ...marketToken.keys()];
function connect() {
  clearTimeout(wsTimer);
  try { ws?.close(); } catch {}
  ws = new WebSocket(WSS);
  ws.onopen = () => { status.wsConnected = true; lastWsMsg = Date.now(); subscribe(); };
  ws.onmessage = (e) => {
    lastWsMsg = Date.now();
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id === 1 && m.result) { subId = m.result; return; }
    if (m.params?.subscription && m.params.subscription === subId && m.params.result) handle(m.params.result, "ws");
  };
  ws.onclose = () => { status.wsConnected = false; status.reconnects++; wsTimer = setTimeout(connect, 3000); };
  ws.onerror = (e) => { status.lastError = "WebSocket:" + (e.message ?? "出错"); };
}
function subscribe() {
  if (ws?.readyState !== 1) return;
  if (subId) ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_unsubscribe", params: [subId] }));
  subId = null;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["logs", { address: watchList() }] }));
}
let resubT = null;
function resubscribe() { clearTimeout(resubT); resubT = setTimeout(subscribe, 500); }

// ---------- 每 3 秒补查(不漏) ----------
// 公共节点每次最多 10 个地址:核心 6 个合约每次都查;Flap 内盘 市场每 10 个一组轮流查(每组记自己的进度)
const POLL_RPC = process.env.BSC_POLL_RPC || "https://bsc-rpc.publicnode.com";
async function rpc(method, params) {
  const r = await fetch(POLL_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
}
const cursor = new Map();   // 组名 → 已查到的块
async function pollGroup(name, addrs, head) {
  const last = cursor.get(name) ?? head - 20;
  if (head <= last) return;
  const from = last + 1, to = Math.min(head, from + 2000);
  const logs = await rpc("eth_getLogs", [{ address: addrs, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
  for (const l of logs) await handle({ ...l, blockNumber: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16) }, "poll");
  cursor.set(name, to);
}
let rr = 0;
async function poll() {
  try {
    // 公共节点是负载均衡的几台,有的会落后一两个块:补查只查到 最新 − 2(最新的块订阅已经推过了)
    const head = parseInt(await rpc("eth_blockNumber", []), 16) - 2;
    await pollGroup("core", [CORE, GANG_V1, ...GANG_V2, GANG_V3, FACTORY], head);
    const ms = [...marketToken.keys()];
    const groups = Math.ceil(ms.length / 10);
    if (groups) { const g = rr++ % groups; await pollGroup("m" + g, ms.slice(g * 10, g * 10 + 10), head); }
  } catch (e) { status.lastError = "补查:" + e.message.slice(0, 120); }
}

export async function startLive() {
  await loadMarkets().catch((e) => { status.lastError = "读 Flap 内盘 市场失败:" + e.message; });
  connect();
  setInterval(poll, 3000);
  // 订阅 60 秒没任何消息(连空闲心跳都没有)就重连
  setInterval(() => { if (ws && Date.now() - lastWsMsg > 120_000) connect(); }, 30_000);
  // Flap 内盘 市场列表每 5 分钟对一次(防止漏了新市场)
  setInterval(() => loadMarkets().then(resubscribe).catch(() => {}), 300_000);
}

// 钱包追踪的历史回补用:按交易者过滤的日志查询条件 + 同一个解码器
//   four TradeExecuted / Gang Buy、Sell 的 topic2 都是交易者;Flap 内盘 成交事件的 topic2 也是交易者(不限合约地址,解码时只认已知市场)
export const TRADER_LOG_SOURCES = {
  addresses: [CORE, GANG_V1, ...GANG_V2, GANG_V3],
  topics: [fourI.getEvent("TradeExecuted").topicHash, v1I.getEvent("Buy").topicHash, v1I.getEvent("Sell").topicHash, v2I.getEvent("Buy").topicHash, v2I.getEvent("Sell").topicHash],
  idTopic: T_ID_TRADE,
};
export const decodeLog = (l) => decode(l);
export const marketOf = (ca) => { for (const [m, t] of marketToken) if (t.ca === String(ca).toLowerCase()) return m; return null; };
export const marketInfo = (m) => marketToken.get(String(m).toLowerCase()) ?? null;

// 钱包状态 + 已有代币:两个账号各自的 baw 状态/设置、BNB 余额,以及从交易记录里找出来、现在还持有的代币(带平台/内外盘识别)。只读。
import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detect, provider, retry } from "./detect.mjs";
import { bawJson as baw, sessions } from "./session.mjs";
import { bnbUsd } from "./prices.mjs";
import { quoteUsdOf } from "./history.mjs";
const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
// 查不到就返回 null(不是 0):别因为节点偶尔拒绝,就把持仓从列表里漏掉
const balanceOf = (token, who) => retry(() => provider.call({ to: token, data: erc20.encodeFunctionData("balanceOf", [who]) })).then(BigInt).catch(() => null);
// 最多同时跑 n 个
async function limitAll(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]); } }));
  return res;
}
const BNB = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// 自己在链上买过的币(live.mjs 的成交事件里交易者是自己):账号 → 代币地址集合,存本机 panel/known-tokens.json
const KNOWN_FILE = fileURLToPath(new URL("./known-tokens.json", import.meta.url));
let known = {};
try { known = JSON.parse(readFileSync(KNOWN_FILE, "utf8")) || {}; } catch {}
export function noteToken(acct, ca) {
  const k = String(ca).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(k)) return false;
  const list = (known[acct] ||= []);
  if (list.includes(k)) return false;
  list.push(k);
  if (list.length > 300) list.shift();
  try { writeFileSync(KNOWN_FILE, JSON.stringify(known)); } catch {}
  return true;
}

// 完整交易记录:baw 一页最多 100 笔,交易多了以后早买的币会掉出最近 100 笔,持仓列表和成本就看不到。
// 所以第一次把能翻到的历史都翻一遍(最多 30 页),存本机 panel/txcache-<账号>.json,以后每次只拉最新一页合并进去。
const txFile = (acct) => fileURLToPath(new URL(`./txcache-${acct}.json`, import.meta.url));
const txKey = (t) => t.txHash || t.txHashList?.[0]?.txHash || JSON.stringify(t).slice(0, 200);
async function txHistory(acct) {
  let c = { complete: false, address: null, txs: [] };
  try { c = { ...c, ...JSON.parse(readFileSync(txFile(acct), "utf8")) }; } catch {}
  const page = (cursor) => baw(acct, ["wallet", "tx-history", "--binanceChainId", "56", "--size", "100", ...(cursor ? ["--nextCursor", cursor] : [])]);
  const first = await page(null);
  if (!first?.success) return c.txs;   // 拉不到就用本机缓存
  const map = new Map(c.txs.map((t) => [txKey(t), t]));
  for (const t of first.data?.transactions ?? []) map.set(txKey(t), t);   // 新的覆盖旧的(pending → confirmed)
  if (!c.complete) {
    let cur = first.data?.hasMore ? first.data.nextCursor : null, n = 1;
    for (; cur && n < 30; n++) {
      const r = await page(cur);
      if (!r?.success) break;
      for (const t of r.data?.transactions ?? []) if (!map.has(txKey(t))) map.set(txKey(t), t);
      cur = r.data?.hasMore ? r.data.nextCursor : null;
    }
    c.complete = !cur;
  }
  c.txs = [...map.values()].sort((a, b) => Date.parse(b.txTime || 0) - Date.parse(a.txTime || 0));   // 新的在前,和 baw 一样
  try { writeFileSync(txFile(acct), JSON.stringify(c)); } catch {}
  return c.txs;
}

// sess = sessions() 里这个号的登录状态和地址(已经查过,不再重复调 baw)
async function account(acct, sess) {
  const address = sess.address;
  const [settings, txs, bnbWei] = await Promise.all([
    baw(acct, ["wallet", "settings"]), txHistory(acct).catch(() => []),
    address ? provider.getBalance(address).catch(() => null) : null,
  ]);
  const hist = { data: { transactions: txs } };
  const s = settings?.data ?? {};
  const out = {
    acct, address, status: sess.status ?? "未知",
    bnb: bnbWei !== null && bnbWei !== undefined ? Number(ethers.formatEther(bnbWei)) : null,
    devMode: s.devMode ? { enabled: s.devMode.enabled, expiresAt: s.devMode.expiresAt, limit: s.devMode.dailyLimit, used: s.developerModeQuotaUsed } : null,
    dailyLimit: s.dailyLimit, quotaUsed: s.quotaUsed, tradeAllTokens: s.tradeAllTokens, abnormalTxnHandling: s.abnormalTxnHandling,
    sessionExpireTime: s.sessionExpireTime, tokens: [],
  };
  // 交易记录里出现过的 ERC20(跳过 BNB 和 NFT)
  const seen = new Map();
  for (const t of hist?.data?.transactions ?? []) {
    const ins = t.txHashList?.[0]?.instructions ?? {};
    for (const x of [...(ins.send ?? []), ...(ins.receive ?? [])]) {
      const a = x.tokenInfo?.contractAddress?.toLowerCase();
      if (!a || a === BNB || x.tokenInfo.decimals === 0 || x.tokenInfo.tokenId) continue;
      if (!seen.has(a)) seen.set(a, { address: a, symbol: x.tokenInfo.symbol, decimals: x.tokenInfo.decimals ?? 18 });
    }
  }
  // 链上实时事件里看到自己买过的币:币安交易记录刚成交时常常还没收录,先按这里补上(余额为 0 的不显示)
  for (const a of known[acct] ?? []) if (!seen.has(a)) seen.set(a, { address: a, symbol: null, decimals: 18, fromChain: true });
  out.costs = costsFromHistory(hist?.data?.transactions ?? []);
  costCache[acct] = { ts: Date.now(), costs: out.costs };
  if (address) {
    // 每个币的余额一起查,不一个一个等
    const list = [...seen.values()];
    const bals = await limitAll(list, 4, (t) => balanceOf(t.address, address));
    list.forEach((t, i) => {
      if (bals[i] === null) out.tokens.push({ ...t, balance: null, balanceError: true });   // 查失败的先留着,标出来
      else if (bals[i] > 0n) out.tokens.push({ ...t, balance: Number(ethers.formatUnits(bals[i], t.decimals)) });
    });
  }
  return out;
}

// 成本:每笔「收到代币 X、同时付出别的币」的交易算一次买入,付出的减去同一笔里退回的同种币(合约退款)。
// 付出的币就是成本单位(内盘用 BNB / WBNB / GANG / BNCB…,和面板上的「现值」单位一致)。
// 卖出 / 转走一部分后,剩下仓位的成本按 持仓 ÷ 累计买入 摊。用本机缓存的完整交易记录(txHistory)。
function costsFromHistory(txs) {
  const costs = {};
  // 新的在前:倒过来按时间顺序算
  for (const t of [...txs].reverse()) {
    if (t.status && t.status !== "confirmed") continue;
    const ins = t.txHashList?.[0]?.instructions ?? {};
    const send = ins.send ?? [], recv = ins.receive ?? [];
    for (const r of recv) {
      const ca = r.tokenInfo?.contractAddress?.toLowerCase();
      if (!ca || ca === BNB || r.tokenInfo.decimals === 0) continue;
      const paid = send.filter((s) => s.tokenInfo.contractAddress.toLowerCase() !== ca);
      if (!paid.length) continue;   // 纯转入 / 领取,不算买入
      const unit = paid[0].tokenInfo.symbol;
      const unitCa = paid[0].tokenInfo.contractAddress.toLowerCase();
      const out = paid.filter((s) => s.tokenInfo.contractAddress.toLowerCase() === unitCa).reduce((s, x) => s + Number(x.amount), 0);
      const back = recv.filter((x) => x.tokenInfo.contractAddress.toLowerCase() === unitCa).reduce((s, x) => s + Number(x.amount), 0);
      const c = (costs[ca] ??= { cost: 0, bought: 0, sold: 0, soldTokens: 0, unit });
      if (c.unit !== unit) continue;   // 混了不同的付款币就只按第一种算
      c.cost += out - back;
      c.bought += Number(r.amount);
      (c.parts ??= []).push({ t: Date.parse(t.txTime), amt: out - back });   // 每笔买入的时间和花费(算美元成本用)
    }
    // 卖出:付出代币 X、同一笔收到别的币(BNB / 底池币)
    for (const s of send) {
      const ca = s.tokenInfo?.contractAddress?.toLowerCase();
      if (!ca || ca === BNB || s.tokenInfo.decimals === 0) continue;
      const c = costs[ca];
      if (!c) continue;
      const got = recv.filter((x) => x.tokenInfo.symbol === c.unit).reduce((a, x) => a + Number(x.amount), 0);
      if (!got) continue;   // 纯转出,不算卖出
      c.sold += got;
      c.soldTokens += Number(s.amount);
    }
  }
  return costs;
}
const costCache = {};
// 单个代币的成本(给查询卡片用):有 2 分钟内的缓存就直接用,否则重新拉两个号的交易记录
export async function costsFor(ca, holdings) {
  const key = ca.toLowerCase();
  const res = {};
  for (const acct of Object.keys(holdings ?? {})) {
    if (!costCache[acct] || Date.now() - costCache[acct].ts > 120_000) {
      costCache[acct] = { ts: Date.now(), costs: costsFromHistory(await txHistory(acct).catch(() => [])) };
    }
    const c = costCache[acct].costs[key];
    const held = holdings?.[acct]?.tokens;
    if (c && c.bought > 0 && held) res[acct] = { cost: c.cost * Math.min(1, held / c.bought), unit: c.unit, invested: c.cost, received: c.sold };
  }
  return res;
}

// BNB 在某一分钟的美元价(币安 1 分钟 K 线收盘价),按分钟缓存
const bnbAt = new Map();
async function bnbUsdAt(ms) {
  if (!isFinite(ms)) return null;
  const m = Math.floor(ms / 60_000) * 60_000;
  if (bnbAt.has(m)) return bnbAt.get(m);
  const v = await fetch(`https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=1m&startTime=${m}&limit=1`, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.json()).then((j) => Number(j?.[0]?.[4]) || null).catch(() => null);
  if (v) bnbAt.set(m, v);
  return v;
}
// 美元成本 / 现值 / 盈亏:BNB 买的按每笔买入那一分钟的 BNB 价;用 GANG 等底池币买的没有历史价,按现价(标约)
async function addUsd(tokens, accts, detected, union) {
  const now = await bnbUsd();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i], d = detected[union.indexOf(t.ca)];
    const qUsd = d?.quoteUsd ?? (!t.quote || /^w?bnb$/i.test(t.quote) ? now : await quoteUsdOf(t.quote).catch(() => null));
    t.usd = {};
    for (const a of accts) {
      const c = a.costs[t.ca], bal = t.balances[a.acct];
      if (!bal) continue;
      const valueUsd = t.values?.[a.acct] != null && qUsd ? t.values[a.acct] * qUsd : null;
      let costUsd = null, approx = false;
      if (c && c.bought > 0) {
        const share = Math.min(1, bal / c.bought);
        if (/^w?bnb$/i.test(c.unit)) {
          let sum = 0, ok = true;
          for (const p of c.parts ?? []) { const px = await bnbUsdAt(p.t); if (!px) { ok = false; break; } sum += p.amt * px; }
          costUsd = ok ? sum * share : now ? c.cost * share * now : null; approx = !ok;
        } else { costUsd = qUsd ? c.cost * share * qUsd : null; approx = true; }
      }
      t.usd[a.acct] = { costUsd, valueUsd, pnlUsd: costUsd != null && valueUsd != null ? valueUsd - costUsd : null, approx };
    }
  }
}

// 并发跑 detect,限制同时 4 个
async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]).catch((e) => ({ error: e.message })); } }));
  return res;
}

// 总览缓存:有缓存就马上返回,超过 15 秒在后台重算;force(下单后)就等新的
let ov = null, ovBusy = null;
export async function walletsOverview({ force = false } = {}) {
  const rebuild = () => (ovBusy ??= buildOverview().then((data) => ((ov = { at: Date.now(), data }), data)).finally(() => (ovBusy = null)));
  if (!force && ov) { if (Date.now() - ov.at > 15_000) rebuild().catch(() => {}); return { ...ov.data, cachedAt: ov.at }; }
  // 强制刷新(刚下完单)时如果已经有一轮在跑,那一轮是下单前开始的、结果是旧的:等它跑完再重新查一轮
  if (force && ovBusy) { await ovBusy.catch(() => {}); return rebuild(); }
  return rebuild();
}
async function buildOverview() {
  const ss = await sessions();
  const accts = await Promise.all(Object.values(ss).filter((s) => s.connected).map((s) => account(s.acct, s)));
  const union = [...new Set(accts.flatMap((a) => a.tokens.map((t) => t.address)))];
  const detected = await pool(union, 4, (ca) => detect(ca));
  const tokens = union.map((ca, i) => {
    const d = detected[i];
    const bal = Object.fromEntries(accts.map((a) => [a.acct, a.tokens.find((t) => t.address === ca)?.balance ?? 0]));
    const sym = accts.flatMap((a) => a.tokens).find((t) => t.address === ca)?.symbol;
    return {
      ca, symbol: d?.symbol && d.symbol !== "?" ? d.symbol : sym ?? "?", platformLabel: d?.platformLabel ?? "?", platform: d?.platform, stage: d?.stage, quote: d?.quote,
      progress: d?.progress, balances: bal, values: d?.holdings ? Object.fromEntries(Object.entries(d.holdings).map(([k, h]) => [k, h.value])) : {},
      // 剩余仓位的成本(按持仓比例摊)
      costs: Object.fromEntries(accts.map((a) => {
        const c = a.costs[ca];
        return [a.acct, c && c.bought > 0 && bal[a.acct] ? { cost: c.cost * Math.min(1, bal[a.acct] / c.bought), unit: c.unit } : null];
      })),
      error: d?.error,
    };
  });
  await addUsd(tokens, accts, detected, union).catch((e) => console.error("[美元成本]", e.message));
  // 底池币 / 零头排后面:内盘的在前,其次外盘
  tokens.sort((a, b) => (a.stage === "inner" ? 0 : 1) - (b.stage === "inner" ? 0 : 1));
  return { accounts: accts.map(({ tokens, costs, ...rest }) => rest), sessions: Object.values(ss).map(({ acct, installed, status, connected, error }) => ({ acct, installed, status, connected, error })), tokens };
}

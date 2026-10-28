// 钱包状态 + 已有代币:两个账号各自的 baw 状态/设置、BNB 余额,以及从交易记录里找出来、现在还持有的代币(带平台/内外盘识别)。只读。
import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detect, provider, retry } from "./detect.mjs";
import { bawJson as baw, sessions } from "./session.mjs";
import { bnbUsd } from "./prices.mjs";
import { quoteUsdOf } from "./history.mjs";
import { loadBnbPx, saveBnbPx } from "./cache.mjs";
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
// BNB 和 WBNB 当成同一种币(按合约地址认,不按名字):用 BNB 买、退回 / 卖得 WBNB 的都算得上。
// 两套口径:
//   1. 底池币口径(cost / bought / sold,单位 = 第一次买入付的币):旧字段,美元成本和没有 BNB 口径时用。
//   2. BNB 口径(全部折成 BNB):Gang 这类用底池币(GANG / BNCB…)买卖的,面板下单都是两笔挨着的交易 ——
//      买:BNB → 底池币(兑换)、几秒后 底池币 → 代币;卖:代币 → 底池币、几秒后 底池币 → BNB。
//      每笔买卖按它旁边那笔「BNB ⇄ 底池币」兑换的实际汇率折成 BNB;两跳的(BNB → USDT → FXIon)按底池币自己的 BNB 成本价;
//      都配不上的部分记成底池币数量(leftIn / leftOut),展示时按现价折算并标 ≈。
//      剩余成本按时间顺序用「平均成本法」:每次卖出 / 转走按比例减掉,清仓后归零(早就卖光的那一轮不会算进现在的仓位)。
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const isBnb = (ca) => ca === BNB || ca === WBNB;
const addrOf = (x) => x?.tokenInfo?.contractAddress?.toLowerCase();
const canon = (ca) => (isBnb(ca) ? BNB : ca);   // BNB / WBNB 统一成一个
const PAIR_WINDOW = 180_000, PAIR_WIDE = 900_000;
function swapIndex(txs) {
  const idx = {};   // 底池币地址 → [{ t, rate(1 个底池币 = 多少 BNB) }]
  for (const t of txs) {
    if (t.status && t.status !== "confirmed") continue;
    const ins = t.txHashList?.[0]?.instructions ?? {};
    const send = ins.send ?? [], recv = ins.receive ?? [];
    if (send.length !== 1 || recv.length !== 1) continue;
    const s = send[0], r = recv[0], sc = addrOf(s), rc = addrOf(r);
    if (!sc || !rc || isBnb(sc) === isBnb(rc)) continue;   // 必须一边是 BNB / WBNB、另一边是别的币
    const [q, bnbAmt, qAmt] = isBnb(sc) ? [rc, Number(s.amount), Number(r.amount)] : [sc, Number(r.amount), Number(s.amount)];
    if (!(bnbAmt > 0 && qAmt > 0)) continue;
    (idx[q] ??= []).push({ t: Date.parse(t.txTime), rate: bnbAmt / qAmt });
  }
  return idx;
}
// 找汇率:先找前后 3 分钟内最近的一笔兑换;没有就往交易方向找 15 分钟内的(买入看之前换的,卖出看之后换回的)
function rateNear(idx, q, t, dir) {
  let best = null, wide = null;
  for (const s of idx[q] ?? []) {
    const dt = Math.abs(s.t - t);
    if (dt <= PAIR_WINDOW && (!best || dt < best.dt)) best = { dt, rate: s.rate };
    const ok = dir === "buy" ? s.t <= t : s.t >= t;
    if (ok && dt <= PAIR_WIDE && (!wide || dt < wide.dt)) wide = { dt, rate: s.rate };
  }
  return best?.rate ?? wide?.rate ?? null;
}
// 某个号在某个币上的 BNB 口径:投入 / 卖回 / 剩余成本(BNB)。没配上兑换的部分按 quoteBnb(现价,1 个底池币 = 多少 BNB)折算;
//   bal:现在的持有量(剩余成本按 持有 ÷ 记录里的剩余数量 再核一次,防止有记录外的转入转出)
export function bnbView(c, quoteBnb, bal = null) {
  if (!c || !(c.qtyIn > 0)) return null;
  const conv = (exact, left) => (left > 0 ? (quoteBnb ? exact + left * quoteBnb : null) : exact);
  const investedBnb = conv(c.bnbIn, c.leftIn), receivedBnb = conv(c.bnbOut, c.leftOut), rem = conv(c.remBnb, c.remLeft);
  if (investedBnb === null || receivedBnb === null) return null;
  const remainingBnb = rem === null ? null : bal !== null && c.remQty > 0 ? rem * Math.min(1, bal / c.remQty) : rem;
  return { investedBnb, receivedBnb, remainingBnb, bnbApprox: !!c.est || c.leftIn > 0 || c.leftOut > 0 || c.remLeft > 0 };
}
export function costsFromHistory(txs) {   // export 只为了本机核对
  const costs = {};
  const swaps = swapIndex(txs);
  // 一笔付 / 收的币折成 BNB:{ bnb } 或 { left }(底池币数量,等现价折算)或 null(估不了)
  // coin / amt:这笔付出(买入时)或收到(卖出时)的另一种币和数量;self / selfQty:这边的代币和数量。
  //   顺序:直接是 BNB → 另一种币旁边有 BNB 兑换 → 这边的代币自己旁边有 BNB 兑换(比如 GANG 本身)→ 两跳估算 → 底池币数量留着按现价算
  const toBnb = (coin, amt, ts, dir, c, self, selfQty) => {
    if (isBnb(coin)) return { bnb: amt };
    const rate = rateNear(swaps, coin, ts, dir);
    if (rate) return { bnb: amt * rate };
    const own = rateNear(swaps, self, ts, dir === "buy" ? "sell" : "buy");
    if (own) return { bnb: selfQty * own };
    // 两跳(BNB → USDT → FXIon 这种,底池币从没直接和 BNB 换过):卖出按这个底池币自己卖出的平均 BNB 价,买入按它的平均 BNB 成本价;是估算,标 ≈
    const p = costs[coin];
    if (p && dir === "sell" && p.qtyOut > 0 && !(p.leftOut > 0) && p.bnbOut > 0) return { bnb: amt * (p.bnbOut / p.qtyOut), est: true };
    if (p && p.qtyIn > 0 && !(p.leftIn > 0) && p.bnbIn > 0) return { bnb: amt * (p.bnbIn / p.qtyIn), est: true };
    if (coin === c.unitCa) return { left: amt };
    return null;
  };
  // 新的在前:倒过来按时间顺序算
  for (const t of [...txs].reverse()) {
    if (t.status && t.status !== "confirmed") continue;
    const ins = t.txHashList?.[0]?.instructions ?? {};
    const send = ins.send ?? [], recv = ins.receive ?? [];
    const ts = Date.parse(t.txTime);
    for (const r of recv) {
      const ca = addrOf(r);
      if (!ca || isBnb(ca) || r.tokenInfo.decimals === 0) continue;   // BNB / WBNB 本身不算持仓(退回的 WBNB 不能当成「买了 WBNB」)
      const paid = send.filter((s) => addrOf(s) !== ca);
      if (!paid.length) continue;   // 纯转入 / 领取,不算买入
      const pay = canon(addrOf(paid[0]));
      const same = (x) => canon(addrOf(x)) === pay && addrOf(x) !== ca;
      const net = paid.filter(same).reduce((a, x) => a + Number(x.amount), 0) - recv.filter(same).reduce((a, x) => a + Number(x.amount), 0);
      if (!(net > 0)) continue;
      const qty = Number(r.amount);
      const c = (costs[ca] ??= { unit: isBnb(pay) ? "BNB" : paid[0].tokenInfo.symbol, unitCa: pay, cost: 0, bought: 0, sold: 0, soldTokens: 0,
        bnbIn: 0, leftIn: 0, bnbOut: 0, leftOut: 0, qtyIn: 0, qtyOut: 0, remBnb: 0, remLeft: 0, remQty: 0 });
      // 底池币口径:只算用第一种付款币买的
      if (pay === c.unitCa) { c.cost += net; c.bought += qty; (c.parts ??= []).push({ t: ts, amt: net }); }   // parts:每笔买入的时间和花费(算美元成本用)
      // BNB 口径:不管用什么币付的都折成 BNB
      const v = toBnb(pay, net, ts, "buy", c, ca, qty);
      if (!v) continue;
      c.qtyIn += qty; c.remQty += qty;
      if (v.est) c.est = true;
      if (v.bnb !== undefined) { c.bnbIn += v.bnb; c.remBnb += v.bnb; } else { c.leftIn += v.left; c.remLeft += v.left; }
    }
    // 卖出:付出代币 X、同一笔收到别的币(底池币 / BNB / WBNB…);什么都没收到的是转出
    for (const s of send) {
      const ca = addrOf(s);
      if (!ca || isBnb(ca) || s.tokenInfo.decimals === 0) continue;
      const c = costs[ca];
      if (!c) continue;
      const qty = Number(s.amount);
      const gotOf = (coin) => recv.filter((x) => canon(addrOf(x)) === coin && addrOf(x) !== ca).reduce((a, x) => a + Number(x.amount), 0);
      // 收到的币:优先底池币,其次 BNB,再其次别的
      const coins = [...new Set(recv.map((x) => canon(addrOf(x))).filter((x) => x && x !== ca))];
      const coin = coins.includes(c.unitCa) ? c.unitCa : coins.includes(BNB) ? BNB : coins[0];
      const got = coin ? gotOf(coin) : 0;
      if (got > 0) {
        if (coin === c.unitCa) { c.sold += got; c.soldTokens += qty; }
        const v = toBnb(coin, got, ts, "sell", c, ca, qty);
        if (v) { c.qtyOut += qty; if (v.est) c.est = true; if (v.bnb !== undefined) c.bnbOut += v.bnb; else c.leftOut += v.left; }
      }
      // 卖出 / 转走都让剩余仓位按比例变少(平均成本法)
      const f = c.remQty > 0 ? Math.max(0, 1 - qty / c.remQty) : 0;
      c.remBnb *= f; c.remLeft *= f; c.remQty = Math.max(0, c.remQty - qty);
      if (c.remQty < 1e-9) { c.remBnb = 0; c.remLeft = 0; c.remQty = 0; }
    }
  }
  return costs;
}
const costCache = {};
// 单个代币的成本(给查询卡片用):有 2 分钟内的缓存就直接用,否则重新拉两个号的交易记录
// quoteBnb:1 个底池币现在值多少 BNB(没配上兑换的部分用它折算)
export async function costsFor(ca, holdings, quoteBnb = null) {
  const key = ca.toLowerCase();
  const res = {};
  for (const acct of Object.keys(holdings ?? {})) {
    if (!costCache[acct] || Date.now() - costCache[acct].ts > 120_000) {
      costCache[acct] = { ts: Date.now(), costs: costsFromHistory(await txHistory(acct).catch(() => [])) };
    }
    const c = costCache[acct].costs[key];
    const held = holdings?.[acct]?.tokens;
    if (c && (c.bought > 0 || c.qtyIn > 0) && held) res[acct] = { cost: c.bought > 0 ? c.cost * Math.min(1, held / c.bought) : null, unit: c.unit, invested: c.cost, received: c.sold, ...bnbView(c, quoteBnb, held) };
  }
  return res;
}

// BNB 在某一分钟的美元价(币安 1 分钟 K 线收盘价),按分钟缓存
const bnbAt = new Map();
async function bnbUsdAt(ms) {
  if (!isFinite(ms)) return null;
  const m = Math.floor(ms / 60_000) * 60_000;
  if (bnbAt.has(m)) return bnbAt.get(m);
  const cached = await loadBnbPx(m);
  if (cached) { bnbAt.set(m, cached); return cached; }
  const v = await fetch(`https://api.binance.com/api/v3/klines?symbol=BNBUSDT&interval=1m&startTime=${m}&limit=1`, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.json()).then((j) => Number(j?.[0]?.[4]) || null).catch(() => null);
  if (v) { bnbAt.set(m, v); if (Date.now() - m > 3_600_000) saveBnbPx(m, v); }   // 最近 1 小时的价格可能还会变,不存
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
      // BNB 口径:现值按底池币现价折成 BNB;剩余成本按平均成本法(早就卖光的那一轮不算进来)
      const quoteBnb = !t.quote || /^w?bnb$/i.test(t.quote) ? 1 : qUsd && now ? qUsd / now : null;
      const bv = bnbView(c, quoteBnb, bal);
      (t.bnb ??= {})[a.acct] = {
        value: t.values?.[a.acct] != null && quoteBnb ? t.values[a.acct] * quoteBnb : null,
        cost: bv?.remainingBnb ?? null,
        approx: bv?.bnbApprox ?? false,
      };
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

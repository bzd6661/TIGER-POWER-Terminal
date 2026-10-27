// 底池币兑换前的流动性门槛:BNB ↔ 底池币(ERC20 计价币)之前,看这个币在 BSC 上最深的池子有多少流动性,
// 低于门槛(默认 2 万美元,.env 里 QUOTE_MIN_LIQ_USD 可改)就不换,免得在小池子里吃大滑点。
//   查 DexScreener,结果存本机 .liq-cache.json(同一个币 6 小时内不重复查)。查不到时不拦(只提示)。
//   BNB / WBNB / USDT / USDC 不查。
import "./env.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MIN_LIQ_USD = Number(process.env.QUOTE_MIN_LIQ_USD || 20_000);
const FILE = fileURLToPath(new URL("./.liq-cache.json", import.meta.url));
const SKIP = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "0x0000000000000000000000000000000000000000",
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",   // WBNB
  "0x55d398326f99059ff775485246999027b3197955",   // USDT
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",   // USDC
]);
const load = () => { try { return JSON.parse(readFileSync(FILE, "utf8")) || {}; } catch { return {}; } };

// 返回 { liqUsd, pool, dex, with } 或 null(查不到)
export async function deepestLiq(addr) {
  const k = String(addr).toLowerCase(), all = load(), hit = all[k];
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit;
  try {
    const j = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + k, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    const pools = (j.pairs || []).filter((p) => p.chainId === "bsc").sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const p = pools[0];
    const v = { at: Date.now(), liqUsd: p?.liquidity?.usd || 0, pool: p?.pairAddress ?? null, dex: p?.dexId ?? null, with: p ? (p.baseToken.address.toLowerCase() === k ? p.quoteToken : p.baseToken).symbol : null };
    all[k] = v;
    try { writeFileSync(FILE, JSON.stringify(all, null, 1)); } catch {}
    return v;
  } catch { return hit ?? null; }
}

// 够深返回 { ok: true, info };不够深返回 { ok: false, msg };查不到返回 { ok: true, unknown: true }
export async function checkLiquid(addr, symbol) {
  if (SKIP.has(String(addr).toLowerCase())) return { ok: true };
  const r = await deepestLiq(addr);
  if (!r) return { ok: true, unknown: true };
  const name = symbol || `${String(addr).slice(0, 6)}…${String(addr).slice(-4)}`;
  if (r.liqUsd < MIN_LIQ_USD) return { ok: false, info: r, msg: `${name} 在 BSC 上最深的池子流动性只有 $${Math.round(r.liqUsd).toLocaleString("en-US")}(低于 $${MIN_LIQ_USD.toLocaleString("en-US")}),在这么小的池子里换会吃大滑点,不换` };
  return { ok: true, info: r };
}

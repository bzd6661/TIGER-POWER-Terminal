// BNB 美元价(币安现货 ticker),缓存 60 秒。只读。
let cache = { at: 0, v: null };
export async function bnbUsd() {
  if (cache.v && Date.now() - cache.at < 60_000) return cache.v;
  const v = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT", { signal: AbortSignal.timeout(8000) })
    .then((r) => r.json()).then((j) => Number(j.price)).catch(() => null);
  if (v) cache = { at: Date.now(), v };
  return v ?? cache.v;
}

// 查链上历史日志(eth_getLogs):按顺序试节点,一个失败就换下一个。
//   1. .env 里的 BSC_LOG_RPC(可选,自己的节点,比如 NodeReal)
//   2. publicnode:快,但免费版只能查最近约 1 小时(更早的要付费令牌)
//   3. 48.club:慢(5000 块要 20 秒左右),但能查到更早的区块
// 每次最多查 5000 块。
import "../env.mjs";

const NODES = [process.env.BSC_LOG_RPC, "https://bsc-rpc.publicnode.com", "https://rpc-bsc.48.club"].filter((u, i, a) => u && a.indexOf(u) === i);
export const LOG_STEP = 5000;
// 没配自己的节点时,只查公共节点能查的最近一段(约 1 小时),别去 48.club 慢慢翻几十万个块
export const HAS_PRIVATE = !!process.env.BSC_LOG_RPC;
export const PUBLIC_WINDOW = 8_000;   // publicnode 免费版能查的范围会变(实测有时不到 1.2 万块),保守取约 1 小时

async function call(url, method, params, timeoutMs) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 160));
  return j.result;
}
// logRpc(method, params):和普通 JSON-RPC 调用一样
export async function logRpc(method, params) {
  let last;
  for (const url of NODES) {
    try { return await call(url, method, params, url.includes("48.club") ? 40000 : 20000); }
    catch (e) { last = e; }
  }
  throw last ?? new Error("没有可用的日志节点");
}

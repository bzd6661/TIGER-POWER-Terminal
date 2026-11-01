// 读链用的 BSC 节点:一个节点拒绝(403 / 429 / 5xx)、超时、连不上,或者回「要 API key / 额度用完」这类节点级错误时,自动换下一个再试。
//   .env 的 BSC_RPC(自己的节点)排第一;换到公共节点后 1 分钟再回到第一个,不会一直卡在公共节点上。
//   公共节点偶尔会对某个 IP 回 403,以前脚本只认一个节点,一次失败整笔就失败了。
//   这里只管读链 / 估 gas / 等回执;签名和提交都走币安钱包,换节点不会重复下单。合约本身报错(revert)不算节点问题,照原样往上报。
import { ethers } from "ethers";

const PUBLIC = ["https://bsc-dataseed.bnbchain.org", "https://bsc-dataseed1.bnbchain.org", "https://bsc-dataseed2.bnbchain.org", "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed2.binance.org", "https://bsc-dataseed1.defibit.io", "https://bsc-dataseed1.ninicoin.io", "https://bsc-rpc.publicnode.com"];
export function bscRpcUrls() {
  const own = String(process.env.BSC_RPC || "").trim();
  return own ? [own, ...PUBLIC.filter((u) => u !== own)] : [...PUBLIC];
}
// 节点自己的问题(不是合约 / 交易的问题):换节点
const NODE_ERR = /unauthori[sz]ed|api key|apikey|usage limit|rate limit|limit exceeded|too many requests|capacity|quota|forbidden|blocked|missing response/i;
const retryable = (e) => ["SERVER_ERROR", "TIMEOUT", "NETWORK_ERROR", "BAD_DATA"].includes(e?.code) || /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|fetch failed|socket hang up/i.test(String(e?.message ?? "")) || NODE_ERR.test(String(e?.message ?? ""));
const BACK_MS = 60_000;

export class RetryProvider extends ethers.JsonRpcProvider {
  #urls; #i = 0; #movedAt = 0;
  constructor(urls, network, options) { super(urls[0], network, options); this.#urls = urls; }
  _getConnection() {
    if (this.#i !== 0 && Date.now() - this.#movedAt > BACK_MS) this.#i = 0;   // 过一会儿回到第一个(自己的节点)
    const r = new ethers.FetchRequest(this.#urls[this.#i]); r.timeout = 15_000; r.setThrottleParams({ maxAttempts: 1 }); return r;   // 429 不在同一个节点上干等,直接换
  }
  async _send(payload) {
    let last;
    const ids = (Array.isArray(payload) ? payload : [payload]).map((p) => p.id);
    for (let n = 0; n < this.#urls.length; n++) {
      try {
        const res = await super._send(payload);
        // 回包里每个请求都要有结果;节点级错误(要 key / 额度用完 …)当成这个节点坏了
        const got = new Set(res.map((x) => x?.id));
        const nodeErr = res.find((x) => x?.error && NODE_ERR.test(String(x.error.message ?? "")));
        if (nodeErr || ids.some((id) => !got.has(id))) throw Object.assign(new Error("节点回包不对:" + String(nodeErr?.error?.message ?? "缺结果").slice(0, 120)), { code: "BAD_DATA" });
        return res;
      } catch (e) {
        last = e;
        if (!retryable(e)) throw e;
        this.#i = (this.#i + 1) % this.#urls.length;   // 换下一个节点,之后的请求也先用它(1 分钟后回到第一个)
        this.#movedAt = Date.now();
      }
    }
    throw last;
  }
}
export const bscProvider = (network, options) => new RetryProvider(bscRpcUrls(), network, options);

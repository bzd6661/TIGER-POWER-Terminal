// gang CLI 的进程内版本:直接 import 官方 @gangfun/cli 的 chain.js(读链 / 报价 / 拼 calldata),
// 不再每一步都起一个 gangw.cmd → node → gang CLI 进程(每次约 2.3 秒,里面还要再调 baw 拿地址)。
// gang(args) 的输入输出和 CLI 的 token / quote / buy / sell 四个命令保持一致,脚本里只要把 gang(...) 换成 await gang(...)。
// preview 走我们自己的 bawSpawn(账号 1 直接 node 跑 baw,账号 2 用 baw2)。
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bawSpawn } from "../accounts.mjs";

function findCli() {
  // GANG_CLI_CHAIN:手动指定另一份(你自己审过的)CLI 的 chain.js;程序不会自动设置它
  if (process.env.GANG_CLI_CHAIN && existsSync(process.env.GANG_CLI_CHAIN)) return process.env.GANG_CLI_CHAIN;
  const rel = join("@gangfun", "cli", "src", "chain.js");
  const c = process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", rel);
  if (c && existsSync(c)) return c;
  const p = join(execSync("npm root -g", { encoding: "utf8" }).trim(), rel);
  if (existsSync(p)) return p;
  throw new Error("没装 gang CLI:npm i -g @gangfun/cli");
}
const chain = await import(pathToFileURL(findCli()).href);
const { tokenInfo, quoteBuy, quoteSell, resolvePad, isAgent, allowance, balanceOf, calldata, parseEther, fmt, fmtTok } = chain;

const json = (acct, args) => new Promise((res) => {
  const ps = bawSpawn(acct, [...args, "--json"]);
  let out = "";
  ps.stdout.on("data", (d) => (out += d));
  ps.on("error", () => res({ success: false, error: "baw 起不来" }));
  ps.on("close", () => { try { res(JSON.parse(out)); } catch { res({ success: false, error: out.slice(0, 300) }); } });
});

// 钱包地址:先读面板 / 脚本写的本机缓存,没有再问 baw
const addrCache = {};
async function me(acct) {
  if (addrCache[acct]) return addrCache[acct];
  const f = fileURLToPath(new URL(acct === "2" ? "../.wallet2" : "../.wallet", import.meta.url));
  try { const a = readFileSync(f, "utf8").trim(); if (/^0x[0-9a-fA-F]{40}$/.test(a)) return (addrCache[acct] = a); } catch {}
  const r = await json(acct, ["wallet", "address"]);
  const a = r?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
  if (!a) throw new Error("拿不到钱包地址:" + JSON.stringify(r?.error ?? r).slice(0, 200));
  return (addrCache[acct] = a);
}
function summarize(p, extra = {}) {
  if (!p.success) return { success: false, step: extra.step, error: p.error };
  const d = p.data;
  return { success: true, ...extra, requestId: d.requestId, expiresAt: d.expiresAt, requireConfirmation: d.requireConfirmation, risks: d.risks?.riskDetails || [] };
}
const preview = (acct, from, to, data, value = 0n) =>
  json(acct, ["contract-call", "preview", "--binanceChainId", "56", "--from", from, "--to", to, "--value", value.toString(), "--inputData", data]);
const opt = (a, n, d) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
const has = (a, n) => a.includes(`--${n}`);

export function makeGang(acct) {
  return async function gang(a) {
    try {
      const cmd = a[0], token = opt(a, "token");
      const W = await me(acct);
      if (cmd === "token") return { success: true, buyer: W, ...(await tokenInfo(token, W)) };
      if (cmd === "quote") {
        const q = await quoteBuy(token, W, opt(a, "bnb"));
        return { success: true, token, buyer: W, pad: q.pad, kind: q.kind, quote: q.quote, tokensOut: q.tokensOutFmt, spent: q.spentFmt, fee: q.feeFmt, refund: q.refundFmt, unit: q.unit };
      }
      if (cmd === "buy") {
        const bnb = opt(a, "bnb"), slippage = Number(opt(a, "slippage", "1"));
        const [info, pad, q, agent] = await Promise.all([tokenInfo(token, W), resolvePad(token), quoteBuy(token, W, bnb), isAgent(W)]);
        if (info.graduated) return { success: false, error: "已毕业,去 PancakeSwap 买" };
        if (!agent) return { success: false, error: "这个钱包没有 Agent ID,买不了" };
        if (q.tokensOut === 0n) return { success: false, error: "已买到上限或买不到" };
        const minOut = (q.tokensOut * BigInt(Math.round((100 - slippage) * 100))) / 10000n;
        if (pad.kind === "soft") {
          const p = await preview(acct, W, pad.address, calldata.softBuy(token, minOut), parseEther(bnb));
          return summarize(p, { step: "buy", kind: "soft", expectTokens: q.tokensOutFmt, expectSpent: q.spentFmt, expectRefund: q.refundFmt, minTokensOut: fmtTok(minOut) });
        }
        const quoteIn = parseEther(bnb);
        if ((await allowance(info.quote, W, pad.address)) < quoteIn) {
          const p = await preview(acct, W, info.quote, calldata.approve(pad.address, quoteIn));
          return summarize(p, { step: "approve-quote", kind: "v2", quote: info.quote, amount: bnb });
        }
        const p = await preview(acct, W, pad.address, calldata.v2Buy(token, quoteIn, minOut));
        return summarize(p, { step: "buy", kind: "v2", quote: info.quote, expectTokens: q.tokensOutFmt, expectSpent: q.spentFmt, expectRefund: q.refundFmt, minTokensOut: fmtTok(minOut) });
      }
      if (cmd === "sell") {
        const [info, pad, bal] = await Promise.all([tokenInfo(token, W), resolvePad(token), balanceOf(token, W)]);
        if (info.graduated) return { success: false, error: "已毕业,去 PancakeSwap 卖" };
        if (bal === 0n) return { success: false, error: "没有持仓" };
        const amount = has(a, "all") ? bal : parseEther(opt(a, "amount"));
        if (amount > bal) return { success: false, error: "超过持仓" };
        if ((await allowance(token, W, pad.address)) < amount) {
          const p = await preview(acct, W, token, calldata.approve(pad.address, amount));
          return summarize(p, { step: "approve", amount: fmtTok(amount) });
        }
        const slippage = Number(opt(a, "slippage", "1"));
        const q = await quoteSell(token, amount);
        const minOut = (q.out * BigInt(Math.round((100 - slippage) * 100))) / 10000n;
        const data = pad.kind === "soft" ? calldata.softSell(token, amount, minOut) : calldata.v2Sell(token, amount, minOut);
        const p = await preview(acct, W, pad.address, data);
        return summarize(p, { step: "sell", kind: pad.kind, amount: fmtTok(amount), expectOut: q.outFmt, fee: q.feeFmt, minOut: fmt(minOut) });
      }
      return { success: false, error: `gangcore 不支持 ${cmd}` };
    } catch (e) { return { success: false, error: e.message }; }
  };
}

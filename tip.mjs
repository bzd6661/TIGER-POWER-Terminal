#!/usr/bin/env node
// 打赏作者:node tip.mjs <BNB 数量> [--memo 留言] [--acct 1|2] [--app-confirm] [--dry]
//   调用打赏合约 TMTip.tip(memo)(付 BNB),合约在同一笔交易里把 BNB 原样转给作者地址 —— 合约没有管理员、不存钱。
//   走合约调用,所以不需要把作者地址加进 Binance App 地址簿;和其他脚本一样先 preview(链上模拟 + 币安风控),
//   有风险提示 / 要去 App 批准时默认不提交,加 --app-confirm 才提交(只放行「中风险」,你在 App 里确认)。
import "./env.mjs";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { takeAcct, bawSpawn } from "./accounts.mjs";

export const TIP = JSON.parse(readFileSync(new URL("./contracts/tip.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const ACCT = takeAcct(args);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry"), APP_CONFIRM = flag("--app-confirm");
const memo = String(opt("--memo") ?? "").slice(0, 140);
const [amt] = args;
const die = (m) => { console.error("✗ " + m); process.exit(1); };
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
if (!/^\d+(\.\d{1,8})?$/.test(amt ?? "") || !(Number(amt) > 0) || Number(amt) > 5) die("用法:node tip.mjs <BNB 数量,0–5> [--memo 留言] [--acct 1|2] [--app-confirm] [--dry]");

const art = JSON.parse(readFileSync(new URL("./contracts/TMTip.json", import.meta.url), "utf8"));
const I = new ethers.Interface(art.abi);
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;
const baw = (a) => new Promise((res) => {
  const ps = bawSpawn(ACCT, [...a, "--json"]); let out = "";
  ps.stdout.on("data", (d) => (out += d));
  ps.on("close", () => { try { res(JSON.parse(out)); } catch { res({ success: false, error: { message: out.slice(0, 300) } }); } });
});

// 合约还在、作者地址没被换(防止有人改了 contracts/tip.json 指到别的合约)
const author = I.decodeFunctionResult("author", await provider.call({ to: TIP.contract, data: I.encodeFunctionData("author") }))[0];
if (author.toLowerCase() !== TIP.author.toLowerCase()) die(`打赏合约的作者地址(${author})和配置(${TIP.author})对不上,不执行`);
const W = (await baw(["wallet", "address"]))?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
if (!W) die("拿不到钱包地址(这个账号登录了吗?)");
const value = ethers.parseEther(amt);
const bal = await provider.getBalance(W);
if (bal < value) die(`BNB 不够:余额 ${ethers.formatEther(bal)},要打赏 ${amt}`);
log(`打赏 ${amt} BNB → 合约 ${TIP.contract} → 作者 ${author}${memo ? `,留言「${memo}」` : ""}`);

const pv = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", TIP.contract, "--value", value.toString(), "--inputData", I.encodeFunctionData("tip", [memo])]);
if (!pv.success) die(`preview 失败:${JSON.stringify(pv.error ?? pv)}`);
if (pv.data.simulationResult?.simulationCode !== "000000000") die(`模拟没通过:${JSON.stringify(pv.data.simulationResult)}`);
const r = pv.data.risks;
const codes = [...(r?.riskDetails ?? []), ...Object.values(r?.addresses ?? {}).flatMap((x) => x?.riskDetails ?? [])].map((x) => String(x?.code ?? ""));
const mediumOnly = codes.length > 0 && codes.every((c) => /^medium_/.test(c));
if (codes.length && !(APP_CONFIRM && mediumOnly)) die(`钱包报了风险,不执行${mediumOnly ? "(只是中风险:打开「需要时去 App 确认」再试)" : ""}:${codes.join(", ")}`);
if (pv.data.requireConfirmation && !APP_CONFIRM) die("币安要求这笔去 App 批准:打开「需要时去 App 确认」再试");
if (DRY) { log("preview 通过(--dry 不执行)"); process.exit(0); }
const ex = await baw(["contract-call", "execute", "--requestId", pv.data.requestId]);
if (!ex.success) die(`execute 失败:${JSON.stringify(ex.error ?? ex)}`);
if (ex.data.status === "PENDING_CONFIRMATION") {
  log(`⏳ 已提交,请在 Binance App 里确认(orderId ${ex.data.orderId}),最多等 5 分钟…`);
  for (let i = 0; i < 100; i++) { await new Promise((res) => setTimeout(res, 3000)); if ((await provider.getBalance(W)) <= bal - value) { log("✓ 打赏完成,谢谢支持!"); process.exit(0); } }
  die("5 分钟内没看到扣款:App 里没确认 / 被拒了");
}
if (!ex.data.txHash) die(`没拿到 txHash(${ex.data.status})`);
log(`已提交 ${ex.data.txHash}`);
const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
if (!rc || rc.status !== 1) die(`没上链 / 失败:${ex.data.txHash}`);
log(`✓ 打赏完成,谢谢支持! https://bscscan.com/tx/${ex.data.txHash}`);

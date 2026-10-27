#!/usr/bin/env node
// Gang 第一代发射台卖出:node gangv1sell.mjs <CA> [CA ...] [--pct 100] [--slip 5] [--acct 1|2|both] [--app-confirm] [--dry]
//   每个 CA:按持仓 pct% 卖 → quoteSell 报价 → 授权发射台恰好这个数量(不够才授权)→ sell(token, amount, minOut) → 等上链,打印到手 BNB。
//   pct 默认 100(全卖);slip 默认 5%(内盘曲线是确定的,滑点只防卖出前别人先成交)。
import { ethers } from "ethers";
import { takeAcct, bawSpawn, runBoth } from "../accounts.mjs";

const PAD = "0x315Ba2e8952D06094CC636b2B84229FA32fb23A7";
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;   // 等回执时每 0.3 秒查一次(ethers 默认 4 秒)
const iface = new ethers.Interface([
  "function quoteSell(address,uint256) view returns (uint256 bnbOut,uint256 fee)",
  "function sell(address,uint256,uint256) returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const args = process.argv.slice(2);
const ACCT = takeAcct(args);
if (ACCT === "both") { runBoth(import.meta.url, args); await new Promise(() => {}); }
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry");
// --accept-risk:钱包给出风险提示时仍提交(打印风险原文;钱包设成「需要确认」时还要你在 Binance App 里确认)
const ACCEPT_RISK = flag("--accept-risk");
// --app-confirm:钱包要求去 Binance App 批准的交易也提交,然后等你在 App 里确认(不加就直接停)
const APP_CONFIRM = flag("--app-confirm");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = Number(opt("--pct") ?? "100"), slip = Number(opt("--slip") ?? "5");
const cas = args;
if (!cas.length || cas.some((c) => !ethers.isAddress(c)) || !(pct > 0 && pct <= 100) || !(slip >= 0 && slip < 100))
  die("用法 node gangv1sell.mjs <CA> [CA ...] [--pct 100] [--slip 5] [--acct 1|2|both] [--dry]");

function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(ACCT, [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}
const call = (to, fn, a = []) => provider.call({ to, data: iface.encodeFunctionData(fn, a) }).then((r) => iface.decodeFunctionResult(fn, r));
// 开了 --app-confirm 时,只有「中风险」提示(medium_*)放行到 App,由你在 App 里看着提示决定;高风险/钓鱼等照样拦
const mediumOnly = (list) => list.length > 0 && list.every((x) => /^medium_/.test(String(x?.code ?? "")));
// preview → 风险检查 → execute → 等上链;失败返回 null
async function send(label, W, to, data) {
  const pv = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", to, "--value", "0", "--inputData", data]);
  if (!pv.success) { log(`✗ ${label} preview 失败:${JSON.stringify(pv.error)}`); return null; }
  const r = pv.data.risks;
  if (pv.data.requireConfirmation && !APP_CONFIRM) { log(`✗ ${label} 需要去 Binance App 批准,按你的设置不提交(钱包把这笔判成了有风险的交易;要去 App 确认就勾选「需要时去 App 确认」/ 加 --app-confirm)`); return null; }
  if (pv.data.simulationResult?.simulationCode !== "000000000") { log(`✗ ${label} 模拟没通过:${JSON.stringify(pv.data.simulationResult)}`); return null; }
  if (r?.riskDetails?.length || Object.values(r?.addresses ?? {}).some((x) => x?.riskDetails?.length)) {
    log(`⚠️ ${label} 钱包风险提示:${JSON.stringify(r)}`);
    const all = [...(r?.riskDetails ?? []), ...Object.values(r?.addresses ?? {}).flatMap((x) => x?.riskDetails ?? [])];
    if (APP_CONFIRM && pv.data.requireConfirmation && mediumOnly(all)) log(`${label} 是中风险提示,已开 App 确认 → 提交,去 App 里看提示再决定`);
    else if (!ACCEPT_RISK) { log(`✗ ${label} 有风险提示,不执行(确认要卖就加 --accept-risk)`); return null; }
  }
  if (pv.data.requireConfirmation) log(`${label} 需要在 Binance App 里确认`);
  if (DRY) { log(`${label} preview 通过(--dry 不执行)`); return "dry"; }
  const ex = await baw(["contract-call", "execute", "--requestId", pv.data.requestId]);
  if (!ex.success) { log(`✗ ${label} execute 失败:${JSON.stringify(ex.error)}`); return null; }
  if (ex.data.status === "PENDING_CONFIRMATION") { log(`⏳ ${label} 已提交,请在 Binance App 里确认(orderId ${ex.data.orderId}),最多等 5 分钟…`); return { pending: true }; }
  if (!ex.data.txHash) { log(`✗ ${label} 没拿到 txHash:${JSON.stringify(ex.data)}`); return null; }
  const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
  if (!rc || rc.status !== 1) { log(`✗ ${label} ${rc ? "链上失败" : "60 秒没确认,别重复提交"}:${ex.data.txHash}`); return null; }
  return rc;
}

const addr = await baw(["wallet", "address"]);
const W = addr?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
if (!W) die(`拿不到钱包地址:${JSON.stringify(addr)}`);

let failed = 0, total = 0n;
for (const raw of cas) {
  const ca = ethers.getAddress(raw);
  const [[sym], [bal], [allow]] = await Promise.all([call(ca, "symbol").catch(() => ["?"]), call(ca, "balanceOf", [W]), call(ca, "allowance", [W, PAD])]);
  const amount = (bal * BigInt(Math.round(pct * 100))) / 10000n;
  if (amount === 0n) { log(`${sym} ${ca} 没有持仓,跳过`); continue; }
  const q = await call(PAD, "quoteSell", [ca, amount]).catch(() => null);
  // 内盘报价失败 / 为 0:多半刚毕业(面板那边还当成内盘)—— 改走外盘卖出,同样的比例
  if (!q || q.bnbOut === 0n) {
    log(`${sym} 内盘报不出价(已毕业?),改走外盘卖出(dexsell.mjs)`);
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const code = await new Promise((res) => spawn(process.execPath, [fileURLToPath(new URL("../dexsell.mjs", import.meta.url)), ca, String(pct), "--acct", ACCT, ...(DRY ? ["--dry"] : [])], { stdio: "inherit" }).on("close", res));
    if (code !== 0) failed++;
    continue;
  }
  const minOut = (q.bnbOut * BigInt(Math.round((100 - slip) * 100))) / 10000n;
  log(`${sym} ${ca}  卖 ${ethers.formatEther(amount)} 个(${pct}%),报价 ${ethers.formatEther(q.bnbOut)} BNB(手续费 ${ethers.formatEther(q.fee)}),最少 ${ethers.formatEther(minOut)}`);
  if (allow < amount) {
    if (DRY) { log(`${sym} 需要先授权 ${ethers.formatEther(amount)} 个给发射台(--dry 下授权和卖出都不做;卖出 preview 要等授权上链后才能模拟)`); continue; }
    const ok = await send(`${sym} 授权`, W, ca, iface.encodeFunctionData("approve", [PAD, amount]));
    if (!ok) { failed++; continue; }
    if (ok.pending) { for (let i = 0; i < 100 && (await call(ca, "allowance", [W, PAD]))[0] < amount; i++) await sleep(3000); }
    log(`${sym} 授权 ✓`);
  }
  const before = await provider.getBalance(W);
  const rc = await send(`${sym} 卖出`, W, PAD, iface.encodeFunctionData("sell", [ca, amount, minOut]));
  if (!rc) { failed++; continue; }
  if (rc === "dry") continue;
  if (rc.pending) {
    // 等 App 确认后上链:代币余额变少就算成交
    let left = bal;
    for (let i = 0; i < 100 && left > bal - amount; i++) { await sleep(3000); left = (await call(ca, "balanceOf", [W]))[0]; }
    if (left > bal - amount) { log(`✗ ${sym} 5 分钟内没看到成交,去 App 和 baw wallet tx-history 看看,别重复提交`); failed++; continue; }
    const got = (await provider.getBalance(W)) - before;
    total += got;
    log(`✓ ${sym} 卖出成交,BNB 余额 +${ethers.formatEther(got)}(已扣 gas)`);
    continue;
  }
  const after = await provider.getBalance(W, rc.blockNumber);
  const got = after - before + rc.gasUsed * rc.gasPrice;
  total += got;
  log(`✓ ${sym} 卖出上链 ${rc.hash}  到手 ${ethers.formatEther(got)} BNB`);
}
if (total) log(`合计到手 ${ethers.formatEther(total)} BNB`);
process.exit(failed ? 1 : 0);

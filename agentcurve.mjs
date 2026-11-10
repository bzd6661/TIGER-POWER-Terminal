#!/usr/bin/env node
// AgentCurve 单币曲线(aicurve.fun 的 AIC 等):合约自己就是代币 + 曲线,毕业前只有持 Binance Agent ID 的钱包能买卖。
//   node agentcurve.mjs buy  <CA> <BNB数量>     [--slip 5] [--acct 1|2|both] [--dry]
//   node agentcurve.mjs sell <CA> <百分比1-100> [--slip 5] [--acct 1|2|both] [--dry]
//   买:mint(minTokensOut, deadline) 付 BNB;合约单笔最多 MAX_BUY(1 BNB),超过的自动拆成几笔。接近毕业时多付的合约退回。
//   卖:redeem(tokensIn, minBnbOut, deadline),钱从曲线储备出。买完同一个钱包要隔一个区块才能卖(Cooldown)。
//   买卖各 1% 手续费(给部署者)。毕业后曲线永久关闭,改走外盘(dexbuy / dexsell,PancakeSwap V2)。
//   每笔先 eth_call 模拟,再经 baw contract-call preview(模拟 + 风控);要去 App 批准、或钱包报风险的不提交。--dry 只报价和模拟。
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { bscProvider } from "./rpc.mjs";
import { takeAcct, bawSpawn, runBoth } from "./accounts.mjs";

export const AC = new ethers.Interface([
  "function quoteBuy(uint256 bnbIn) view returns (uint256 tokensOut, uint256 reserveAdded, uint256 fee, uint256 refund)",
  "function quoteRedeem(uint256 tokensIn) view returns (uint256 bnbOut, uint256 fee)",
  "function mint(uint256 minTokensOut, uint256 deadline) payable returns (uint256)",
  "function redeem(uint256 tokensIn, uint256 minBnbOut, uint256 deadline) returns (uint256)",
  "function graduated() view returns (bool)", "function curveReserve() view returns (uint256)", "function hasAgentId(address) view returns (bool)",
  "function MAX_BUY() view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)",
  "error AgentRequired()", "error Cooldown()",
]);
const net = ethers.Network.from(56);
const provider = bscProvider(net, { staticNetwork: net });
provider.pollingInterval = 300;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const args = process.argv.slice(2);
const ACCT = takeAcct(args);
if (ACCT === "both") { runBoth(import.meta.url, args); await new Promise(() => {}); }
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry");
const slip = Number(opt("--slip") ?? "5");
const [side, ca, amt] = args;
const USAGE = "用法 node agentcurve.mjs buy <CA> <BNB数量> | sell <CA> <百分比1-100> [--slip 5] [--acct 1|2|both] [--dry]";
if (!["buy", "sell"].includes(side) || !ethers.isAddress(ca ?? "") || !(slip > 0 && slip <= 50)) die(USAGE);
if (!(/^\d+(\.\d+)?$/.test(amt ?? "") && Number(amt) > 0) || (side === "sell" && Number(amt) > 100)) die(USAGE);

function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(ACCT, [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}
const call = async (fn, a = [], extra = {}) => AC.decodeFunctionResult(fn, await provider.call({ to: ca, data: AC.encodeFunctionData(fn, a), ...extra }));
const minOf = (x) => (x * BigInt(Math.round((100 - slip) * 100))) / 10000n;
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600);
function why(e) {
  try {
    const d = AC.parseError(e?.data ?? e?.info?.error?.data);
    const m = { AgentRequired: "这个钱包没有 Agent ID,毕业前买卖不了", Cooldown: "刚买完,要隔一个区块才能卖,稍等再卖" }[d?.name];
    if (m) return m;
    if (d) return d.name;
  } catch {}
  return e?.shortMessage ?? e?.message ?? String(e);
}

let W = null;
try { W = readFileSync(new URL(ACCT === "2" ? "./.wallet2" : "./.wallet", import.meta.url), "utf8").trim(); } catch {}
if (!/^0x[0-9a-fA-F]{40}$/.test(W ?? "")) W = (await baw(["wallet", "address"]))?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
if (!W) die("拿不到钱包地址");

let grad;
try { grad = (await call("graduated"))[0]; await call("curveReserve"); } catch { die("不是 AgentCurve 曲线币"); }
const sym = await call("symbol").then((r) => r[0]).catch(() => "?");

// 已毕业:转到外盘脚本(同样的账号、数量)
if (grad) {
  log(`${sym} 已经毕业,曲线关闭,改走外盘(${side === "buy" ? "dexbuy" : "dexsell"}.mjs)`);
  const ps = spawn(process.execPath, [fileURLToPath(new URL(`./dex${side}.mjs`, import.meta.url)), ca, amt, "--acct", ACCT, ...(DRY ? ["--dry"] : [])], { stdio: "inherit" });
  ps.on("close", (code) => process.exit(code ?? 1));
  await new Promise(() => {});
}
if (!(await call("hasAgentId", [W]))[0]) die(`钱包 ${W} 没有 Agent ID,毕业前买卖不了(先在 Binance App 领 .ai ID)`);

// 执行一笔:baw preview → 检查 → execute → 等上链。--dry 返回 null
async function run(label, data, value = 0n) {
  const p = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", ca, "--value", value.toString(), "--inputData", data]);
  if (!p.success) die(`${label} preview 失败:${JSON.stringify(p.error ?? p).slice(0, 300)}`);
  const risks = p.data.risks?.riskDetails || [];
  if (p.data.requireConfirmation) die(`${label} 要去 Binance App 批准(钱包判成了有风险的交易),不提交`);
  if (risks.length) die(`${label} 钱包有风险提示,不执行:${JSON.stringify(risks).slice(0, 200)}`);
  if (DRY) { log(`${label} preview 通过(--dry 不执行)`); return null; }
  const ex = await baw(["contract-call", "execute", "--requestId", p.data.requestId]);
  if (!ex.success) die(`${label} execute 失败:${JSON.stringify(ex.error ?? ex).slice(0, 300)}`);
  if (!ex.data.txHash) die(`${label} 没拿到 txHash(${ex.data.status}),去 Binance App 看一下,别重复提交`);
  log(`${label} 已提交 ${ex.data.txHash}`);
  const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
  if (!rc) die(`${label} 60 秒没确认,别重复提交:${ex.data.txHash}`);
  if (rc.status !== 1) die(`${label} 链上失败:${ex.data.txHash}`);
  log(`${label} ✓ 上链 区块 ${rc.blockNumber}`);
  return rc;
}

if (side === "buy") {
  const total = ethers.parseEther(amt), max = (await call("MAX_BUY"))[0];
  const bal = await provider.getBalance(W);
  if (bal < total) die(`BNB 不够:有 ${ethers.formatEther(bal)},要 ${amt}(钱没动)`);
  const parts = [];
  for (let left = total; left > 0n; left -= left > max ? max : left) parts.push(left > max ? max : left);
  if (parts.length > 1) log(`单笔最多 ${ethers.formatEther(max)} BNB,拆成 ${parts.length} 笔`);
  for (const [i, v] of parts.entries()) {
    const label = parts.length > 1 ? `买入 ${i + 1}/${parts.length}` : "买入";
    const q = await call("quoteBuy", [v]);
    if (q.tokensOut === 0n) die("曲线已经卖完 / 买不到了");
    const minOut = minOf(q.tokensOut);
    log(`${sym} ${ca}  付 ${ethers.formatEther(v)} BNB,预计 ${ethers.formatEther(q.tokensOut)} 个,最少 ${ethers.formatEther(minOut)}(滑点 ${slip}%,手续费 ${ethers.formatEther(q.fee)} BNB${q.refund * 100n > v ? `,退回 ${ethers.formatEther(q.refund)} BNB` : ""})`);
    try { await call("mint", [minOut, deadline()], { from: W, value: v }); } catch (e) { die(`模拟失败:${why(e)}(钱没动)`); }
    await run(label, AC.encodeFunctionData("mint", [minOut, deadline()]), v);
    if (q.refund * 100n > v) break;   // 已经到毕业点,后面的不用再买
  }
  if (!DRY) log(`✓ 完成  现在持有 ${ethers.formatEther((await call("balanceOf", [W]))[0])} 个 ${sym}`);
} else {
  const bal = (await call("balanceOf", [W]))[0];
  if (bal === 0n) die(`${W} 没有 ${sym}`);
  const amount = Number(amt) >= 100 ? bal : (bal * BigInt(Math.round(Number(amt) * 100))) / 10000n;
  const q = await call("quoteRedeem", [amount]);
  const minOut = minOf(q.bnbOut);
  log(`${sym} ${ca}  卖 ${ethers.formatEther(amount)} 个(${amt}%),预计拿回 ${ethers.formatEther(q.bnbOut)} BNB(已扣手续费 ${ethers.formatEther(q.fee)}),最少 ${ethers.formatEther(minOut)}(滑点 ${slip}%)`);
  try { await call("redeem", [amount, minOut, deadline()], { from: W }); } catch (e) { die(`模拟失败:${why(e)}(钱没动)`); }
  const rc = await run("卖出", AC.encodeFunctionData("redeem", [amount, minOut, deadline()]));
  if (rc) log(`✓ 完成  剩 ${ethers.formatEther((await call("balanceOf", [W]))[0])} 个 ${sym}`);
}

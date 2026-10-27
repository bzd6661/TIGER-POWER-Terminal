#!/usr/bin/env node
// 转账:node transfer.mjs <CA|BNB> --to <地址> [--amount <数量>|max] [--acct 1|2|both] [--app-confirm] [--dry]
//   不给 --amount(或 max)= 转全部持仓;给了就转这么多(代币按代币个数,BNB 按 BNB)。
//   BNB:走币安钱包自己的 wallet send(收款地址要先加进 Binance App 的地址簿;max = 全部减掉 gas),没有预览,--dry 只检查余额。
//   ID Agent:已发币(phase=3)且有没领的份额,先 Portal.claim 领成代币再转;还没发币就退出码 3(「还没发射」)。
//   其他平台:直接转钱包里的全部余额(ERC20 transfer)。
//   gas 上限 = 预估 × 1.5(four 这类币转账 gas 波动大,按默认估容易不够);预估失败用 800000。
//   和其他脚本一样:preview 模拟不过 / 有风险提示 / 要去 App 批准,都不提交。
//   --app-confirm:风险提示全是「中风险」(medium_*,比如币安把代币合约标成风险地址)时也提交,由你在 Binance App 里看着提示确认;
//                 高风险 / 钓鱼等照样拦。提交后最多等 5 分钟,看到余额减少才算完成。
//   面板的「发射后自动转出」就是调这个脚本。
import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { takeAcct, bawSpawn, runBoth } from "./accounts.mjs";

const FACTORY = "0xC55820f24015bE7c4f18949D9e1363A3609B300e";   // ID Agent 工厂
const PORTAL = "0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062";
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;   // 等回执时每 0.3 秒查一次(ethers 默认 4 秒)
const iface = new ethers.Interface([
  "function marketOfToken(address) view returns (address)",
  "function phase() view returns (uint8)",
  "function token() view returns (address)",
  "function sharesOf(address) view returns (uint256)",
  "function claim(address) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
]);
const call = (to, fn, a = []) => provider.call({ to, data: iface.encodeFunctionData(fn, a) }).then((r) => iface.decodeFunctionResult(fn, r)[0]);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const die = (m, code = 1) => { console.error(`✗ ${m}`); process.exit(code); };

const args = process.argv.slice(2);
const ACCT = takeAcct(args);
if (ACCT === "both") { runBoth(import.meta.url, args); await new Promise(() => {}); }
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry");
const APP_CONFIRM = flag("--app-confirm");
const TO = opt("--to");
const AMOUNT = opt("--amount");
const [ca] = args;
const IS_BNB = /^bnb$/i.test(ca ?? "");
if (!ca || !(IS_BNB || ethers.isAddress(ca)) || !TO || !ethers.isAddress(TO)) die("用法 node transfer.mjs <CA|BNB> --to <地址> [--amount <数量>|max] [--acct 1|2|both] [--app-confirm] [--dry]");
if (AMOUNT !== null && AMOUNT !== "max" && !(/^\d+(\.\d+)?$/.test(AMOUNT) && Number(AMOUNT) > 0)) die("--amount 要是正数或 max");
const PART = AMOUNT !== null && AMOUNT !== "max";

function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(ACCT, [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}
const WALLET_CACHE = new URL(ACCT === "2" ? "./.wallet2" : "./.wallet", import.meta.url);
async function wallet() {
  try { const a = readFileSync(WALLET_CACHE, "utf8").trim(); if (ethers.isAddress(a)) return a; } catch {}
  const r = await baw(["wallet", "address"]);
  const a = r?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
  if (!a) die("拿不到钱包地址:" + JSON.stringify(r?.error ?? r));
  try { writeFileSync(WALLET_CACHE, a); } catch {}
  return a;
}
// preview → 检查 → execute → 等上链
async function send(label, W, to, data) {
  let gas = 800_000n;
  try { gas = ((await provider.estimateGas({ from: W, to, data })) * 15n) / 10n; } catch {}
  if (gas < 60_000n) gas = 60_000n;
  if (gas > 1_500_000n) gas = 1_500_000n;
  const pv = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", to, "--value", "0", "--inputData", data, "--gasLimit", gas.toString()]);
  if (!pv.success) die(`${label} preview 失败:${JSON.stringify(pv.error ?? pv)}`);
  const r = pv.data.risks;
  if (pv.data.simulationResult?.simulationCode !== "000000000") die(`${label} 模拟没通过:${JSON.stringify(pv.data.simulationResult)}`);
  const codes = [...(r?.riskDetails ?? []), ...Object.values(r?.addresses ?? {}).flatMap((x) => x?.riskDetails ?? [])].map((x) => String(x?.code ?? ""));
  const mediumOnly = codes.length > 0 && codes.every((c) => /^medium_/.test(c));
  if (codes.length) {
    if (!(APP_CONFIRM && mediumOnly)) die(`${label} 钱包报了风险,不执行${mediumOnly ? "(只是中风险:确认要转就加 --app-confirm,再去 App 里确认)" : ""}:${JSON.stringify(r)}`);
    log(`⚠️ ${label} 钱包中风险提示:${codes.join(", ")} —— 已开 --app-confirm,提交后去 Binance App 看提示再决定`);
  }
  if (pv.data.requireConfirmation && !APP_CONFIRM) die(`${label} 需要去 Binance App 批准,按你的设置不提交(确认要转就加 --app-confirm)`);
  if (DRY) { log(`${label} preview 通过(gas 上限 ${gas},--dry 不执行)`); return null; }
  const ex = await baw(["contract-call", "execute", "--requestId", pv.data.requestId]);
  if (!ex.success) die(`${label} execute 失败:${JSON.stringify(ex.error ?? ex)}`);
  if (ex.data.status === "PENDING_CONFIRMATION") { log(`⏳ ${label} 已提交,请在 Binance App 里确认(orderId ${ex.data.orderId}),最多等 5 分钟…`); return { pending: true }; }
  if (!ex.data.txHash) die(`${label} 没拿到 txHash(${ex.data.status}),去 App 看看`);
  log(`${label} 已提交 ${ex.data.txHash}`);
  const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
  if (!rc) die(`${label} 60 秒没确认,别重复提交:${ex.data.txHash}`);
  if (rc.status !== 1) die(`${label} 链上失败:${ex.data.txHash}`);
  log(`${label} ✓ 上链 区块 ${rc.blockNumber}`);
  return ex.data.txHash;
}

const W = await wallet();
if (W.toLowerCase() === TO.toLowerCase()) die("目标地址就是这个钱包自己");

// BNB:币安钱包 wallet send(地址簿限制由币安那边管)
if (IS_BNB) {
  const bal = await provider.getBalance(W);
  const want = PART ? ethers.parseEther(AMOUNT) : null;
  if (want !== null && want > bal) die(`BNB 不够:余额 ${ethers.formatEther(bal)},要转 ${AMOUNT}`);
  if (bal === 0n) die("钱包里没有 BNB", 4);
  log(`BNB 转 ${PART ? AMOUNT : "全部(扣掉 gas)"} → ${TO}(余额 ${ethers.formatEther(bal)})`);
  if (DRY) { log("--dry:余额够,不执行(BNB 走币安钱包 send,没有预览)"); process.exit(0); }
  const r = await baw(["wallet", "send", "--binanceChainId", "56", "--tokenAddress", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "--recipient", TO, ...(PART ? ["--amount", AMOUNT] : ["--max"])]);
  if (!r?.success) {
    const t = JSON.stringify(r?.error ?? r);
    die(`币安钱包没发出去:${t}${/address.?book|whitelist|地址簿/i.test(t) ? "\n  → 先在 Binance App 的地址簿里加上这个收款地址,再转" : ""}`);
  }
  const h = r.data?.txHash ?? r.data?.hash ?? null;
  if (!h) { log(`已提交:${JSON.stringify(r.data)}`); process.exit(0); }
  log(`已提交 ${h}`);
  const rc = await provider.waitForTransaction(h, 1, 60_000).catch(() => null);
  if (!rc) die(`60 秒没确认,别重复提交:${h}`);
  if (rc.status !== 1) die(`链上失败:${h}`);
  log(`✓ 转出完成 ${h}  钱包剩 ${ethers.formatEther(await provider.getBalance(W))} BNB`);
  console.log(`__TX__ ${h} ${PART ? AMOUNT : "max"}`);
  process.exit(0);
}
let token = ethers.getAddress(ca);

// ID Agent:还没发币不能转;发了先把份额领出来
const market = await call(FACTORY, "marketOfToken", [token]).catch(() => ethers.ZeroAddress);
if (market !== ethers.ZeroAddress) {
  const phase = await call(market, "phase");
  if (phase !== 3n) die(`ID Agent 还没发射(phase=${phase})`, 3);
  token = await call(market, "token");
  const shares = await call(market, "sharesOf", [W]);
  if (shares > 0n) {
    log(`已发币,先领取 ${ethers.formatUnits(shares, 18)} 份 → ${token}`);
    await send("领取", W, PORTAL, iface.encodeFunctionData("claim", [market]));
    if (DRY) { log("--dry:领取之后才知道到账多少,先停在这里"); process.exit(0); }
  }
}

const [bal, dec, sym] = await Promise.all([call(token, "balanceOf", [W]), call(token, "decimals").catch(() => 18n), call(token, "symbol").catch(() => "?")]);
if (bal === 0n) die(`钱包里没有 ${sym}`, 4);
let amt = bal;
if (PART) {
  try { amt = ethers.parseUnits(AMOUNT, dec); } catch { die(`数量 ${AMOUNT} 小数位太多(${sym} 只有 ${dec} 位)`); }
  if (amt > bal) die(`${sym} 不够:持有 ${ethers.formatUnits(bal, dec)},要转 ${AMOUNT}`);
}
log(`${sym} ${token}  转 ${ethers.formatUnits(amt, dec)} 个${amt === bal ? "(全部)" : `(持有 ${ethers.formatUnits(bal, dec)})`}→ ${TO}`);
let h = await send("转出", W, token, iface.encodeFunctionData("transfer", [TO, amt]));
if (h?.pending) {
  // 等你在 App 里确认:余额减少就算成交(拿不到 txHash,去 BscScan 看)
  let left = bal;
  for (let i = 0; i < 100 && left > bal - amt; i++) { await new Promise((r) => setTimeout(r, 3000)); left = await call(token, "balanceOf", [W]).catch(() => bal); }
  if (left > bal - amt) die("5 分钟内余额没变:App 里没确认 / 被拒了。要转就重跑一次");
  log(`✓ 转出完成(App 确认)钱包剩 ${ethers.formatUnits(left, dec)} 个,去 BscScan 看这个钱包的最新转账`);
  process.exit(0);
}
if (h) {
  const left = await call(token, "balanceOf", [W]);
  log(`✓ 转出完成 ${h}  钱包剩 ${ethers.formatUnits(left, dec)} 个`);
  console.log(`__TX__ ${h} ${ethers.formatUnits(amt, dec)}`);
}

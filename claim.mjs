#!/usr/bin/env node
// ID Agent 发射后领取份额:node claim.mjs <CA 或 market> [--acct 1|2|both] [--dry]
//   内盘阶段买到的是「份额」;开盘(phase=3)后要 Portal.claim(market) 才变成钱包里的代币。只领自己的,不转走任何东西。
//   还没开盘 → 退出码 3;没有可领的份额 → 退出码 4。和其他脚本一样:preview 模拟不过 / 有风险提示 / 要去 App 批准,都不提交。
import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { takeAcct, bawSpawn, runBoth } from "./accounts.mjs";

const FACTORY = "0xC55820f24015bE7c4f18949D9e1363A3609B300e";
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
  "function symbol() view returns (string)",
]);
const call = (to, fn, a = []) => provider.call({ to, data: iface.encodeFunctionData(fn, a) }).then((r) => iface.decodeFunctionResult(fn, r)[0]);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const die = (m, code = 1) => { console.error(`✗ ${m}`); process.exit(code); };

const args = process.argv.slice(2);
const ACCT = takeAcct(args);
if (ACCT === "both") { runBoth(import.meta.url, args); await new Promise(() => {}); }
const DRY = args.includes("--dry");
const [target] = args.filter((a) => !a.startsWith("--"));
if (!target || !ethers.isAddress(target)) die("用法 node claim.mjs <CA 或 market> [--acct 1|2|both] [--dry]");

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

const W = await wallet();
// 传进来的可能是代币地址(预测地址)也可能直接是 market
let market = await call(FACTORY, "marketOfToken", [target]).catch(() => ethers.ZeroAddress);
if (market === ethers.ZeroAddress) market = target;
const phase = await call(market, "phase").catch(() => null);
if (phase === null) die("这不是 ID Agent 的币 / 市场");
if (phase !== 3n) die(`还没开盘(phase=${phase}),不能领取`, 3);
const shares = await call(market, "sharesOf", [W]);
if (shares === 0n) die("没有可领的份额", 4);
const token = await call(market, "token");
const sym = await call(token, "symbol").catch(() => "?");
log(`${sym} 已开盘,领取 ${ethers.formatUnits(shares, 18)} 份 → ${token}`);
const data = iface.encodeFunctionData("claim", [market]);
const pv = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", PORTAL, "--value", "0", "--inputData", data]);
if (!pv.success) die(`领取 preview 失败:${JSON.stringify(pv.error ?? pv)}`);
const r = pv.data.risks;
if (pv.data.simulationResult?.simulationCode !== "000000000") die(`领取模拟没通过:${JSON.stringify(pv.data.simulationResult)}`);
if (r?.riskDetails?.length || Object.values(r?.addresses ?? {}).some((x) => x?.riskDetails?.length)) die(`领取 钱包报了风险,不执行:${JSON.stringify(r)}`);
if (pv.data.requireConfirmation) die("领取 需要去 Binance App 批准,按你的设置不提交");
if (DRY) { log("领取 preview 通过(--dry 不执行)"); process.exit(0); }
const ex = await baw(["contract-call", "execute", "--requestId", pv.data.requestId]);
if (!ex.success) die(`领取 execute 失败:${JSON.stringify(ex.error ?? ex)}`);
if (!ex.data.txHash) die(`领取 没拿到 txHash(${ex.data.status})`);
log(`领取 已提交 ${ex.data.txHash}`);
const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
if (!rc) die(`领取 60 秒没确认,别重复提交:${ex.data.txHash}`);
if (rc.status !== 1) die(`领取 链上失败:${ex.data.txHash}`);
const bal = await call(token, "balanceOf", [W]);
log(`✓ 领取完成 钱包里现在有 ${ethers.formatUnits(bal, 18)} 个 ${sym}`);
console.log(`__TX__ ${ex.data.txHash} ${ethers.formatUnits(shares, 18)}`);

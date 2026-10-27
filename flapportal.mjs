#!/usr/bin/env node
// Flap 普通 Portal 内盘买卖(包括 Agent ID 门槛盘):
//   node flapportal.mjs buy  <CA> <BNB数量>  [--slip 10] [--acct 1|2|both] [--dry]
//   node flapportal.mjs sell <CA> <百分比1-100> [--slip 10] [--acct 1|2|both] [--dry]
//   门槛盘:Portal 按交易发起人检查是否持有指定 NFT(大多是币安 Agent ID),没有就跳过这个钱包(不发交易);每个地址最多买总量 2%。
//   底池币不是 BNB 的盘,Portal 支持直接付 BNB / 卖成 BNB(nativeSwap)时照样用 BNB;不支持就停。
//   交易都先经 baw contract-call preview(模拟 + 风控);要去 App 批准、或钱包报风险的不提交。--dry 只报价和模拟。
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { takeAcct, bawSpawn, runBoth } from "./accounts.mjs";

const PORTAL = "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0";
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;
const P = new ethers.Interface([
  "function nftGate(address) view returns (address)",
  "function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount)) returns (uint256)",
  "function buyQuotaOf(address token,address origin) view returns (uint256 bought,uint256 remaining)",
  "function swapExactInput((address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,bytes permitData)) payable returns (uint256)",
  "error NFTGatedOnly(address)", "error BuyCapExceeded(address,uint256,uint256)", "error SlippageTooHigh(uint256,uint256)", "error TokenNotTradable(address)",
]);
const E = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256)", "function symbol() view returns (string)", "function name() view returns (string)"]);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const args = process.argv.slice(2);
const ACCT = takeAcct(args);
if (ACCT === "both") { runBoth(import.meta.url, args); await new Promise(() => {}); }
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry");
const slip = Number(opt("--slip") ?? "10");
const [side, ca, amt] = args;
const USAGE = "用法 node flapportal.mjs buy <CA> <BNB数量> | sell <CA> <百分比1-100> [--slip 10] [--acct 1|2|both] [--dry]";
if (!["buy", "sell"].includes(side) || !ethers.isAddress(ca ?? "") || !(Number(amt) > 0) || !(slip > 0 && slip <= 50)) die(USAGE);
if (side === "sell" && !(Number(amt) <= 100)) die(USAGE);

function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(ACCT, [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}
const call = async (to, iface, fn, a, from) => iface.decodeFunctionResult(fn, await provider.call({ to, data: iface.encodeFunctionData(fn, a), ...(from ? { from } : {}) }));
// 合约回滚原因翻成人话
function why(e) {
  const data = e?.data ?? e?.info?.error?.data;
  try {
    const d = P.parseError(data);
    if (d?.name === "NFTGatedOnly") return "这个钱包没有门槛要求的 NFT";
    if (d?.name === "BuyCapExceeded") return "超过单地址 2% 的买入上限";
    if (d?.name === "SlippageTooHigh") return "价格变动超过滑点";
    if (d?.name === "TokenNotTradable") return "这个币现在不能在内盘交易(可能已发射)";
  } catch {}
  return e?.shortMessage ?? e?.message ?? String(e);
}

let W = null;
try { W = readFileSync(new URL(ACCT === "2" ? "./.wallet2" : "./.wallet", import.meta.url), "utf8").trim(); } catch {}
if (!/^0x[0-9a-fA-F]{40}$/.test(W ?? "")) W = (await baw(["wallet", "address"]))?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
if (!W) die("拿不到钱包地址");

// 状态:getTokenV8Safe(字 0 status,字 9 报价币,字 10 能否直接用 BNB)
const raw = await provider.call({ to: PORTAL, data: "0x62fafcca" + ethers.zeroPadValue(ca, 32).slice(2) });
const word = (i) => BigInt("0x" + raw.slice(2 + 64 * i, 2 + 64 * (i + 1)));
if (!raw || raw.length < 2 + 64 * 11 || word(0) === 0n) die("不是 Flap Portal 上的盘");
if (word(0) !== 1n) die("这个币已经发射到外盘了,请用外盘买卖(dexbuy / dexsell)");
const quote = "0x" + word(9).toString(16).padStart(64, "0").slice(-40);
if (BigInt(quote) !== 0n && word(10) === 0n) die(`底池币是 ${quote},这个盘不支持直接用 BNB 买卖,暂不支持`);
const sym = await call(ca, E, "symbol", []).then((r) => r[0]).catch(() => "?");

// 门槛:没有 NFT 的钱包直接跳过
const nft = (await call(PORTAL, P, "nftGate", [ca]))[0];
if (nft !== ethers.ZeroAddress) {
  const n = (await call(nft, E, "balanceOf", [W]))[0];
  if (n === 0n) die(`钱包 ${W} 没有门槛要求的 NFT(${nft}${nft.toLowerCase() === "0x60b9262456de011f7d15a54cdd8c48baaa8b022f" ? ",币安 Agent ID" : ""}),跳过这个钱包,没有发交易`);
  log(`门槛盘:钱包持有 ${n} 个要求的 NFT`);
}

async function run(label, to, data, value = 0n) {
  const p = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", to, "--value", value.toString(), "--inputData", data]);
  if (!p.success) die(`${label} preview 失败:${JSON.stringify(p.error ?? p).slice(0, 300)}`);
  if (p.data.requireConfirmation) die(`${label} 要去 Binance App 批准(钱包判成了有风险的交易),按你的设置不提交`);
  const risks = p.data.risks?.riskDetails || [];
  if (risks.length) die(`${label} 钱包报了风险,不执行:${JSON.stringify(risks)}`);
  if (DRY) { log(`${label} preview 通过(--dry 不执行)`); return null; }
  const ex = await baw(["contract-call", "execute", "--requestId", p.data.requestId]);
  if (!ex.success) die(`${label} execute 失败:${JSON.stringify(ex.error ?? ex).slice(0, 300)}`);
  if (!ex.data.txHash) die(`${label} 没拿到 txHash(${ex.data.status}),去 Binance App 看一下,别重复提交`);
  log(`${label} 已提交 ${ex.data.txHash}`);
  const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
  if (!rc) die(`${label} 60 秒没确认,别重复提交:${ex.data.txHash}`);
  if (rc.status !== 1) die(`${label} 链上失败:${ex.data.txHash}`);
  log(`${label} ✓ 上链 ${ex.data.txHash}`);
  return rc;
}
const minOf = (out) => (out * BigInt(10000 - Math.min(9900, Math.round(slip * 100)))) / 10000n;

if (side === "buy") {
  const value = ethers.parseEther(String(amt));
  const [, remaining] = await call(PORTAL, P, "buyQuotaOf", [ca, W]);
  if (remaining === 0n) die("这个钱包在这个币上已经买到 2% 上限了");
  let out;
  try { out = (await call(PORTAL, P, "quoteExactInput", [[ethers.ZeroAddress, ca, value]], W))[0]; } catch (e) { die(`报价失败:${why(e)}`); }
  if (out === 0n) die("报价是 0(多半是 2% 额度用完了)");
  const minOut = minOf(out);
  log(`${sym} ${ca}  ${amt} BNB → 约 ${ethers.formatEther(out)} 个,最少 ${ethers.formatEther(minOut)}(滑点 ${slip}%)${remaining !== ethers.MaxUint256 ? `,还能买 ${ethers.formatEther(remaining)} 个(超出部分同一笔退回 BNB)` : ""}`);
  const data = P.encodeFunctionData("swapExactInput", [[ethers.ZeroAddress, ca, value, minOut, "0x"]]);
  try { await provider.call({ from: W, to: PORTAL, data, value }); } catch (e) { die(`模拟失败:${why(e)}(钱没动)`); }
  const rc = await run("买入", PORTAL, data, value);
  if (rc) log(`✓ ${sym} 买入成交,现在持有 ${ethers.formatEther((await call(ca, E, "balanceOf", [W]))[0])} 个`);
} else {
  const bal = (await call(ca, E, "balanceOf", [W]))[0];
  if (bal === 0n) die(`${W} 没有 ${sym}`);
  const amount = Number(amt) >= 100 ? bal : (bal * BigInt(Math.round(Number(amt) * 100))) / 10000n;
  const allow = (await call(ca, E, "allowance", [W, PORTAL]))[0];
  if (allow < amount) {
    log(`先授权 ${ethers.formatEther(amount)} 个 ${sym} 给 Flap Portal(只授权这次卖出的数量)`);
    if (DRY) { log("--dry:需要先授权,授权和卖出都不做(卖出要等授权上链后才能模拟)"); process.exit(0); }
    await run("授权", ca, E.encodeFunctionData("approve", [PORTAL, amount]));
  }
  let out;
  try { out = (await call(PORTAL, P, "quoteExactInput", [[ca, ethers.ZeroAddress, amount]], W))[0]; } catch (e) { die(`报价失败:${why(e)}`); }
  const minOut = minOf(out);
  log(`${sym} 卖 ${ethers.formatEther(amount)} 个(${amt}%)→ 约 ${ethers.formatEther(out)} BNB,最少 ${ethers.formatEther(minOut)}(滑点 ${slip}%)`);
  const data = P.encodeFunctionData("swapExactInput", [[ca, ethers.ZeroAddress, amount, minOut, "0x"]]);
  try { await provider.call({ from: W, to: PORTAL, data }); } catch (e) { die(`模拟失败:${why(e)}`); }
  const before = await provider.getBalance(W);
  const rc = await run("内盘卖出", PORTAL, data);
  if (rc) log(`✓ ${sym} 卖出成交,BNB 余额 +${ethers.formatEther((await provider.getBalance(W)) - before)}(已扣 gas)`);
}

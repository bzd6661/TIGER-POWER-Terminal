#!/usr/bin/env node
// Gang 第一代发射台(BNB 计价)一键买满:node gangv1buy.mjs <CA> [CA ...] [--tokens 数量] [--buffer 3] [--slip 1] [--acct 1|2|both] [--dry]
//   发射台 0x315Ba2e8…23A7(Gang 官方 MainnetAddresses.sol 里的 LAUNCHPAD;gang CLI 0.2.1 不认识它)。
//   每个 CA:walletRoom 看还能买多少 → quoteBuy 算要多少 BNB → 多带 buffer%(多付的合约会退回)→ buy(token, minOut) → 等上链。
//   已经买满的币自动跳过。多个 CA 按顺序买。
import { ethers } from "ethers";
import { takeAcct, bawSpawn, runBoth } from "../accounts.mjs";

const PAD = "0x315Ba2e8952D06094CC636b2B84229FA32fb23A7";
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
provider.pollingInterval = 300;   // 等回执时每 0.3 秒查一次(ethers 默认 4 秒)
const iface = new ethers.Interface([
  "function walletRoom(address,address) view returns (uint256)",
  "function quoteBuy(address,address,uint256) view returns (uint256 tokensOut,uint256 bnbIn,uint256 fee,uint256 refund)",
  "function isAgent(address) view returns (bool)",
  "function buy(address,uint256) payable returns (uint256)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
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
const wantTokens = opt("--tokens");
const buffer = Number(opt("--buffer") ?? "3"), slip = Number(opt("--slip") ?? "1");
const cas = args;
if (!cas.length || cas.some((c) => !ethers.isAddress(c))) die("用法 node gangv1buy.mjs <CA> [CA ...] [--tokens 数量] [--buffer 3] [--slip 1] [--acct 1|2|both] [--dry]");

function baw(a) {
  return new Promise((res, rej) => {
    const ps = bawSpawn(ACCT, [...a, "--json"]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d));
    ps.on("close", () => { try { res(JSON.parse(out)); } catch { rej(new Error(out.slice(0, 300))); } });
  });
}
const call = (to, fn, a = []) => provider.call({ to, data: iface.encodeFunctionData(fn, a) }).then((r) => iface.decodeFunctionResult(fn, r));

const addr = await baw(["wallet", "address"]);
const W = addr?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
if (!W) die(`拿不到钱包地址:${JSON.stringify(addr)}`);
if (!(await call(PAD, "isAgent", [W]))[0]) die(`钱包 ${W} 没有 Agent ID,Gang 内盘买不了`);

let failed = 0;
for (const raw of cas) {
  const ca = ethers.getAddress(raw);
  const [[sym], [room]] = await Promise.all([call(ca, "symbol").catch(() => ["?"]), call(PAD, "walletRoom", [ca, W])]);
  if (room === 0n) { log(`${sym} ${ca} 已经买满,跳过`); continue; }
  let target = wantTokens ? ethers.parseEther(wantTokens) : room;
  // 要买的超过剩余额度(单钱包 1% 上限):自动缩到剩余额度,买满为止
  if (target > room) { log(`${sym} 要买 ${ethers.formatEther(target)} 个,超过剩余额度,按剩余 ${ethers.formatEther(room)} 个买`); target = room; }
  // 用 10 BNB 询价:超出目标的部分会显示为退款,bnbIn + fee 就是买满所需
  const q = await call(PAD, "quoteBuy", [ca, W, ethers.parseEther("10")]);
  if (q.tokensOut === 0n) { log(`${sym} 报价为 0(已毕业或暂停?),跳过`); failed++; continue; }
  let need = q.bnbIn + q.fee;
  if (wantTokens && q.tokensOut > target) need = (need * target) / q.tokensOut;
  const value = (need * BigInt(Math.round((100 + buffer) * 100))) / 10000n;
  const outTarget = q.tokensOut < target ? q.tokensOut : target;
  const minOut = (outTarget * BigInt(Math.round((100 - slip) * 100))) / 10000n;
  log(`${sym} ${ca}  买 ${ethers.formatEther(outTarget)} 个,约需 ${ethers.formatEther(need)} BNB,发送 ${ethers.formatEther(value)}(多的退回),最少 ${ethers.formatEther(minOut)}`);

  const data = iface.encodeFunctionData("buy", [ca, minOut]);
  const pv = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", PAD, "--value", value.toString(), "--inputData", data]);
  if (!pv.success) { log(`✗ ${sym} preview 失败:${JSON.stringify(pv.error)}`); failed++; continue; }
  const r = pv.data.risks;
  if (pv.data.requireConfirmation) { log(`✗ ${sym} 需要去 Binance App 批准,按你的设置不提交(钱包把这笔判成了有风险的交易)`); failed++; continue; }
  if (pv.data.simulationResult?.simulationCode !== "000000000" || r?.riskDetails?.length || Object.values(r?.addresses ?? {}).some((x) => x?.riskDetails?.length)) {
    log(`✗ ${sym} 模拟没通过或钱包报了风险,不执行:${JSON.stringify({ sim: pv.data.simulationResult?.simulationCode, risks: r })}`); failed++; continue;
  }
  if (DRY) { log(`${sym} preview 通过(--dry 不执行)`); continue; }
  const ex = await baw(["contract-call", "execute", "--requestId", pv.data.requestId]);
  if (!ex.success || !ex.data.txHash) { log(`✗ ${sym} execute 失败:${JSON.stringify(ex.error ?? ex.data)}`); failed++; continue; }
  const rc = await provider.waitForTransaction(ex.data.txHash, 1, 60_000).catch(() => null);
  if (!rc || rc.status !== 1) { log(`✗ ${sym} ${rc ? "链上失败" : "60 秒没确认,别重复提交"}:${ex.data.txHash}`); failed++; continue; }
  const [bal] = await call(ca, "balanceOf", [W]);
  log(`✓ ${sym} 上链 ${ex.data.txHash}  现在持有 ${ethers.formatEther(bal)} 个`);
}
process.exit(failed ? 1 : 0);

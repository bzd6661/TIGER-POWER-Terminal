#!/usr/bin/env node
// 部署打赏合约(TMTip):node contracts/deploy-tip.mjs <作者收款地址> [--acct 1|2] [--dry]
//   币安钱包(baw)只能调用已有合约、不能直接部署,所以通过 BSC 上通用的 CREATE2 部署合约 0x4e59…956C 来部署:
//   合约地址只由 部署合约 + salt + 合约代码(含作者地址)决定,部署前就能算出来,脚本先打印出来。
//   流程和其他脚本一样:preview(链上模拟 + 币安风控)→ 有风险提示 / 要去 App 批准就停 → execute → 等上链 → 确认合约代码已经在链上。
//   合约代码 / ABI 在 contracts/TMTip.json(由 contracts/TMTip.sol 用 solc 0.8.24 编译,optimizer 200 runs)。
import "../env.mjs";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { takeAcct, bawSpawn } from "../accounts.mjs";

const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";   // 通用 CREATE2 部署合约(各链地址一样)
const SALT = ethers.id("TMTip v1");
const args = process.argv.slice(2);
const ACCT = takeAcct(args);
const DRY = args.includes("--dry");
const author = args.find((a) => ethers.isAddress(a));
const die = (m) => { console.error("✗ " + m); process.exit(1); };
if (!author) die("用法:node contracts/deploy-tip.mjs <作者收款地址> [--acct 1|2] [--dry]");

const art = JSON.parse(readFileSync(new URL("./TMTip.json", import.meta.url), "utf8"));
const I = new ethers.Interface(art.abi);
const init = art.bytecode + I.encodeDeploy([ethers.getAddress(author)]).slice(2);
const predicted = ethers.getCreate2Address(FACTORY, SALT, ethers.keccak256(init));
const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });

console.log(`作者收款地址:${ethers.getAddress(author)}`);
console.log(`打赏合约地址(部署后):${predicted}`);
if ((await provider.getCode(predicted)) !== "0x") { console.log("✓ 这个地址上已经部署过了,不用再部署"); process.exit(0); }

const baw = (a) => new Promise((res) => {
  const ps = bawSpawn(ACCT, [...a, "--json"]); let out = "";
  ps.stdout.on("data", (d) => (out += d));
  ps.on("close", () => { try { res(JSON.parse(out)); } catch { res({ success: false, error: { message: out.slice(0, 300) } }); } });
});
const W = (await baw(["wallet", "address"]))?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address;
if (!W) die("拿不到钱包地址(账号登录了吗?)");
const data = SALT + init.slice(2);
const pv = await baw(["contract-call", "preview", "--binanceChainId", "56", "--from", W, "--to", FACTORY, "--value", "0", "--inputData", data]);
if (!pv.success) die(`preview 失败:${JSON.stringify(pv.error ?? pv)}`);
if (pv.data.simulationResult?.simulationCode !== "000000000") die(`模拟没通过:${JSON.stringify(pv.data.simulationResult)}`);
const r = pv.data.risks;
if (r?.riskDetails?.length || Object.values(r?.addresses ?? {}).some((x) => x?.riskDetails?.length)) die(`钱包报了风险,不执行:${JSON.stringify(r)}`);
if (pv.data.requireConfirmation) die("需要去 Binance App 批准,脚本不提交(可以之后再试)");
console.log(`preview 通过(从 ${W} 发出)`);
if (DRY) { console.log("--dry:不部署"); process.exit(0); }
const ex = await baw(["contract-call", "execute", "--requestId", pv.data.requestId]);
if (!ex.success || !ex.data?.txHash) die(`execute 失败:${JSON.stringify(ex.error ?? ex.data ?? ex)}`);
console.log(`已提交 ${ex.data.txHash}`);
const rc = await provider.waitForTransaction(ex.data.txHash, 1, 90_000).catch(() => null);
if (!rc || rc.status !== 1) die(`没上链 / 失败:${ex.data.txHash}`);
const code = await provider.getCode(predicted);
if (code === "0x") die(`交易成功了但地址上没有合约代码,去 BscScan 看看:${ex.data.txHash}`);
const got = I.decodeFunctionResult("author", await provider.call({ to: predicted, data: I.encodeFunctionData("author") }))[0];
console.log(`✓ 部署完成:${predicted}(作者 ${got})  https://bscscan.com/address/${predicted}`);

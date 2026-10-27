#!/usr/bin/env node
// Gang 新版本(V3)发射台监控 + 可选自动买入。
//   node gang/v3watch.mjs                     只监控,推 TG(不下单)
//   node gang/v3watch.mjs --arm               监控 + 新发射台的前 3 个币,两个号各自动买 1%
//         [--first 3] [--acct both|1|2] [--max-bnb 0.2]   每个号每个币折合超过 --max-bnb 就不买
//   node gang/v3watch.mjs --once              每个通道各跑一轮就退出(看基准)
//
// 怎么认出 V3(任何一条命中都会推送;能拿到新发射台地址的会记成「新发射台」):
//   1. 部署钱包:V1 / V2 的发射台全是 0x4EEdcDF5… 部署的。它每部署一个合约都推送,≥ 12 KB 的标「疑似新发射台」。
//   2. 链上:已知发射台以外的合约发出 Gang 的 Created 事件,或者「疑似新发射台」发出任何事件(第一个币上线)。
//   3. gang.fun 接口:最新代币里出现不认识的 launchpad / track 字段、/api/stats 的 launchpad 变了。
//   4. 官方 CLI:@gangfun/cli 出新版本就下到 gang/cli-latest(不动全局安装),看它的发射台列表有没有新地址;
//      自动买入用这份最新 CLI(新发射台要新版 CLI 才认得)。
//   5. gang.fun 前端代码:新版本里出现不认识的合约地址 / v3 字样。
// 自动买入(只有加了 --arm 才会买):新发射台上按创建顺序的前 N 个币,每个号调 gang/gangbuy.mjs 买满 1%(单钱包上限),
//   每一笔照样先 preview(链上模拟 + 币安风控),有风险提示 / 要去 App 批准就不买;CLI 还不认识新发射台时每 30 秒重试,最多 30 分钟。
// 状态存 gang/v3-state.json,日志 gang/v3watch.log。
import "../env.mjs";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { ethers } from "ethers";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const STATE = process.env.V3WATCH_STATE || here("./v3-state.json"), LOG = here("./v3watch.log"), CLI_DIR = here("./cli-latest/");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ARM = flag("--arm"), ONCE = flag("--once");
const FIRST = Number(opt("--first", "3")), ACCT = opt("--acct", "both"), MAX_BNB = opt("--max-bnb", "0.2");
if (!["1", "2", "both"].includes(ACCT)) throw new Error("--acct 只能是 1 / 2 / both");

const DEPLOYER = "0x4eedcdf5fab775e10c0d09951b6f59ab81ba19d3";
// 已知发射台:V1(第一代)、soft、V2、U、S
const KNOWN_PADS = new Set(["0x315ba2e8952d06094cc636b2b84229fa32fb23a7", "0x4e6f13c8a453c1b8b4e20b590082bb233a5b80d7", "0x1b8f3f69dfa0a7f63d308c7eb0fd38d8b099966e", "0xf81c4e51c48466c6025b0165b1ea0f6978c712cb", "0x60aee38576035e757ded30ff8db8a8da476430c1"]);
// Gang 的 Created 事件(V1 / V2 两种签名)
const T_CREATED = [ethers.id("Created(address,address,string,string)"), ethers.id("Created(address,address,string,string,string,bool,address,address,uint256)")];
const PAD_MIN_BYTES = 12_000;
// 测试用:V3WATCH_FORGET=地址,地址 —— 假装不认识这些发射台(只配合 --once、不加 --arm、单独的 V3WATCH_STATE 用,验证识别逻辑)
for (const a of (process.env.V3WATCH_FORGET || "").split(",").filter(Boolean)) KNOWN_PADS.delete(a.trim().toLowerCase());

const net = ethers.Network.from(56);
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });
const LOG_RPC = process.env.BSC_LOG_RPC || "https://bsc-rpc.publicnode.com";
async function getLogs(filter) {
  const r = await fetch(LOG_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [filter] }), signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 160)); return j.result;
}

// ---------- 状态 / 日志 / TG ----------
let st = { nonce: null, cursor: null, pads: {}, tokens: [], apiLaunchpad: null, tracks: [], cliVersion: null, assets: [], addrsSeen: [], bought: {} };
try { st = { ...st, ...JSON.parse(readFileSync(STATE, "utf8")) }; } catch {}
const save = () => { try { writeFileSync(STATE, JSON.stringify(st, null, 1)); } catch {} };
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
function log(...a) { const l = `[${stamp()}] ${a.join(" ")}`; console.log(l); try { appendFileSync(LOG, l + "\n"); } catch {} }
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
async function tg(html) {
  log("[TG] " + html.replace(/<[^>]+>/g, ""));
  const token = process.env.TG_BOT_TOKEN, chat = process.env.TG_CHAT_ID;
  if (!token || !chat || ONCE) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: html, parse_mode: "HTML", disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }).catch(() => {});
}
const scan = (a) => `<a href="https://bscscan.com/address/${a}">${a}</a>`;

// ---------- 新发射台 / 新币 ----------
function newPad(addr, why) {
  const a = addr.toLowerCase();
  if (KNOWN_PADS.has(a) || st.pads[a]) return false;
  st.pads[a] = { at: Date.now(), why };
  save();
  tg(`🚨 <b>Gang 疑似新发射台(V3)</b>\n${scan(a)}\n来源:${esc(why)}${ARM ? `\n已开自动买入:这个发射台的前 ${FIRST} 个币,${ACCT === "both" ? "两个号" : "账号" + ACCT}各买 1%(每笔上限 ${MAX_BNB} BNB)` : "\n(没开自动买入)"}`);
  return true;
}
async function isErc20(a) {
  try { const s = new ethers.Interface(["function symbol() view returns (string)"]); return s.decodeFunctionResult("symbol", await provider.call({ to: a, data: s.encodeFunctionData("symbol") }))[0]; } catch { return null; }
}
async function newToken(ca, pad, why, symbol) {
  const k = ca.toLowerCase();
  if (st.tokens.some((t) => t.ca === k)) return;
  const sym = symbol ?? (await isErc20(k)) ?? "?";
  const order = st.tokens.length + 1;   // 所有新发射台合起来按出现顺序数(V2 当时一次上了 3 个发射台)
  st.tokens.push({ ca: k, pad, sym, at: Date.now(), order, why });
  save();
  const willBuy = ARM && order <= FIRST;
  tg(`🆕 <b>新版本第 ${order} 个币</b>:${esc(sym)}\n<code>${k}</code>\n发射台 ${scan(pad)}\n来源:${esc(why)}\n${willBuy ? `⚡ 自动买入中(${ACCT === "both" ? "两个号" : "账号" + ACCT}各 1%,上限 ${MAX_BNB} BNB)` : ARM ? `前 ${FIRST} 个已买过,不再自动买` : "没开自动买入"}`);
  if (willBuy) autoBuy(k, sym).catch((e) => log("自动买入出错", e.message));
}

// ---------- 通道 1:部署钱包 ----------
async function chDeployer() {
  const n = await provider.getTransactionCount(DEPLOYER);
  if (st.nonce === null) { st.nonce = n; save(); log(`部署钱包基准 nonce ${n}`); return; }
  for (let i = st.nonce; i < n; i++) {
    const a = ethers.getCreateAddress({ from: DEPLOYER, nonce: i });
    const code = await provider.getCode(a).catch(() => "0x");
    if (code === "0x") { log(`部署钱包第 ${i} 笔交易(不是部署合约)`); continue; }
    const bytes = (code.length - 2) / 2;
    if (bytes >= PAD_MIN_BYTES) newPad(a, `部署钱包第 ${i} 笔交易部署了 ${bytes} 字节的合约`);
    else tg(`🔧 Gang 部署钱包部署了新合约(${bytes} 字节,可能是新版本的配套合约)\n${scan(a)}`);
  }
  st.nonce = n; save();
}

// ---------- 通道 2:链上事件 ----------
async function chLogs() {
  const head = (await provider.getBlockNumber()) - 1;
  if (st.cursor === null || head - st.cursor > 2000) st.cursor = head - 20;
  const from = st.cursor + 1;
  if (head < from) return;
  // 不认识的合约发出 Gang 的 Created 事件
  const created = await getLogs({ fromBlock: "0x" + from.toString(16), toBlock: "0x" + head.toString(16), topics: [T_CREATED] });
  for (const l of created) {
    const pad = l.address.toLowerCase();
    if (KNOWN_PADS.has(pad)) continue;
    newPad(pad, "不认识的合约发出了 Gang 的建币事件");
    await newToken("0x" + l.topics[1].slice(26), pad, "链上 Created 事件");
  }
  // 疑似新发射台发出的任何事件:topic1 是新部署的 ERC20 就当成新币(V3 事件签名可能变了)
  const pads = Object.keys(st.pads);
  if (pads.length) {
    const logs = await getLogs({ fromBlock: "0x" + from.toString(16), toBlock: "0x" + head.toString(16), address: pads });
    for (const l of logs) {
      const t1 = l.topics[1];
      if (!t1 || !/^0x0{24}/.test(t1)) continue;
      const ca = "0x" + t1.slice(26);
      if (st.tokens.some((t) => t.ca === ca)) continue;
      const sym = await isErc20(ca);
      if (sym) await newToken(ca, l.address.toLowerCase(), "新发射台的链上事件", sym);
    }
  }
  st.cursor = head; save();
}

// ---------- 通道 3:gang.fun 接口 ----------
async function chApi() {
  const get = (p) => fetch("https://gang.fun/api" + p, { signal: AbortSignal.timeout(12000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const stats = await get("/stats");
  if (stats?.launchpad) {
    const lp = stats.launchpad.toLowerCase();
    if (st.apiLaunchpad && st.apiLaunchpad !== lp) { tg(`🔔 gang.fun /api/stats 的 launchpad 变了:${st.apiLaunchpad} → ${lp}`); newPad(lp, "gang.fun /api/stats 换了 launchpad"); }
    st.apiLaunchpad = lp;
  }
  for (const p of ["/stocks/tokens?limit=100", "/tokens?limit=100"]) {
    const j = await get(p);
    // 接口按活跃度排序:按创建时间从早到晚处理,「前 3 个」才是最早发的 3 个
    for (const t of [...(j?.items ?? [])].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
      // 任何 *launchpad* 字段里不认识的地址,或者没见过的 track
      for (const [k, v] of Object.entries(t)) {
        if (/launchpad/i.test(k) && typeof v === "string" && ethers.isAddress(v) && !KNOWN_PADS.has(v.toLowerCase())) {
          newPad(v, `gang.fun 代币接口的 ${k} 字段`);
          await newToken(t.address, v.toLowerCase(), "gang.fun 代币接口", t.symbol);
        }
      }
      if (t.track && !st.tracks.includes(t.track)) {
        if (st.tracks.length) tg(`🔔 gang.fun 出现新的代币分类 track=${esc(t.track)}(${esc(t.symbol)} <code>${t.address}</code>)`);
        st.tracks.push(t.track);
      }
    }
  }
  save();
}

// ---------- 通道 4:官方 CLI 新版本 ----------
const cliChain = () => join(CLI_DIR, "package", "src", "chain.js");
async function chCli() {
  const v = await fetch("https://registry.npmjs.org/@gangfun/cli/latest", { signal: AbortSignal.timeout(12000) }).then((r) => r.json()).then((j) => j.version).catch(() => null);
  if (!v || (v === st.cliVersion && existsSync(cliChain()))) return;
  const old = st.cliVersion;
  try {
    rmSync(CLI_DIR, { recursive: true, force: true }); mkdirSync(CLI_DIR, { recursive: true });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(npm, ["pack", `@gangfun/cli@${v}`, "--silent"], { cwd: CLI_DIR, shell: process.platform === "win32", timeout: 120_000 });
    const tgz = readdirSync(CLI_DIR).find((f) => f.endsWith(".tgz"));
    execFileSync("tar", ["xzf", tgz], { cwd: CLI_DIR, timeout: 60_000 });
    execFileSync(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], { cwd: join(CLI_DIR, "package"), shell: process.platform === "win32", timeout: 300_000 });
  } catch (e) { log("下载最新 gang CLI 失败", e.message.slice(0, 200)); return; }
  st.cliVersion = v; save();
  // 新版 CLI 的发射台列表
  let addrs = [];
  try { addrs = [...readFileSync(cliChain(), "utf8").matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0].toLowerCase()); } catch {}
  const fresh = [...new Set(addrs)].filter((a) => !KNOWN_PADS.has(a) && a !== "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c");
  if (old) tg(`📦 gang CLI 出新版本 ${esc(old)} → ${esc(v)}${fresh.length ? `\n里面有不认识的合约地址:\n${fresh.map((a) => `<code>${a}</code>`).join("\n")}` : ""}`);
  else log(`gang CLI 基准版本 ${v}(已下到 gang/cli-latest)`);
  for (const a of fresh) { const c = await provider.getCode(a).catch(() => "0x"); if ((c.length - 2) / 2 >= PAD_MIN_BYTES) newPad(a, `gang CLI ${v} 里的新地址`); }
}

// ---------- 通道 5:前端代码 ----------
async function chFrontend() {
  const html = await fetch("https://gang.fun/", { signal: AbortSignal.timeout(15000) }).then((r) => r.text()).catch(() => "");
  const assets = [...new Set([...html.matchAll(/\/assets\/[\w.-]+\.js/g)].map((m) => m[0]))];
  const fresh = assets.filter((a) => !st.assets.includes(a));
  if (!fresh.length) return;
  const first = !st.assets.length;
  st.assets = assets;
  const seen = new Set(st.addrsSeen);
  const found = [];
  let v3 = false;
  for (const a of fresh) {
    const js = await fetch("https://gang.fun" + a, { signal: AbortSignal.timeout(20000) }).then((r) => r.text()).catch(() => "");
    if (/\bv3\b|V3Launchpad|launchpadV3|LaunchpadV3/.test(js)) v3 = true;
    for (const m of js.matchAll(/0x[0-9a-fA-F]{40}/g)) { const x = m[0].toLowerCase(); if (!seen.has(x)) { seen.add(x); found.push(x); } }
  }
  st.addrsSeen = [...seen]; save();
  if (first) { log(`前端基准:${assets.length} 个脚本,${seen.size} 个地址`); return; }
  tg(`🌐 gang.fun 前端更新了(${fresh.length} 个新脚本)${v3 ? "\n⚠️ 代码里出现了 V3 字样" : ""}${found.length ? `\n新出现的地址:\n${found.slice(0, 10).map((x) => `<code>${x}</code>`).join("\n")}` : ""}`);
  for (const a of found) { const c = await provider.getCode(a).catch(() => "0x"); if ((c.length - 2) / 2 >= PAD_MIN_BYTES) newPad(a, "gang.fun 前端代码里的新地址"); }
}

// ---------- 自动买入 ----------
function runBuy(ca, acct) {
  return new Promise((resolve) => {
    // 只用本机装好的(固定版本)gang CLI 下单;自动下载的最新版只用来看里面有没有新地址,绝不在下单进程里运行
    const env = { ...process.env };
    delete env.GANG_CLI_CHAIN;
    const ps = spawn(process.execPath, [here("./gangbuy.mjs"), ca, "--acct", acct, "--max-bnb", MAX_BNB], { env, cwd: here("../"), windowsHide: true });
    let out = "";
    ps.stdout.on("data", (d) => (out += d)); ps.stderr.on("data", (d) => (out += d));
    ps.on("close", (code) => resolve({ code, out }));
  });
}
async function autoBuy(ca, sym) {
  const accts = ACCT === "both" ? ["1", "2"] : [ACCT];
  await Promise.all(accts.map(async (a) => {
    const key = `${ca}:${a}`;
    if (st.bought[key]) return;
    const t0 = Date.now();
    for (let tries = 1; ; tries++) {
      const r = await runBuy(ca, a);
      const last = (r.out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith("✗")) ?? r.out.trim().split(/\r?\n/).pop() ?? "").trim();
      log(`[自动买入] ${sym} 账号${a} 第 ${tries} 次 退出码 ${r.code}:${last}`);
      if (r.code === 0) {
        st.bought[key] = { at: Date.now(), ok: true }; save();
        const tx = r.out.match(/0x[0-9a-f]{64}/gi)?.pop();
        return tg(`✅ 自动买入 <b>${esc(sym)}</b> 账号${a} 完成${tx ? `\n<a href="https://bscscan.com/tx/${tx}">${tx.slice(0, 14)}…</a>` : ""}\n<code>${ca}</code>`);
      }
      // 新版 CLI 还不认识这个发射台:等 CLI 更新(每 30 秒重试,先去拉一次最新 CLI),最多 30 分钟
      const unknownPad = /not a Gang token on known pads|查不到这个币/i.test(r.out);
      if (unknownPad && Date.now() - t0 < 30 * 60_000) {
        if (tries === 1) tg(`⏳ ${esc(sym)} 账号${a}:gang CLI 还不认识新发射台,等官方出新版 CLI(每 30 秒重试,最多 30 分钟)`);
        await chCli().catch(() => {});
        await new Promise((res) => setTimeout(res, 30_000));
        continue;
      }
      st.bought[key] = { at: Date.now(), ok: false, error: last }; save();
      return tg(`🛑 自动买入 <b>${esc(sym)}</b> 账号${a} 没买(不再重试):\n${esc(last).slice(0, 400)}\n<code>${ca}</code>`);
    }
  }));
}

// ---------- 主循环 ----------
const channels = [["部署钱包", chDeployer, 10_000], ["链上事件", chLogs, 5_000], ["gang.fun 接口", chApi, 15_000], ["CLI 版本", chCli, 300_000], ["前端代码", chFrontend, 180_000]];
async function runCh(name, fn) { try { await fn(); } catch (e) { log(`[${name}] 出错:${e.message.slice(0, 200)}`); } }
log(`启动 Gang V3 监控${ARM ? `(⚡ 自动买入已开:前 ${FIRST} 个币,账号 ${ACCT},每笔上限 ${MAX_BNB} BNB)` : "(只监控,不下单)"}`);
for (const [name, fn] of channels) await runCh(name, fn);
if (ONCE) { log("--once:跑完一轮", JSON.stringify({ nonce: st.nonce, pads: Object.keys(st.pads), tokens: st.tokens.length, cli: st.cliVersion, assets: st.assets.length })); process.exit(0); }
tg(`👀 Gang V3 监控已启动${ARM ? `\n⚡ 自动买入已开:新发射台前 ${FIRST} 个币,${ACCT === "both" ? "两个号" : "账号" + ACCT}各买 1%,每笔上限 ${MAX_BNB} BNB` : "\n只监控,不下单"}\n部署钱包 nonce ${st.nonce} · CLI ${st.cliVersion ?? "?"}`);
for (const [name, fn, ms] of channels) { let busy = false; setInterval(async () => { if (busy) return; busy = true; await runCh(name, fn); busy = false; }, ms); }
setInterval(() => log(`心跳 nonce ${st.nonce} · 区块 ${st.cursor} · 新发射台 ${Object.keys(st.pads).length} · 新币 ${st.tokens.length}`), 600_000);

#!/usr/bin/env node
// 自动跟新模式开盘:four.meme Agent ID 模式(preset 1778027615735)的盘子按出现顺序挨个买,
//   前 5 笔成功的:每个买到单地址 1% 上限,但最多花 --max1 BNB(1% 更贵就只花这么多)
//   第 6..10 笔成功的:每个买 --amt2 BNB
//   没买成的盘子(资格不过、余额不够、preview 被拦……)不占名额,接着买下一个盘子,直到成功满 10 笔才退出。
// 每一笔都交给 fourbuy.mjs 执行(资格预检 / ERC20 底池兑换 / 1% 上限 / baw preview → execute 都在那里),
// 这里只负责盯链、排队、记账、推 TG。
//
//   node fourauto.mjs [--max1 0.15] [--amt2 0.05] [--first 5] [--last 10] [--slip 30] [--dry] [--sim]
//                     [--preset <id>] [--catch-up] [--no-tg]
//
//   --dry      每笔只 preview 不执行(推荐先这样挂一次)
//   --sim      不调 baw,只做链上模拟(配合 --preset 拿别的模式演练)
//   --preset   改盯别的模式(演练用,默认 1778027615735)
//   --catch-up 启动前已经出现的盘子也补买(默认跳过,只买启动之后出现的)
//   --from     第一次启动时从这个块开始数盘子(演练用)
//
// 状态在 auto-state.json(盘子顺序和每笔结果),重启接着来、不会重复买;想重来就删掉它。
// --dry / --sim 下"预演通过"也算成功,这样预演时的计数和实盘一致。
import "./env.mjs";   // 先读 .env
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const CORE = "0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3";
const TOKEN_CREATED = "0x7dae4dcd1b20eb0445e7cc1d02b3e2e7f32fa63081a0e764732c269f2b8f228f"; // topic1 = presetId, topic3 = token
const AGENT_PRESET = 1778027615735n;
const AGENT_EXEC_BLOCK = 129364687;   // 这个模式上链的区块,这之前不可能有这个模式的币
const STATE_FILE = process.env.FOURAUTO_STATE || fileURLToPath(new URL("./auto-state.json", import.meta.url));
const FOURBUY = fileURLToPath(new URL("./fourbuy.mjs", import.meta.url));

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args.splice(i, 1), true) : false; };
const opt = (n, d) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const DRY = flag("--dry"), SIM = flag("--sim"), CATCH_UP = flag("--catch-up"), NO_TG = flag("--no-tg") || SIM;
const max1 = opt("--max1", "0.15"), amt2 = opt("--amt2", "0.05");
const FIRST = Number(opt("--first", "5")), LAST = Number(opt("--last", "10"));
const slip = opt("--slip", "30");
const PRESET = BigInt(opt("--preset", AGENT_PRESET.toString()));
const proof = opt("--proof", null);
// --from <块号>:第一次启动时从这个块开始数盘子(演练用:配合 --catch-up 把历史盘子当新盘子回放)
const FROM = opt("--from", null);
for (const [n, v] of [["--max1", max1], ["--amt2", amt2]]) if (!/^\d+(\.\d{1,18})?$/.test(v) || Number(v) <= 0) { console.error(`✗ ${n} 要是正数`); process.exit(1); }
if (!(FIRST >= 0 && LAST >= FIRST)) { console.error("✗ 要求 0 <= --first <= --last"); process.exit(1); }

// 日志节点:agentbuy/.env 里的 BSC_LOG_RPC(自己的节点),没配就 48.club
const logRpc = process.env.BSC_LOG_RPC || "https://rpc-bsc.48.club";
const net = ethers.Network.from(56);
const lp = new ethers.JsonRpcProvider(logRpc, net, { staticNetwork: net });
const bp = new ethers.JsonRpcProvider(process.env.BSC_RPC || "https://bsc-dataseed.bnbchain.org", net, { staticNetwork: net });

// Telegram:读 .env 里的 TG_BOT_TOKEN / TG_CHAT_ID,没配就只打印
const tg = process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID ? {
  sendTelegram: (text) => fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }), signal: AbortSignal.timeout(10000),
  }),
} : null;
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const notify = (title, lines = []) => { if (!NO_TG && tg) tg.sendTelegram([`<b>${esc(title)}</b>`, ...lines.map(esc)].join("\n")).catch(() => {}); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (x) => BigInt(x).toString(16).padStart(64, "0");

// ---------------------------------------------------------------- 状态
let st = { preset: PRESET.toString(), order: [], results: {}, lastBlock: 0 };
if (existsSync(STATE_FILE)) {
  const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  if (s.preset === PRESET.toString()) st = s;
  else log(`auto-state.json 是别的模式(${s.preset})的,重新开始`);
}
const save = () => writeFileSync(STATE_FILE, JSON.stringify(st, null, 1));

// 名额按"成功笔数"算,不按盘子序号:失败的盘子不占名额
const OK = new Set(["已买", "预演通过"]);
const successes = () => Object.values(st.results).filter((r) => OK.has(r.status)).length;
const planFor = (done) => (done < FIRST ? { kind: "1%", amt: max1 } : done < LAST ? { kind: "固定", amt: amt2 } : null);
let failStreak = 0;

// ---------------------------------------------------------------- 盯链
async function fetchNew(from, to) {
  const out = [];
  for (let a = from; a <= to; a += 40000) {
    const b = Math.min(a + 39999, to);
    const logs = await lp.getLogs({ address: CORE, topics: [TOKEN_CREATED, "0x" + pad(PRESET)], fromBlock: a, toBlock: b });
    out.push(...logs);
  }
  out.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
  return out.map((l) => ({ token: ethers.getAddress("0x" + l.topics[3].slice(26)), block: l.blockNumber, tx: l.transactionHash }));
}

// ---------------------------------------------------------------- 买(串行)
const queue = [];
let busy = false;
function runBuy(ca, amt) {
  const a = [FOURBUY, ca, amt, "--slip", slip];
  if (DRY) a.push("--dry");
  if (SIM) a.push("--sim");
  if (PRESET !== AGENT_PRESET) a.push("--any-preset");
  if (proof) a.push("--proof", proof);
  return new Promise((res) => {
    const ps = spawn(process.execPath, a, { env: process.env });
    let out = "";
    ps.stdout.on("data", (d) => { out += d; process.stdout.write(`    │ ${String(d).trimEnd().replace(/\n/g, "\n    │ ")}\n`); });
    ps.stderr.on("data", (d) => { out += d; process.stdout.write(`    │ ${String(d).trimEnd().replace(/\n/g, "\n    │ ")}\n`); });
    ps.on("close", (code) => res({ code, out }));
  });
}
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const job = queue.shift();
    const { idx, token } = job;
    const done = successes();
    const plan = planFor(done);
    if (!plan) {
      st.results[token] = { idx, status: "已买满,不买", at: ts() };
      save();
      log(`#${idx} ${token} 已经成功 ${done} 笔,买满了,不买`);
      continue;
    }
    // 余额护栏:不够这一笔 + 0.01 BNB gas 就跳过(--sim 不查)
    if (!SIM) {
      const bal = await bp.getBalance(st.wallet).catch(() => null);
      if (bal != null && bal < ethers.parseEther(plan.amt) + ethers.parseEther("0.01")) {
        st.results[token] = { idx, status: "余额不够,跳过", at: ts() };   // 不占名额
        save();
        log(`#${idx} ${token} 余额 ${ethers.formatEther(bal)} BNB 不够 ${plan.amt} + gas,跳过`);
        notify(`⚠️ #${idx} 余额不够,跳过`, [token, `余额 ${ethers.formatEther(bal)} BNB`]);
        continue;
      }
    }
    log(`▶ #${idx} ${token} 第 ${done + 1} 笔:${plan.kind === "1%" ? `买到 1%(最多 ${plan.amt} BNB)` : `买 ${plan.amt} BNB`}${DRY ? "(--dry)" : ""}${SIM ? "(--sim)" : ""}`);
    const r = await runBuy(token, plan.amt);
    const lines = r.out.trim().split("\n").map((s) => s.replace(/^\[[\d.]+s\]\s*/, ""));
    const last = lines.filter(Boolean).slice(-3);
    const ok = r.code === 0;
    st.results[token] = { idx, status: ok ? (DRY || SIM ? "预演通过" : "已买") : "失败", plan: plan.kind, detail: last.join(" | ").slice(0, 400), at: ts() };
    save();
    failStreak = ok ? 0 : failStreak + 1;
    notify(`${ok ? (DRY || SIM ? "🧪" : "✅") : "❌"} four.meme 新模式盘子 #${idx} ${ok ? (DRY || SIM ? "预演通过" : "已买") : "没买成(不占名额)"} · 已成功 ${successes()}/${LAST}`,
      [`https://bscscan.com/token/${token}`, plan.kind === "1%" ? `目标 1%,上限 ${plan.amt} BNB` : `${plan.amt} BNB`, ...last,
        ...(failStreak >= 3 ? [`⚠️ 已连续失败 ${failStreak} 次,多半是资格 / proof / 设置问题,看一下日志`] : [])]);
  }
  busy = false;
  if (successes() >= LAST && !queue.length) {
    log(`已成功买满 ${LAST} 笔,退出`);
    notify(`🏁 four.meme 新模式已成功买满 ${LAST} 笔`, Object.entries(st.results).sort((a, b) => a[1].idx - b[1].idx).map(([t, r]) => `#${r.idx} ${r.status}${r.plan ? "(" + r.plan + ")" : ""} ${t}`));
    process.exit(0);
  }
}

function accept(found, { catchUp }) {
  for (const f of found) {
    if (st.order.includes(f.token)) continue;
    st.order.push(f.token);
    const idx = st.order.length;   // 这个模式的第几个盘子(只用来显示,名额按成功笔数算)
    if (successes() >= LAST) { log(`#${idx} ${f.token} 已经买满 ${LAST} 笔,不买`); continue; }
    if (!catchUp) {
      st.results[f.token] = { idx, status: "启动前已出现,跳过", at: ts() };
      log(`#${idx} ${f.token} 启动前就有了,跳过(要补买加 --catch-up)`);
      continue;
    }
    log(`🆕 #${idx} ${f.token} 块 ${f.block} → 排队`);
    queue.push({ idx, token: f.token });
  }
  save();
}

// ---------------------------------------------------------------- 启动
const W = process.env.FOURBUY_WALLET || (existsSync(new URL("./.wallet", import.meta.url)) ? readFileSync(new URL("./.wallet", import.meta.url), "utf8").trim() : null);
if (!W && !SIM) { console.error("✗ 没有钱包地址:先跑一次 node fourbuy.mjs 生成 .wallet,或设 FOURBUY_WALLET"); process.exit(1); }
st.wallet = W;
const head = await lp.getBlockNumber();
log(`盯 preset ${PRESET} · 钱包 ${W ?? "(sim)"} · 前 ${FIRST} 笔成功的买 1%(上限 ${max1} BNB),第 ${FIRST + 1}-${LAST} 笔买 ${amt2} BNB,失败不占名额${DRY ? " · --dry 只预览" : ""}${SIM ? " · --sim 不调 baw" : ""}`);
log(`日志节点 ${new URL(logRpc).host}`);

if (!st.lastBlock) {
  // 第一次启动:把启动前已经出现的盘子按顺序记下来(序号从这个模式的第一个盘子算起)
  const from = FROM != null ? Number(FROM) : PRESET === AGENT_PRESET ? AGENT_EXEC_BLOCK : head;
  const existing = from < head ? await fetchNew(from, head) : [];
  accept(existing, { catchUp: CATCH_UP });
  st.lastBlock = head;
  save();
  log(`启动前已有 ${existing.length} 个盘子`);
}
notify(`🛰 fourauto 已启动${DRY ? "(--dry)" : ""}`, [`盯 preset ${PRESET}`, `前 ${FIRST} 笔成功的:买到 1%,每个最多 ${max1} BNB`, `第 ${FIRST + 1}-${LAST} 笔:每个 ${amt2} BNB`, `没买成的盘子不占名额`, `已成功 ${successes()}/${LAST} · 已记录 ${st.order.length} 个盘子`]);
pump();

let lastBeat = Date.now();
for (;;) {
  try {
    const h = await lp.getBlockNumber();
    if (h > st.lastBlock) {
      const found = await fetchNew(st.lastBlock + 1, h);
      st.lastBlock = h;
      if (found.length) { accept(found, { catchUp: true }); pump(); }
      else save();
    }
  } catch (e) { log(`拉日志出错:${e.shortMessage || e.message}`); }
  if (Date.now() - lastBeat > 600000) { lastBeat = Date.now(); log(`心跳:块 ${st.lastBlock} · 已记录 ${st.order.length} 个盘子 · 已成功 ${successes()}/${LAST} · 排队 ${queue.length}`); }
  await sleep(1000);
}

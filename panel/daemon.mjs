#!/usr/bin/env node
// 面板常驻守护:后台跑 server.mjs,不用再开 cmd 窗口。
//   · panel/ 下的 .mjs 一改就自动重启(index.html / scan.html 每次请求现读,改了刷新网页即可)
//     重启前先问 /health,有单在跑就等它跑完(最多等 5 分钟)
//   · 崩了 3 秒后自动拉起;端口被占(比如旧的 start.cmd 还开着)就 30 秒后再试
//   · 输出写到 panel/panel.log(超过 5MB 清空重来)
// 开机自启:Windows「启动」文件夹里的 agentbuy-panel.vbs 隐藏窗口跑 daemon.vbs → 这个文件
import { spawn } from "node:child_process";
import { appendFileSync, statSync, writeFileSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const PORT = Number(process.env.PANEL_PORT || 4400);
const LOG = here("./panel.log");
const log = (s) => {
  try { if (statSync(LOG).size > 5 * 1024 * 1024) writeFileSync(LOG, ""); } catch {}
  appendFileSync(LOG, `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${s}`.replace(/\n?$/, "\n"));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 同一时间只允许一个 server:child 是正在跑的,pending 是排好的「崩溃后重启」定时器
let child = null, restarting = false, pending = null;
function run() {
  clearTimeout(pending); pending = null;
  if (child) return;   // 已经有一个在跑了,别再起第二个
  let inUse = false;
  const ps = (child = spawn(process.execPath, [here("./server.mjs")], { cwd: here("../"), windowsHide: true, env: process.env }));
  const pipe = (s) => s.on("data", (b) => { const t = String(b); if (/EADDRINUSE/.test(t)) inUse = true; log(t.trimEnd()); });
  pipe(ps.stdout); pipe(ps.stderr);
  ps.on("close", (code) => {
    if (child === ps) child = null;
    if (restarting) return;   // 改代码触发的重启,由 restart() 负责拉起
    const wait = inUse ? 30_000 : 3_000;
    log(`server 退出(${code}),${wait / 1000} 秒后重启${inUse ? "(端口被占,先关掉旧的 start.cmd 窗口)" : ""}`);
    clearTimeout(pending); pending = setTimeout(run, wait);
  });
}

async function busy() {
  try { return (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json())).busy > 0; }
  catch { return false; }
}
async function restart(file) {
  if (restarting) return;
  restarting = true;
  for (let i = 0; i < 100 && (await busy()); i++) { if (i === 0) log(`${file} 改了,有单在跑,等跑完再重启`); await sleep(3000); }
  log(`${file} 改了,重启 server`);
  clearTimeout(pending); pending = null;   // 取消排着的崩溃重启,统一由这里拉起
  const old = child;
  if (old) { const done = new Promise((r) => old.once("close", r)); old.kill(); await done; }
  restarting = false;
  run();
}

let timer = null;
watch(here("./"), (ev, f) => {
  if (!f || !/\.mjs$/.test(f) || f === "daemon.mjs") return;
  clearTimeout(timer);
  timer = setTimeout(() => restart(f), 800);   // 编辑器保存常连触发几次,合并成一次
});
// 上一层的 accounts.mjs 也是 server 依赖的
watch(here("../"), (ev, f) => { if (f === "accounts.mjs") { clearTimeout(timer); timer = setTimeout(() => restart(f), 800); } });
log("守护进程启动");
run();

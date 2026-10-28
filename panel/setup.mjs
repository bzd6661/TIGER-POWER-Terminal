// 双击 start.cmd 时跑的启动检查(不依赖任何 npm 包,第一次运行也能跑):
//   Node 版本 → 没装依赖就 npm install → 没装币安钱包命令行(baw)就问要不要装 → 面板 / 本机助手没在跑就启动后台守护进程 → 等它起来 → 打开网页。
//   启动失败时把 panel/panel.log 最后几行打出来。AGENTBUY_NO_OPEN=1 时不打开浏览器(测试用)。
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const here = (p) => join(ROOT, p);
const win = process.platform === "win32";
const ok = (m) => console.log("  ✓ " + m), warn = (m) => console.log("  ! " + m), bad = (m) => console.log("  ✗ " + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// .env 里可能配了 PANEL_PORT
try { await import(new URL("../env.mjs", import.meta.url).href); } catch {}
const PORT = Number(process.env.PANEL_PORT || 4400);
// 完整版(有交易页 panel/index.html)叫「面板」;导出的本机助手仓库没有交易页,叫「本机助手」(和 server.mjs 的 UI 同一个判断,PANEL_UI 可以强制)
const HELPER = process.env.PANEL_UI === "helper" || (process.env.PANEL_UI !== "full" && !existsSync(here("panel/index.html")));
const NAME = HELPER ? "本机助手" : "面板";
const URL_ = `http://127.0.0.1:${PORT}`;
const up = () => fetch(URL_ + "/health", { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
const open = () => { if (process.env.AGENTBUY_NO_OPEN === "1") return console.log("  → " + URL_); if (win) spawn("cmd", ["/c", "start", "", URL_], { detached: true, stdio: "ignore" }).unref(); else console.log("  打开 " + URL_); };
const npm = (args) => spawnSync(win ? "npm.cmd" : "npm", args, { cwd: ROOT, stdio: "inherit", shell: win }).status === 0;

console.log(`\n${HELPER ? "TIGER POWER 本机助手" : "TIGER POWER Terminal"} · 启动检查\n`);
// 能不能连上币安(登录、下单都要用;中国大陆等网络需要代理)。用子进程测,这样刚装好的依赖(代理要用)也能用上
function netCheck() {
  const probe = `import "./env.mjs"; import { getProxy } from "./proxy.mjs";
const t0 = Date.now(); const p = getProxy();
const ok = await fetch("https://www.binance.com/api/v3/ping", { signal: AbortSignal.timeout(8000) }).then((r) => r.ok).catch(() => false);
console.log(JSON.stringify({ ok, proxy: p, ms: Date.now() - t0 }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: ROOT, encoding: "utf8", timeout: 15000 });
  let res = null; try { res = JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()); } catch {}
  if (res?.ok) ok(`能连上币安${res.proxy ? `(走代理 ${res.proxy})` : ""}`);
  else {
    warn(`连不上币安服务器(www.binance.com)${res?.proxy ? `,当前代理 ${res.proxy} 也不通` : ""} —— 登录和下单都会失败`);
    console.log(`    中国大陆需要开代理:打开 Clash / v2rayN 等软件的「系统代理」(${NAME}会自动用上),`);
    console.log("    或者在项目根目录 .env 里加一行 HTTPS_PROXY=http://127.0.0.1:端口(Clash 一般 7890,v2rayN 一般 10809)。");
  }
}
if (await up()) { ok(`${NAME}已经在运行:${URL_}`); if (existsSync(here("node_modules/ethers/package.json"))) netCheck(); open(); process.exit(0); }

// 1. Node 版本
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) { bad(`Node.js 版本太旧(当前 ${process.versions.node}),需要 20 或更新:https://nodejs.org`); process.exit(1); }
ok(`Node.js ${process.versions.node}`);

// 2. 依赖
if (!existsSync(here("node_modules/ethers/package.json")) || !existsSync(here("node_modules/qrcode/package.json"))) {
  console.log("  … 第一次运行,安装依赖(npm install,大约 1 分钟)");
  if (!npm(["install", "--no-audit", "--no-fund"])) { bad("npm install 失败,检查网络后重新双击 start.cmd"); process.exit(1); }
}
ok("依赖已安装");

netCheck();

// 3. 币安 Agentic Wallet 命令行
const bawEntry = process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", "@binance", "agentic-wallet", "dist", "index.js");
const hasBaw = (bawEntry && existsSync(bawEntry)) || spawnSync(win ? "where" : "which", ["baw"], { stdio: "ignore" }).status === 0;
if (hasBaw) ok("币安 Agentic Wallet 命令行(baw)");
else {
  warn("没装币安 Agentic Wallet 命令行(baw),登录和下单都要用它");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question("    现在帮你安装吗?(npm i -g @binance/agentic-wallet) [Y/n] ")).trim().toLowerCase();
  rl.close();
  if (a === "" || a === "y" || a === "yes") { if (npm(["i", "-g", "@binance/agentic-wallet"])) ok("baw 已安装"); else warn("安装失败,之后自己运行:npm i -g @binance/agentic-wallet"); }
  else warn("跳过。之后自己运行:npm i -g @binance/agentic-wallet");
}
if (!existsSync(here("baw2/node_modules/@binance/agentic-wallet/dist/index.js"))) console.log("    (想同时用第二个币安账号:在 baw2 文件夹里运行 npm install,见 README)");

// 新版本:GitHub 上有重大更新就提醒一句(查不到不影响启动;页面上也会提示)
{
  const { checkUpdate, updateStatus } = await import("./update.mjs");
  await Promise.race([checkUpdate(), sleep(6000)]);
  const u = updateStatus();
  if (u.major) warn(`有重大更新 v${u.remote.version}:${u.remote.title}\n    ${u.git ? "在这个文件夹运行 git pull 再重新双击 start.cmd" : "去 " + u.page + " 下载最新压缩包,解压覆盖到这个文件夹"}`);
  else if (u.remote) ok(`已是最新版本 v${u.local.version}`);
}

// 4. 启动后台守护进程(没有窗口;代码改了自动重启,崩了自动拉起)
console.log(`  … 启动${NAME}`);
const env = { ...process.env, PANEL_PORT: String(PORT) };
if (win) spawn("wscript", [here("panel/daemon.vbs")], { cwd: here("panel"), env, detached: true, stdio: "ignore" }).unref();
else spawn(process.execPath, [here("panel/daemon.mjs")], { cwd: here("panel"), env, detached: true, stdio: "ignore" }).unref();
for (let i = 0; i < 25; i++) {
  await sleep(1000);
  if (await up()) { ok(`${NAME}已启动:${URL_}`); console.log(`\n浏览器打开后点「扫码登录」。这个窗口可以关掉,${NAME}会继续在后台运行。\n`); open(); process.exit(0); }
}
bad(`${NAME} 25 秒内没启动起来。最近的日志(panel/panel.log):\n`);
try { console.log(readFileSync(here("panel/panel.log"), "utf8").trim().split(/\r?\n/).slice(-15).join("\n")); } catch { console.log("  (还没有日志)"); }
process.exit(1);

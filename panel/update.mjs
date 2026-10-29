// 新版本提醒:每 6 小时看一次 GitHub 上的 version.json,有「重大更新」就在页面上提示怎么更新。
//   本机版本:项目根目录的 version.json。远端:按顺序试 GitHub raw → jsDelivr(GitHub 打不开时一般能访问)。
//   majorBuild = 最近一次重大更新的版本号;远端的 majorBuild 比本机 build 新才提示(跳过了几个版本也能提示到)。
//   只读一个公开的 JSON,不下载、不执行任何代码;更新由你自己做(git pull 或下载压缩包)。
//   .env 设 AGENTBUY_NO_UPDATE_CHECK=1 可以关掉。
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = (p) => fileURLToPath(new URL("../" + p, import.meta.url));
const localVersion = () => { try { return JSON.parse(readFileSync(root("version.json"), "utf8")); } catch { return { version: "?", build: 0 }; } };
// 查哪个仓库:本机 version.json 的 repo(本机助手仓库写的是 TIGER-POWER-Helper);没写或格式不对就是完整版
const repoOf = (r) => (typeof r === "string" && /^[\w.-]+\/[\w.-]+$/.test(r) ? r : "bzd6661/TIGER-POWER-Terminal");
export const REPO = repoOf(localVersion().repo);
const SOURCES = [
  `https://raw.githubusercontent.com/${REPO}/main/version.json`,
  `https://cdn.jsdelivr.net/gh/${REPO}@main/version.json`,
];

let state = { checkedAt: null, error: null, remote: null };
async function fetchRemote() {
  let last = null;
  for (const url of SOURCES) {
    try {
      const r = await fetch(url + "?t=" + Math.floor(Date.now() / 600_000), { signal: AbortSignal.timeout(8000), headers: { "cache-control": "no-cache" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!Number(j.build)) throw new Error("version.json 格式不对");
      return { ...j, source: new URL(url).host };
    } catch (e) { last = e; }
  }
  throw last ?? new Error("查不到");
}
export async function checkUpdate() {
  if (process.env.AGENTBUY_NO_UPDATE_CHECK === "1") return;
  try { state = { checkedAt: Date.now(), error: null, remote: await fetchRemote() }; }
  catch (e) { state = { ...state, checkedAt: Date.now(), error: String(e.message ?? e).slice(0, 120) }; }
}
export function updateStatus() {
  const local = localVersion(), remote = state.remote;
  const newer = !!remote && Number(remote.build) > Number(local.build || 0);
  const major = newer && Number(remote.majorBuild || 0) > Number(local.build || 0);
  return {
    local: { version: local.version, build: local.build, date: local.date },
    remote: remote ? { version: remote.version, build: remote.build, date: remote.date, title: remote.title, notes: remote.notes ?? [], source: remote.source } : null,
    newer, major, checkedAt: state.checkedAt, error: state.error,
    // 怎么更新:用 git 克隆的给命令,否则给压缩包地址
    git: existsSync(root(".git")), dir: fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, ""),
    zip: `https://github.com/${REPO}/archive/refs/heads/main.zip`, page: `https://github.com/${REPO}`,
  };
}
export function startUpdateCheck() {
  if (process.env.AGENTBUY_NO_UPDATE_CHECK === "1") return;
  setTimeout(() => checkUpdate().catch(() => {}), 15_000);   // 启动 15 秒后查第一次,不跟启动抢网络
  setInterval(() => checkUpdate().catch(() => {}), 6 * 3600_000).unref();
}

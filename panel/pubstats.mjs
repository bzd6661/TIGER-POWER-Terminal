// 网站访问统计(只给站长看):public-server.mjs 用。只存数字,不存 IP / 钱包地址 / 配对信息
//   每天:各页面打开次数、独立访客数(IP + 当天的盐做单向哈希,只存哈希前 12 位,第二天换盐)、国家、来源网站、页面上报的事件
//   存在数据目录的 stats.json(每分钟写一次;Cloudflare 部署时 boot.cjs 每 10 分钟把它存回 KV,重启接着算),保留 60 天
//   环境变量 STATS_KEY 没设:统计照记,但 /stats 页面不开放
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { dataFile } from "./datadir.mjs";

const FILE = dataFile("stats.json");
const KEEP_DAYS = 60, UV_MAX = 100_000, MAP_MAX = 200;
const KEY = String(process.env.STATS_KEY || "");
// 页面上报的事件:只认这几个名字
export const EVENTS = { login: "弹出登录窗口(没连助手时点登录 / 买卖)", connect: "点「连接本机助手」", paired: "配对成功", helper: "连着本机助手打开网站" };
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|go-http|headless/i;

let db = { days: {} };
try { const j = JSON.parse(readFileSync(FILE, "utf8")); if (j && typeof j.days === "object") db = j; } catch {}
let dirty = false;
const dayOf = (t = Date.now()) => new Date(t + 8 * 3600_000).toISOString().slice(0, 10);   // 按北京时间分天
function day(d = dayOf()) {
  const x = (db.days[d] ??= { pv: {}, uv: [], ref: {}, cc: {}, evt: {}, api: 0 });
  if (!x._uv) Object.defineProperty(x, "_uv", { value: new Set(x.uv), enumerable: false });
  return x;
}
const bump = (m, k, n = 1) => { if (k in m || Object.keys(m).length < MAP_MAX) m[k] = (m[k] ?? 0) + n; else m["(其他)"] = (m["(其他)"] ?? 0) + n; };
const uvHash = (ip, d) => createHash("sha256").update(`${KEY || "tp"}|${d}|${ip}`).digest("hex").slice(0, 12);

// 一次页面打开(GET 页面);机器人不算
export function pageView(req, ip, page) {
  const ua = String(req.headers["user-agent"] ?? "");
  if (!ua || BOT.test(ua)) return;
  const d = dayOf(), x = day(d);
  bump(x.pv, page);
  const h = uvHash(ip, d);
  if (!x._uv.has(h) && x._uv.size < UV_MAX) { x._uv.add(h); x.uv.push(h); }
  const cc = String(req.headers["cf-ipcountry"] ?? "").toUpperCase();
  if (/^[A-Z]{2}$/.test(cc)) bump(x.cc, cc);
  try {
    const r = new URL(String(req.headers.referer ?? ""));
    if (!/(^|\.)tigerpower\.online$/.test(r.hostname) && r.hostname !== "localhost" && r.hostname !== "127.0.0.1") bump(x.ref, r.hostname.replace(/^www\./, "").slice(0, 60));
  } catch {}
  dirty = true;
}
export function apiCall() { day().api++; dirty = true; }
export function event(name) { if (!Object.hasOwn(EVENTS, name)) return false; bump(day().evt, name); dirty = true; return true; }

function save() {
  if (!dirty) return;
  dirty = false;
  const cut = dayOf(Date.now() - KEEP_DAYS * 86400_000);
  for (const d of Object.keys(db.days)) if (d < cut) delete db.days[d];
  try { writeFileSync(FILE + ".tmp", JSON.stringify(db)); renameSync(FILE + ".tmp", FILE); } catch (e) { console.error("[stats] 存不了:", e.message); }
}
setInterval(save, 60_000).unref();
process.on("exit", save);

// /stats 的口令:STATS_KEY 没设就不开放;比较用定长哈希(不泄露长度、不能逐字猜)
export function keyOk(k) {
  if (!KEY || typeof k !== "string" || !k) return false;
  const a = createHash("sha256").update(k).digest(), b = createHash("sha256").update(KEY).digest();
  return timingSafeEqual(a, b);
}
export const statsEnabled = () => !!KEY;

// 汇总:今天 / 昨天 / 近 7 天 / 近 30 天
export function summary(live = {}) {
  const days = Object.keys(db.days).sort().reverse();
  const range = (n) => {
    const ds = days.filter((d) => d >= dayOf(Date.now() - (n - 1) * 86400_000));
    const agg = { pv: {}, ref: {}, cc: {}, evt: {}, api: 0, uv: 0, pvTotal: 0 };
    for (const d of ds) {
      const x = db.days[d];
      for (const [k, v] of Object.entries(x.pv)) { bump(agg.pv, k, v); agg.pvTotal += v; }
      for (const [k, v] of Object.entries(x.ref)) bump(agg.ref, k, v);
      for (const [k, v] of Object.entries(x.cc)) bump(agg.cc, k, v);
      for (const [k, v] of Object.entries(x.evt)) bump(agg.evt, k, v);
      agg.api += x.api; agg.uv += x.uv.length;   // 多天的独立访客是每天相加(跨天同一个人会算多次)
    }
    return agg;
  };
  const yesterday = (() => { const x = db.days[dayOf(Date.now() - 86400_000)]; return x ? { pvTotal: Object.values(x.pv).reduce((a, b) => a + b, 0), uv: x.uv.length } : { pvTotal: 0, uv: 0 }; })();
  return { today: range(1), yesterday, d7: range(7), d30: range(30), daily: days.slice(0, 30).map((d) => ({ d, pv: Object.values(db.days[d].pv).reduce((a, b) => a + b, 0), uv: db.days[d].uv.length, evt: db.days[d].evt })), live };
}

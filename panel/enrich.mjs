// 扫链页的补充数据:代币图片(本机缓存)+ GMGN trenches(每分钟最多一次)。
//   图片:各平台自己的来源优先 —— Gang(V1/V2/V3)用 gang.fun 的 logoUrl,four 用 four.meme 接口的 image,
//         ID Agent 用合约里的 IPFS 元数据(走 Pinata 网关),GMGN 收录的币用它的 logo;取到一次就存盘,以后只读本地。
//   GMGN:用 gmgn-cli 自己的 key(gmgn-cli 的默认配置位置),账户级限流 —— 每 3 分钟最多调一次 trenches,且只在扫链页开着时调;
//         只在每分钟的第 35–50 秒、且不在 5 的整数分钟调(避开同一个 key 上别的定时任务);遇到限流整体停 5 分钟。没配 key 就没有 GMGN 数据。
import { spawn } from "node:child_process";
import net from "node:net";
import { lookup as dnsLookupCb } from "node:dns";
import { promisify } from "node:util";
import { dataFile } from "./datadir.mjs";
const dnsLookup = promisify(dnsLookupCb);
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fetch as ufetch, Agent } from "undici";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const IMG_DIR = dataFile("img-cache/");
const LOGO_INDEX = dataFile("img-cache/index.json");
const PINATA = "https://gateway.pinata.cloud/ipfs/";
mkdirSync(IMG_DIR, { recursive: true });

// ---------- GMGN trenches ----------
const gmgn = { at: 0, pausedUntil: 0, running: false, map: new Map(), calls: 0, limited: 0, lastError: null };
function okWindow() {
  const d = new Date();
  return d.getSeconds() >= 35 && d.getSeconds() <= 50 && d.getMinutes() % 5 !== 0;
}
export function kickGmgn() {
  if (process.env.AGENTBUY_PUBLIC === "1") return;   // 公开服务器不用个人的 GMGN key
  if (gmgn.running || Date.now() < gmgn.pausedUntil || Date.now() - gmgn.at < 180_000 || !okWindow()) return;
  gmgn.running = true;
  gmgn.calls++;
  const ps = spawn("npx", ["-y", "gmgn-cli", "market", "trenches", "--chain", "bsc", "--limit", "80", "--raw"], { shell: true, windowsHide: true });
  let out = "", err = "";
  ps.stdout.on("data", (d) => (out += d));
  ps.stderr.on("data", (d) => (err += d));
  ps.on("close", () => {
    gmgn.running = false;
    gmgn.at = Date.now();
    if (/429|rate limit|banned/i.test(err + out.slice(0, 300))) {
      gmgn.limited++; gmgn.pausedUntil = Date.now() + 5 * 60_000; gmgn.lastError = (err || out).slice(0, 200);
      console.error(`[gmgn] 被限流,停 5 分钟:${gmgn.lastError}`);
      return;
    }
    try {
      const j = JSON.parse(out), root = j.data ?? j, map = new Map();
      for (const k of Object.keys(root)) for (const x of root[k] ?? []) map.set(String(x.address).toLowerCase(), x);
      gmgn.map = map; gmgn.lastError = null;
      for (const [ca, x] of map) if (x.logo && !logos[ca]) logos[ca] = { url: x.logo };   // 顺手记下图片地址
    } catch { gmgn.lastError = (err || out).slice(0, 200); }
  });
}
export const gmgnInfo = (ca) => gmgn.map.get(ca);
export const gmgnStatus = () => ({ calls: gmgn.calls, limited: gmgn.limited, pausedS: Math.max(0, Math.round((gmgn.pausedUntil - Date.now()) / 1000)), lastAt: gmgn.at || null, lastError: gmgn.lastError, size: gmgn.map.size });

// ---------- 图片 ----------
let logos = {};
try { logos = JSON.parse(readFileSync(LOGO_INDEX, "utf8")); } catch {}
let saveT = null;
const saveIndex = () => { if (!saveT) saveT = setTimeout(() => { saveT = null; writeFile(LOGO_INDEX, JSON.stringify(logos)).catch(() => {}); }, 30_000); };
// 没找到 / 下载失败:内存里记 30 分钟(最多 5000 个),不写盘
const miss = new Map();
const missed = (ca) => { const t = miss.get(ca); return t && Date.now() - t < 30 * 60_000; };
const markMiss = (ca) => { miss.delete(ca); miss.set(ca, Date.now()); if (miss.size > 5000) miss.delete(miss.keys().next().value); };
const pending = new Map();
let active = 0;
const queue = [];
const limit = (fn) => new Promise((res, rej) => { queue.push([fn, res, rej]); pump(); });
function pump() {
  while (active < 3 && queue.length) {
    const [fn, res, rej] = queue.shift();
    active++;
    fn().then(res, rej).finally(() => { active--; pump(); });
  }
}
const cidUrl = (s) => (!s ? null : s.startsWith("http") ? s : PINATA + s.replace(/^ipfs:\/\//, "").replace(/^ipfs\//, ""));
// 元数据(JSON)也走 safeDownload:只许 https、只连公网地址、最多 256 KB(代币元数据是发币的人自己填的,不能信)
const getJson = async (u) => { const b = await safeDownload(u, 256 * 1024, 12000).catch(() => null); try { return b ? JSON.parse(b.toString("utf8")) : null; } catch { return null; } };

// 找图片地址:meta 来自扫链数据 { platform, uri }
async function resolveUrl(ca, meta) {
  if (logos[ca]?.url) return logos[ca].url;
  let url = null;
  if (meta?.platform === "gangv2" || meta?.platform === "gangv1") {
    const d = await getJson(`https://gang.fun/api/tokens/${ca}`);
    url = d?.logoUrl || d?.logoURI || null;
  } else if (meta?.platform === "gangv3") {
    const d = await getJson(`https://gang.fun/api/v3/tokens/${ca}`);
    url = d?.hasLogo === false ? null : d?.logoUrl || null;
  } else if (meta?.platform === "four") {
    const d = await getJson(`https://four.meme/meme-api/v1/private/token/get/v2?address=${ca}`);
    url = d?.data?.image || null;
  } else if (meta?.platform === "idagent" && meta.uri) {
    const m = await getJson(cidUrl(meta.uri));
    url = cidUrl(m?.image);
  }
  if (url) { logos[ca] = { url, tried: Date.now() }; saveIndex(); }
  return url;
}
// 图片地址来自代币的元数据(发币的人自己填的),不能信:
//   只许 https;每次请求(包括跳转后的地址)都先解析域名,落在本机 / 内网 / 保留地址就拒绝;最多跟 3 次跳转;
//   边下边数字节,超过 3 MB 立刻中断(不先整个下载完再判断)
const IMG_MAX = 3 * 1024 * 1024;
const BLOCK = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]) BLOCK.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) BLOCK.addSubnet(a, p, "ipv6");
function privateIp(ip) {
  const t = net.isIP(ip);
  return !t || BLOCK.check(ip, t === 4 ? "ipv4" : "ipv6");
}
// 真正连接时再查一次解析出来的地址(防止「检查时是公网、连接时换成内网」的 DNS 重绑定)
const guarded = new Agent({ connect: { lookup: (host, opts, cb) => dnsLookupCb(host, { ...opts, all: true }, (err, list) => {
  if (err) return cb(err);
  const ok = list.filter((x) => !privateIp(x.address));
  if (!ok.length || ok.length !== list.length) return cb(new Error("不允许的地址"));
  return opts?.all ? cb(null, ok) : cb(null, ok[0].address, ok[0].family);
}) } });
async function publicHttpsUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : (await dnsLookup(host, { all: true }).catch(() => [])).map((x) => x.address);
  if (!ips.length || ips.some(privateIp)) return null;
  return u;
}
export async function safeDownload(raw, max = IMG_MAX, totalMs = 20000) {
  let url = raw;
  const signal = AbortSignal.timeout(totalMs);   // 所有跳转共用一个总时限
  for (let hop = 0; hop < 4; hop++) {
    const u = await publicHttpsUrl(url);
    if (!u) return null;
    const r = await ufetch(u, { redirect: "manual", signal, dispatcher: guarded });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { url = new URL(r.headers.get("location"), u).href; continue; }
    if (!r.ok || !r.body) return null;
    if (Number(r.headers.get("content-length") || 0) > max) return null;
    const chunks = [];
    let n = 0;
    for await (const c of r.body) {
      n += c.length;   // 按解压后的字节数算
      if (n > max) { try { await r.body.cancel(); } catch {} return null; }
      chunks.push(Buffer.from(c));
    }
    return Buffer.concat(chunks);
  }
  return null;
}
function imageType(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;   // 不认 svg / html 等,避免把网页当图片回给浏览器
}
// 返回 { type, body } 或 null(没有图)
export async function tokenImage(ca, meta) {
  const file = IMG_DIR + ca + ".bin";
  if (existsSync(file)) {
    const body = readFileSync(file);
    return { type: imageType(body), body };
  }
  if (!meta && !logos[ca]?.url) return null;   // 不在扫链列表里、也没有已知图片地址的币:不去找(防止随便拿个地址来刷)
  if (missed(ca)) return null;   // 半小时内找过没有 / 下载失败,就别再找
  if (pending.has(ca)) return pending.get(ca);
  if (queue.length > 100) return null;   // 排队太长:这次先不给图
  const p = limit(async () => {
    const url = await resolveUrl(ca, meta);
    const body = url ? await safeDownload(url).catch(() => null) : null;
    const type = body ? imageType(body) : null;
    if (!type) { markMiss(ca); return null; }
    writeFileSync(file, body);
    return { type, body };
  }).finally(() => pending.delete(ca));
  pending.set(ca, p);
  return p;
}

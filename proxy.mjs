// 代理:网络连不上 www.binance.com(登录、下单都要用),需要走代理。
//   Node 不会自动用系统代理,所以这里统一处理,按顺序:
//   1. .env / 环境变量里的 HTTPS_PROXY(或 HTTP_PROXY / ALL_PROXY),比如 http://127.0.0.1:7890(Clash)、http://127.0.0.1:10809(v2rayN)
//   2. 没配就读 Windows 系统代理(Clash / v2rayN 打开「系统代理」时会设置)
//   面板运行中每 30 秒重新检查一次:中途打开 / 关掉系统代理不用重启面板。
//   本进程所有 fetch 都走代理;baw 子进程启动时也加载这个文件(见 accounts.mjs),一样走代理。
//   本机地址(127.0.0.1 / localhost)永远直连。AGENTBUY_NO_PROXY=1 时完全不用代理。
import { execFileSync } from "node:child_process";

const USER_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy || null;
const LOCAL = "127.0.0.1,localhost,::1";

function windowsProxy() {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8", timeout: 3000, windowsHide: true });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(out)) return null;
    const server = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/)?.[1];
    if (!server) return null;
    // 可能是 "127.0.0.1:7890" 或 "http=127.0.0.1:7890;https=127.0.0.1:7890"
    const one = server.includes("=") ? (server.match(/https=([^;]+)/) || server.match(/http=([^;]+)/))?.[1] : server;
    return one ? (/^\w+:\/\//.test(one) ? one : "http://" + one) : null;
  } catch { return null; }
}
export const detectProxy = () => (process.env.AGENTBUY_NO_PROXY === "1" ? null : USER_PROXY || windowsProxy());

let undici = null;
try { undici = await import("undici"); } catch { /* 没装 undici:代理不生效(npm install 会装上) */ }

// ---------- 不走代理时:币安的域名改用加密 DNS(DoH)解析 ----------
// 有些网络的普通 DNS 会把 www.binance.com 解析到假地址(比如土耳其的 156.233.67.243),连接直接超时;
// 浏览器能上是因为走了代理或「安全 DNS」。这里对币安相关域名改问阿里 / 腾讯的 DoH(国内能访问、答案是真的 CloudFront 地址),
// 其他域名照常用系统 DNS。查不到就退回系统 DNS。
import { lookup as sysLookup } from "node:dns";
import https from "node:https";
const DOH_HOSTS = /(^|\.)(binance\.com|binance\.info|binance\.me|bnbstatic\.com|binanceapi\.com)$/i;
const DOH = ["https://223.5.5.5/resolve?name=", "https://dns.alidns.com/resolve?name=", "https://doh.pub/resolve?name="];
const dohCache = new Map();   // host → { at, ips }
const getJson = (u) => new Promise((res, rej) => {
  const req = https.get(u, { timeout: 4000 }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
  req.on("error", rej); req.on("timeout", () => req.destroy(new Error("DoH timeout")));
});
async function dohResolve(host) {
  const hit = dohCache.get(host);
  if (hit && Date.now() - hit.at < 300_000) return hit.ips;
  for (const base of DOH) {
    try {
      const j = await getJson(base + encodeURIComponent(host) + "&type=1");
      const ips = (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
      if (ips.length) { dohCache.set(host, { at: Date.now(), ips }); return ips; }
    } catch { /* 换下一个 */ }
  }
  return null;
}
function smartLookup(host, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  if (!DOH_HOSTS.test(host)) return sysLookup(host, opts, cb);
  dohResolve(host).then((ips) => {
    if (!ips) return sysLookup(host, opts, cb);
    if (opts?.all) return cb(null, ips.map((address) => ({ address, family: 4 })));
    cb(null, ips[0], 4);
  }, () => sysLookup(host, opts, cb));
}
let current;
function apply(p) {
  if (p === current) return;
  current = p;
  if (p) {
    process.env.HTTPS_PROXY = process.env.HTTP_PROXY = p;   // 子进程(baw、各脚本)继承
    if (!String(process.env.NO_PROXY ?? "").includes("127.0.0.1")) process.env.NO_PROXY = process.env.NO_PROXY ? process.env.NO_PROXY + "," + LOCAL : LOCAL;
  } else if (!USER_PROXY) {
    delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY;
  }
  if (!undici) { if (p) console.error("[代理] 没装 undici,代理没生效(在项目根目录运行 npm install)"); return; }
  // undici 会打印一句「EnvHttpProxyAgent 是实验功能」的警告,混进脚本输出里没用:只屏蔽这一条
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => { if (/EnvHttpProxyAgent is experimental/.test(String(w))) return; return emit.call(process, w, ...rest); };
  try { undici.setGlobalDispatcher(p ? new undici.EnvHttpProxyAgent() : new undici.Agent({ connect: { lookup: smartLookup } })); } finally { process.emitWarning = emit; }
}
apply(detectProxy());
setInterval(() => apply(detectProxy()), 30_000).unref();   // unref:不会让短命的脚本因为这个定时器不退出

export const getProxy = () => current;

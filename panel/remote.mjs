// 远程使用自己的面板:Cloudflare Tunnel 把一个子域名(比如 trade.example.com)接到本机 127.0.0.1:4400,前面挡一层 Cloudflare Access 登录。
//   面板自己再验一遍 Access 发的登录凭证(JWT,RS256):就算隧道 / Access 哪天配错了,没登录的请求也进不来。
//   .env 里三个都填了才开:
//     PANEL_REMOTE_HOST  远程网址的主机名,比如 trade.example.com
//     CF_ACCESS_TEAM     Zero Trust 团队域名,比如 myteam.cloudflareaccess.com
//     CF_ACCESS_AUD      Access 应用的 AUD 标签(应用概览页里那串很长的)
//   通过验证的请求按本机请求处理(和在家打开 127.0.0.1:4400 一样,什么都能做)。
import { createPublicKey, verify as rsaVerify } from "node:crypto";

const conf = () => ({
  host: String(process.env.PANEL_REMOTE_HOST || "").trim().toLowerCase(),
  team: String(process.env.CF_ACCESS_TEAM || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, ""),
  aud: String(process.env.CF_ACCESS_AUD || "").trim(),
});
export const remoteEnabled = () => { const c = conf(); return !!(c.host && c.team && c.aud); };
export const remoteHost = () => conf().host;
// 这个请求是冲着远程网址来的吗(Host 头,忽略端口和大小写)
export function isRemoteHost(hostHeader) {
  const c = conf();
  return !!c.host && String(hostHeader ?? "").toLowerCase().replace(/:\d+$/, "") === c.host;
}
// 经过 Cloudflare 转来的请求都带这几个头;不是冲着远程网址来的就一律拒绝(防止隧道把 Host 改成 127.0.0.1 后被当成本机请求)
export const viaCloudflare = (req) => !!(req.headers["cf-ray"] || req.headers["cf-connecting-ip"] || req.headers["cf-access-jwt-assertion"]);

// ── Access 公钥(JWKS):缓存 1 小时;遇到不认识的 kid 最多 1 分钟重新取一次 ──
let keys = null, keysAt = 0, lastFetch = 0;
async function loadKeys(team, fetchImpl, force = false) {
  const now = Date.now();
  if (keys && !force && now - keysAt < 3600_000) return keys;
  if (force && now - lastFetch < 60_000 && keys) return keys;
  lastFetch = now;
  const r = await fetchImpl(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("取不到 Access 公钥 HTTP " + r.status);
  const j = await r.json();
  keys = new Map((j.keys ?? []).filter((k) => k.kid && k.kty === "RSA").map((k) => [k.kid, createPublicKey({ key: k, format: "jwk" })]));
  keysAt = now;
  return keys;
}
export const _resetKeys = () => { keys = null; keysAt = 0; lastFetch = 0; };   // 测试用

const b64json = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
// 验 Access 凭证:请求头 Cf-Access-Jwt-Assertion(Access 加的),没有就看 CF_Authorization cookie。成功返回 { email },失败抛错
export async function verifyAccess(req, { fetchImpl = fetch, now = Date.now() } = {}) {
  const c = conf();
  if (!remoteEnabled()) throw new Error("远程访问没开");
  const tok = String(req.headers["cf-access-jwt-assertion"] ?? "") || /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(String(req.headers.cookie ?? ""))?.[1] || "";
  const parts = tok.split(".");
  if (parts.length !== 3) throw new Error("没有登录凭证");
  let head, pay;
  try { head = b64json(parts[0]); pay = b64json(parts[1]); } catch { throw new Error("凭证格式不对"); }
  if (head.alg !== "RS256" || !head.kid) throw new Error("凭证算法不对");
  let ks = await loadKeys(c.team, fetchImpl);
  if (!ks.has(head.kid)) ks = await loadKeys(c.team, fetchImpl, true);
  const key = ks.get(head.kid);
  if (!key) throw new Error("凭证的公钥不认识");
  if (!rsaVerify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, Buffer.from(parts[2], "base64url"))) throw new Error("凭证签名不对");
  const auds = Array.isArray(pay.aud) ? pay.aud : [pay.aud];
  if (!auds.includes(c.aud)) throw new Error("凭证不是给这个应用的");
  if (pay.iss !== `https://${c.team}`) throw new Error("凭证签发方不对");
  const t = Math.floor(now / 1000);
  if (!(pay.exp > t)) throw new Error("凭证过期了");
  if (pay.nbf && pay.nbf > t + 60) throw new Error("凭证还没生效");
  return { email: pay.email ?? null };
}

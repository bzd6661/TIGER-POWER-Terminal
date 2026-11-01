// 远程网址(Cloudflare Tunnel + Access):面板自己验 Access 登录凭证
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

process.env.PANEL_REMOTE_HOST = "trade.example.com";
process.env.CF_ACCESS_TEAM = "myteam.cloudflareaccess.com";
process.env.CF_ACCESS_AUD = "aud-123";
const r = await import("../panel/remote.mjs");

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
let fetches = 0;
const fetchImpl = async (url) => { fetches++; assert.equal(url, "https://myteam.cloudflareaccess.com/cdn-cgi/access/certs"); return new Response(JSON.stringify({ keys: [jwk] })); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const NOW = 1_800_000_000_000;
function jwt(pay = {}, { kid = "k1", key = privateKey, alg = "RS256" } = {}) {
  const h = b64({ alg, kid, typ: "JWT" });
  const p = b64({ aud: ["aud-123"], iss: "https://myteam.cloudflareaccess.com", exp: NOW / 1000 + 600, email: "me@example.com", ...pay });
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(h + "." + p), key).toString("base64url")}`;
}
const req = (tok, extra = {}) => ({ headers: { host: "trade.example.com", "cf-access-jwt-assertion": tok, ...extra } });
beforeEach(() => { r._resetKeys(); fetches = 0; });

test("Host 判断:只认配置的远程主机名(忽略端口、大小写)", () => {
  assert.equal(r.remoteEnabled(), true);
  assert.equal(r.isRemoteHost("trade.example.com"), true);
  assert.equal(r.isRemoteHost("TRADE.example.com:443"), true);
  assert.equal(r.isRemoteHost("127.0.0.1:4400"), false);
  assert.equal(r.isRemoteHost("evil.trade.example.com"), false);
  assert.equal(r.isRemoteHost(undefined), false);
});

test("有效凭证通过,返回邮箱;公钥缓存只取一次", async () => {
  assert.deepEqual(await r.verifyAccess(req(jwt()), { fetchImpl, now: NOW }), { email: "me@example.com" });
  await r.verifyAccess(req(jwt()), { fetchImpl, now: NOW });
  assert.equal(fetches, 1);
});

test("没有请求头时认 CF_Authorization cookie", async () => {
  const q = { headers: { host: "trade.example.com", cookie: `a=1; CF_Authorization=${jwt()}; b=2` } };
  assert.equal((await r.verifyAccess(q, { fetchImpl, now: NOW })).email, "me@example.com");
});

test("各种坏凭证都拒绝", async () => {
  const bad = async (tok, msg) => assert.rejects(r.verifyAccess(req(tok), { fetchImpl, now: NOW }), { message: msg });
  await bad("", "没有登录凭证");
  await bad("a.b", "没有登录凭证");
  await bad(jwt({}, { key: other.privateKey }), "凭证签名不对");             // 别人的私钥签的
  await bad(jwt({ aud: ["other-app"] }), "凭证不是给这个应用的");
  await bad(jwt({ iss: "https://evil.cloudflareaccess.com" }), "凭证签发方不对");
  await bad(jwt({ exp: NOW / 1000 - 1 }), "凭证过期了");
  await bad(jwt({ nbf: NOW / 1000 + 3600 }), "凭证还没生效");
  await bad(jwt({}, { kid: "nope" }), "凭证的公钥不认识");
  const [h, p, s] = jwt().split(".");
  await bad(`${b64({ alg: "none", kid: "k1" })}.${p}.${s}`, "凭证算法不对");
  const tampered = b64({ aud: ["aud-123"], iss: "https://myteam.cloudflareaccess.com", exp: NOW / 1000 + 600, email: "attacker@example.com" });
  await bad(`${h}.${tampered}.${s}`, "凭证签名不对");                        // 改了内容、签名对不上
});

test("经 Cloudflare 转来的请求能认出来(这类请求不能当本机请求)", () => {
  assert.equal(r.viaCloudflare({ headers: { "cf-ray": "x" } }), true);
  assert.equal(r.viaCloudflare({ headers: { "cf-connecting-ip": "1.2.3.4" } }), true);
  assert.equal(r.viaCloudflare({ headers: { host: "127.0.0.1:4400" } }), false);
});

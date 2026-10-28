// 本机登录状态 + 面板里扫码登录。
//   账号 1 = 全局 baw(登录凭证在 Windows 凭据管理器),账号 2 = agentbuy/baw2 里单独装的 baw(凭证在 baw2/.baw,装了才有这个槽位)。
//   登录信息只留在本机,代码里不写死任何地址:谁的电脑登录了谁的钱包,面板就显示谁的。
//   已经登录的账号绝不会再发起 signin(免得把现有会话顶掉)。
//   地址锁定:每个账号槽位第一次登录时记下地址(panel/wallet-pins.json,只在本机);以后扫码登录上来的地址不一样
//   (扫错了账号)就立刻登出这个会话并提示。确实要换钱包,在面板里「解除锁定」再登录。
//   掉线提醒:每分钟查一次登录状态,已登录的号连续 2 次查到没登录才算掉线(避免误报),通知一次;自己点退出的不算。
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { bawSpawn, BAW2_ENTRY } from "../accounts.mjs";
import { getProxy } from "../proxy.mjs";

const PINS = fileURLToPath(new URL("./wallet-pins.json", import.meta.url));
const readPins = () => { try { return JSON.parse(readFileSync(PINS, "utf8")) || {}; } catch { return {}; } };
export const pinOf = (acct) => readPins()[acct] ?? null;
function setPin(acct, address) { const p = readPins(); if (address) p[acct] = address; else delete p[acct]; try { writeFileSync(PINS, JSON.stringify(p, null, 2)); } catch {} }
export function unpin(acct) { setPin(acct, null); return { ok: true }; }
const sameAddr = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const walletFile = (acct) => fileURLToPath(new URL(acct === "2" ? "../.wallet2" : "../.wallet", import.meta.url));

// baw 调不起来时输出的是一整段 Node 报错:挑出「Error: …」那一行,没有就取第一行
const bawErrText = (t) => { const s = String(t || "").trim(); if (!s) return "baw 没有输出"; const m = s.match(/(?:^|\n)\s*(?:\w*Error): ([^\n]+)/); return (m ? m[1] : s.split("\n")[0]).trim().slice(0, 200); };
export function bawJson(acct, args, timeoutMs = 60_000) {
  return new Promise((res) => {
    let out = "", err = "", done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); res(v); } };
    let ps;
    try { ps = bawSpawn(acct, [...args, "--json"]); } catch (e) { return finish({ success: false, noBaw: true, error: { message: e.message } }); }
    const t = setTimeout(() => { ps.kill(); finish({ success: false, noBaw: true, error: { message: "baw 超时没响应" } }); }, timeoutMs);
    ps.on("error", (e) => finish({ success: false, noBaw: true, error: { message: e.message } }));
    ps.stdout.on("data", (d) => (out += d));
    ps.stderr?.on("data", (d) => (err += d));
    ps.on("close", () => { try { finish(JSON.parse(out)); } catch { finish({ success: false, noBaw: true, error: { message: bawErrText(out || err) } }); } });
  });
}

// 本机有哪些账号槽位:账号 1 总有;账号 2 要先在 agentbuy/baw2 里 npm install
export const slots = () => (existsSync(BAW2_ENTRY) ? ["1", "2"] : ["1"]);

let cache = null, refreshing = null;
const wrongLogin = {};   // acct → true:刚扫错了号、正在登出,这段时间别把错的地址锁上
// 登录状态很少变:有缓存就先用(10 分钟内),超过 30 秒在后台刷新,不让下单等 baw
export async function sessions({ force = false } = {}) {
  // 有账号调不起 baw(刚装好 / 刚修好)时只缓存 15 秒,装完刷新页面就能看到
  const ttl = cache && Object.values(cache.data).some((x) => !x.installed) ? 15_000 : 600_000;
  if (!force && cache && Date.now() - cache.at < ttl) {
    if (Date.now() - cache.at > 30_000 && !refreshing) refreshing = sessions({ force: true }).catch(() => {}).finally(() => (refreshing = null));
    return cache.data;
  }
  const data = {};
  await Promise.all(slots().map(async (acct) => {
    const st = await bawJson(acct, ["wallet", "status"], 30_000);
    const status = st?.data?.status ?? null;
    const s = { acct, installed: !st.noBaw, status, connected: status === "CONNECTED", address: null, error: st.noBaw ? st.error?.message : null };
    if (s.connected) {
      const ad = await bawJson(acct, ["wallet", "address"], 30_000);
      s.address = ad?.data?.addresses?.find((x) => x.binanceChainId === "56")?.address ?? null;
      if (s.address && !process.env.AGENTBUY_DEMO) try { writeFileSync(walletFile(acct), s.address); } catch {}   // 给命令行脚本用的地址缓存(演示模式不写)
      if (s.address && !process.env.AGENTBUY_DEMO && !pinOf(acct) && !wrongLogin[acct]) setPin(acct, s.address);
    }
    data[acct] = s;
  }));
  cache = { at: Date.now(), data };
  return data;
}
// 已登录账号的地址 { "1": "0x…", "2": "0x…" }
export async function addresses() {
  if (process.env.AGENTBUY_PUBLIC === "1") return {};   // 公开服务器:没有任何钱包
  const s = await sessions();
  return Object.fromEntries(Object.values(s).filter((x) => x.connected && x.address).map((x) => [x.acct, x.address]));
}

// ---------- 扫码登录 ----------
const logins = {};   // acct → { state: pending|ok|fail|expired, url, code, expireAt, svg, address, error, ps }
// 连不上币安服务器(中国大陆等网络常见):告诉用户怎么开代理
const NET_ERR = /timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|NETWORK_ERROR|fetch failed|socket|connect/i;
const NET_HINT = () => getProxy()
  ? `\n\n现在走的代理是 ${getProxy()},但还是连不上币安:检查代理软件是否在运行、节点能否打开 binance.com。`
  : "\n\n连不上币安服务器(www.binance.com)。在中国大陆需要开代理:打开 Clash / v2rayN 等代理软件的「系统代理」(面板 30 秒内自动用上),或者在项目根目录的 .env 里加一行 HTTPS_PROXY=http://127.0.0.1:端口(Clash 一般是 7890,v2rayN 一般是 10809),然后重试。";
export async function loginStart(acct) {
  if (!slots().includes(acct)) throw new Error(acct === "2" ? "这台电脑没装账号 2 的 baw(agentbuy/baw2 里 npm install)" : "账号不对");
  const s = (await sessions({ force: true }))[acct];
  if (s.connected) throw new Error(`账号${acct} 已经登录了`);
  if (!s.installed && acct === "1") throw new Error(`调不起 baw:${s.error ?? ""}。先装:npm i -g @binance/agentic-wallet`);
  logins[acct]?.ps?.kill();
  const r = await bawJson(acct, ["auth", "signin"], 30_000);
  if (!r.success || !r.data?.qrCodeId) {
    const msg = r.error?.message ?? JSON.stringify(r).slice(0, 200);
    throw new Error("生成登录二维码失败:" + msg + (NET_ERR.test(msg) ? NET_HINT() : ""));
  }
  const { qrCodeId, expireAt, urlForWeb, pairingCode } = r.data;
  const L = (logins[acct] = {
    state: "pending", url: urlForWeb, code: pairingCode ?? null, expireAt: Number(expireAt) || Date.now() + 5 * 60_000,
    svg: await QRCode.toString(urlForWeb, { type: "svg", margin: 1, color: { dark: "#000000", light: "#ffffff" } }),
  });
  // 后台等扫码:verify 会一直轮询到钱包建好或者码过期
  const ps = (L.ps = bawSpawn(acct, ["auth", "verify", "--qrCodeId", qrCodeId, "--json"]));
  let out = "";
  ps.stdout.on("data", (d) => (out += d));
  ps.on("error", () => {});
  ps.on("close", async () => {
    if (logins[acct] !== L) return;   // 已经重新生成了新码
    L.ps = null;
    const pin = pinOf(acct);
    wrongLogin[acct] = true;
    const now = (await sessions({ force: true }))[acct];
    if (now.connected && pin && now.address && !sameAddr(now.address, pin)) {
      // 扫错账号:立刻登出这个会话,不让它下单
      await bawJson(acct, ["auth", "signout"], 30_000).catch(() => {});
      cache = null; delete wrongLogin[acct];
      L.state = "wrong"; L.address = now.address;
      L.error = `扫错账号了:账号${acct} 锁定的是 ${pin},刚登录的是 ${now.address},已自动退出。请用对应的币安账号重新扫码;确实要换钱包,先点「解除锁定」`;
      return;
    }
    delete wrongLogin[acct];
    if (now.connected) { if (!pin && now.address) setPin(acct, now.address); L.state = "ok"; L.address = now.address; dropState[acct] = { on: true, miss: 0 }; return; }
    let j = null; try { j = JSON.parse(out); } catch {}
    L.state = Date.now() > L.expireAt ? "expired" : "fail";
    L.error = j?.error?.message ?? (out.trim().slice(0, 200) || null);
  });
  return loginStatus(acct);
}
export function loginStatus(acct) {
  const L = logins[acct];
  if (!L) return { state: "none", pin: pinOf(acct) };
  if (L.state === "pending" && Date.now() > L.expireAt + 15_000) { L.state = "expired"; L.ps?.kill(); }
  const { ps, ...rest } = L;
  return { ...rest, pin: pinOf(acct) };
}
export async function logout(acct) {
  if (!slots().includes(acct)) throw new Error("账号不对");
  dropState[acct] = { on: false, miss: 0 };   // 自己退出的不算掉线
  const r = await bawJson(acct, ["auth", "signout"], 30_000);
  if (!process.env.AGENTBUY_DEMO) try { unlinkSync(walletFile(acct)); } catch {}
  delete logins[acct];
  cache = null;
  if (!r.success) throw new Error("退出失败:" + (r.error?.message ?? ""));
  return { ok: true };
}

// ---------- 掉线提醒 ----------
const dropState = {};   // acct → { on: 上次是登录状态, miss: 连续几次没登录 }
export function startDropoutWatch(onDrop) {
  const tick = async () => {
    let ss; try { ss = await sessions({ force: true }); } catch { return; }
    for (const acct of slots()) {
      const st = (dropState[acct] ||= { on: false, miss: 0 }), s = ss[acct];
      if (s?.connected) { st.on = true; st.miss = 0; continue; }
      if (!st.on) continue;
      if (++st.miss >= 2) { st.on = false; st.miss = 0; try { onDrop(acct, pinOf(acct)); } catch {} }
    }
  };
  tick();
  setInterval(tick, 60_000);
}

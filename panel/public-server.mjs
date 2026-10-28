#!/usr/bin/env node
// TIGER POWER 公开只读版(部署在服务器上,所有人打开网址就能看):node panel/public-server.mjs
//   只提供数据:扫链、代币识别、K 线 / 成交、发币宣言 / 多空对决、涨跌、交易者盈亏、公开追踪动态、实时推送(新盘 / 成交 / 毕业)。
//   不加载任何钱包代码:没有 baw、没有下单 / 转账 / 授权 / 跟单 / 自动转出,服务器被攻破也动不了任何人的钱。
//   收藏、屏蔽、追踪名单存在访客自己的浏览器里(panel/public.js),服务器不记录谁在看什么。
//   环境变量:PORT(默认 8080)、HOST(默认 0.0.0.0)、PUBLIC_ORIGINS(允许的网址,逗号分隔)、TRUST_PROXY=1(在 Cloudflare / 反向代理后面时按转发头取访客 IP)
process.env.AGENTBUY_PUBLIC = "1";   // 必须在加载其他模块之前:让 session / enrich 进入公开模式(不读钱包、不用个人 GMGN key)

const http = await import("node:http");
const { readFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { gzipSync } = await import("node:zlib");
const { isIPv6 } = await import("node:net");
// 兜底:某个请求里漏接的 Promise 报错只记日志,不让整个服务挂掉
process.on("unhandledRejection", (e) => console.error("[unhandled]", e?.message ?? e));
const { ethers } = await import("ethers");
const { scan, scanLite, tokenMeta, refreshScan } = await import("./scan.mjs");
const { tokenImage } = await import("./enrich.mjs");
const { recentTrades, handleOf } = await import("./trades.mjs");
const { history, traderStats, invalidate } = await import("./history.mjs");
const { startLive, bus, liveStatus } = await import("./live.mjs");
const { startFlapNft } = await import("./flapnft.mjs");
const { bnbUsd } = await import("./prices.mjs");
const { tradeStats, detectCached, gangNotes, tickerOf } = await import("./readapi.mjs");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const ORIGINS = new Set(String(process.env.PUBLIC_ORIGINS || "https://tigerpower.online,https://www.tigerpower.online").split(",").map((s) => s.trim()).filter(Boolean));
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const t0 = Date.now();

// ---------- 访客 IP 和限速 ----------
function ipOf(req) {
  // X-Real-IP 由前面的 Caddy / Cloudflare Worker 填(只信 Cloudflare 给的访客 IP,访客自己伪造的会被覆盖)
  return ipKey(TRUST_PROXY ? String(req.headers["x-real-ip"] || req.headers["cf-connecting-ip"] || req.socket.remoteAddress).trim() : req.socket.remoteAddress || "?");
}
// IPv6 按 /64 算一个访客(一台机器通常就有一整段 /64,按单个地址限速等于没限);IPv4 映射写法还原成 IPv4
function ipKey(ip) {
  const v = String(ip).toLowerCase();
  const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  if (!isIPv6(v)) return v;
  const [head, tail = ""] = v.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const full = v.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
// 令牌桶:每个 IP 每秒补 rate 个,最多攒 burst 个
const buckets = new Map();
function allow(ip, cost = 1, rate = 8, burst = 40) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: burst, at: now }; buckets.set(ip, b); }
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
  b.at = now;
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}
setInterval(() => { const cut = Date.now() - 600_000; for (const [k, b] of buckets) if (b.at < cut) buckets.delete(k); }, 300_000).unref();
// 重的接口(要拉历史 / 识别)多扣几个令牌
const COST = { "/api/history": 4, "/api/tradespage": 2, "/api/inspect": 3, "/api/trader": 3, "/api/ticker": 3, "/api/pub/feed": 2, "/api/notes": 3, "/api/trades": 3, "/api/prefetch": 3 };

// ---------- 实时推送:只推公开行情 ----------
const streams = new Set();
const perIp = new Map();
const MAX_STREAMS = Number(process.env.MAX_STREAMS || 3000), MAX_PER_IP = 4;
const pubLive = () => { const l = liveStatus(); return { ...l, lastError: l.lastError ? scrub(l.lastError) : l.lastError }; };
const PUBLIC_EVENTS = new Set(["trade", "launch", "graduate"]);
// 追踪动态:最近 24 小时所有内盘成交留在内存(最多 30 万条),按访客浏览器里的名单过滤
const ring = [];
const RING_MAX = 300_000;
bus.on("event", (ev) => {
  if (ev.type === "trade" && ev.ca) invalidate(ev.ca);
  if (ev.type === "launch" || ev.type === "graduate") refreshScan();
  if (!PUBLIC_EVENTS.has(ev.type)) return;
  if (ev.type === "trade" && ev.trader) { ring.push(ev); if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX); }
  const line = "data: " + JSON.stringify(ev) + "\n\n";
  for (const r of streams) push(r, line);
});
// 推不动的连接(对方不收、积压超过 256 KB)直接断掉,别让内存越积越多;浏览器会自己重连
function push(r, s) { if (r.writableLength > 262_144) r.destroy(); else r.write(s); }
setInterval(() => {
  for (const r of streams) push(r, ": ping\n\n");
  const cut = Date.now() / 1000 - 86400;
  let i = 0; while (i < ring.length && Number(ring[i].ts || 0) < cut) i++;
  if (i) ring.splice(0, i);
}, 20_000).unref();

// ---------- 工具 ----------
async function body(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 8192) throw new Error("请求太大"); }
  return s ? JSON.parse(s) : {};
}
// 错误信息里可能带节点网址(有的带 key),发给访客前去掉
const scrub = (s) => String(s ?? "").replace(/(wss?|https?):\/\/[^\s"'\\]+/g, "<节点>");
// 序列化好的响应:{ s: JSON 字符串, gz: 压缩后的(懒算) }
const packed = (obj) => ({ s: JSON.stringify(obj), gz: null });
function send(res, code, p, maxAge = 0) {
  const head = { "content-type": "application/json; charset=utf-8", "cache-control": maxAge ? `public, max-age=${maxAge}, s-maxage=${maxAge}` : "no-store" };
  if (p.s.length > 4096 && /\bgzip\b/.test(res.req?.headers["accept-encoding"] ?? "")) {
    p.gz ??= gzipSync(p.s, { level: 6 });
    res.writeHead(code, { ...head, "content-encoding": "gzip", vary: "accept-encoding" }); return res.end(p.gz);
  }
  res.writeHead(code, head); res.end(p.s);
}
const json = (res, code, obj, maxAge = 0) => send(res, code, packed(obj), maxAge);
// 扫链结果对所有人一样:每份扫描结果只序列化 / 压缩一次
const scanPack = new WeakMap();
function scanPacked(d, lite) {
  let e = scanPack.get(d);
  if (!e) scanPack.set(d, (e = {}));
  return (e[lite ? "lite" : "full"] ??= packed(lite ? scanLite(d) : d));
}
// 热门代币很多人同时看:同样的请求 3 秒内只算一次(在算的也共用)
const micro = new Map();
async function cached(key, ms, fn) {
  const hit = micro.get(key);
  if (hit && (hit.p || Date.now() - hit.at < ms)) return hit.p ?? hit.v;
  const p = fn().then((obj) => { const v = packed(obj); micro.set(key, { at: Date.now(), v }); return v; }, (e) => { micro.delete(key); throw e; });
  micro.set(key, { p });
  return p;
}
setInterval(() => { const cut = Date.now() - 30_000; for (const [k, e] of micro) if (!e.p && e.at < cut) micro.delete(k); }, 30_000).unref();
const CSP = "default-src 'self'; img-src 'self'; frame-src https://www.gmgn.cc; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const SEC = { "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "strict-transport-security": "max-age=31536000" };
// 页面:令牌占位换成 public,并注入公开模式脚本(隐藏钱包 / 下单,本地化收藏和追踪名单)
const PAGES = { "/": "index.html", "/scan": "scan.html", "/track": "track.html" };
const pageCache = new Map();
function page(file) {
  if (pageCache.has(file) && process.env.NODE_ENV === "production") return pageCache.get(file);
  const html = readFileSync(here("./" + file), "utf8").replace("__PANEL_TOKEN__", "public")
    .replace("<script src=\"/i18n.js\"></script>", "<script src=\"/public.js\"></script>\n<script src=\"/i18n.js\"></script>")
    .replace("<script src=\"/update.js\" defer></script>\n", "");   // 公开版不用更新提醒(网页本来就是最新的)
  pageCache.set(file, html);
  return html;
}
const STATIC = { "/fmt.js": "fmt.js", "/icons.js": "icons.js", "/i18n.js": "i18n.js", "/public.js": "public.js", "/vendor/lightweight-charts.js": "vendor/lightweight-charts.js" };

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
  const ip = ipOf(req);
  let url;
  try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400); return res.end(); }   // 畸形请求行(比如 //:)别让整个进程崩掉
  const path = url.pathname;
  try {
    // 跨站请求一律拒绝(浏览器带 Origin 时必须是我们自己的网址)
    const origin = req.headers.origin;
    if (req.method === "POST" && origin && !ORIGINS.has(origin) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return json(res, 403, { error: "来源不允许" });
    if (path.startsWith("/api/") && !allow(ip, COST[path] ?? 1)) return json(res, 429, { error: "请求太频繁,稍等几秒" });

    // ---- 页面和静态文件 ----
    if (req.method === "GET" && PAGES[path]) { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-cache" }); return res.end(page(PAGES[path])); }
    if (req.method === "GET" && STATIC[path]) { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }); return res.end(readFileSync(here("./" + STATIC[path]))); }
    if (req.method === "GET" && (path === "/favicon.svg" || path === "/favicon.ico")) { res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }); return res.end(readFileSync(here("./favicon.svg"))); }
    const im = req.method === "GET" && path.match(/^\/img\/(0x[0-9a-f]{40})$/i);
    if (im) {
      if (!allow(ip, 0.5)) { res.writeHead(429); return res.end(); }
      const ca = im[1].toLowerCase();
      // 只给扫链列表里的币找图(随便拿个地址来刷不会触发任何外部请求)
      const img = tokenMeta(ca) ? await tokenImage(ca, tokenMeta(ca)).catch(() => null) : null;
      if (!img || !img.type) { res.writeHead(404, { "cache-control": "public, max-age=600" }); return res.end(); }
      res.writeHead(200, { "content-type": img.type, "cache-control": "public, max-age=86400" });
      return res.end(img.body);
    }
    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, up: Math.round((Date.now() - t0) / 1000), streams: streams.size, ring: ring.length, memMb: Math.round(process.memoryUsage().rss / 1048576), live: pubLive() });
    if (req.method === "GET" && path === "/api/update-status") return json(res, 200, { major: false, public: true }, 300);

    // ---- 实时推送 ----
    if (req.method === "GET" && path === "/api/stream") {
      const n = perIp.get(ip) ?? 0;
      if (streams.size >= MAX_STREAMS || n >= MAX_PER_IP) { res.writeHead(503, { "retry-after": "30" }); return res.end(); }
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 5000\n\n");
      res.write("data: " + JSON.stringify({ type: "hello", live: pubLive(), public: true }) + "\n\n");
      streams.add(res); perIp.set(ip, n + 1);
      // 每条连接最多 30 分钟,到点断开让浏览器重连(占着名额不放的连接会被轮换掉)
      const life = setTimeout(() => res.end(), 30 * 60_000);
      req.on("close", () => { clearTimeout(life); streams.delete(res); const m = (perIp.get(ip) ?? 1) - 1; if (m > 0) perIp.set(ip, m); else perIp.delete(ip); });
      return;
    }

    // ---- 只读数据接口(和本地版同路径同格式,页面代码不用改) ----
    if (req.method === "GET" && path === "/api/scan") return send(res, 200, scanPacked(await scan(), !url.searchParams.has("full")), 5);   // 给 CDN 缓存 5 秒
    if (req.method !== "POST") return json(res, 404, { error: "没有这个接口" });
    const b = await body(req);
    const needCa = () => { if (!ethers.isAddress(b.ca ?? "")) throw new Error("CA 格式不对"); return b.ca; };
    switch (path) {
      case "/api/scan": return send(res, 200, scanPacked(await scan(), b.lite === true));
      // 平台按我们自己识别的结果,不信请求里带的(不然能用任意平台名去刷 gang.fun)
      case "/api/trades": { const d = await detectCached(needCa(), 15_000); return json(res, 200, await recentTrades(d.ca, d.platform)); }
      // 预取只对扫链列表里的币做(页面上鼠标悬停时调用)
      case "/api/prefetch": { if (tokenMeta(needCa().toLowerCase())) detectCached(b.ca, 15_000).catch(() => {}); return json(res, 200, { ok: true }); }
      case "/api/inspect": return send(res, 200, await cached("i:" + needCa().toLowerCase(), 3_000, async () => {
        const d = { ...(await detectCached(b.ca, 15_000)) };
        delete d.wallets; d.holdings = {}; d.costs = {}; d.nftGate &&= { ...d.nftGate, wallets: {} };
        // Gang 的最近成交直接用 K 线那份(同一个接口,不重复拉);four 走链上
        const tr = d.platform?.startsWith("gang") ? await history(d).then((h) => ({ items: h.trades.slice(0, 60) })).catch(() => null)
          : d.platform === "four" ? await recentTrades(d.ca, d.platform).catch(() => null) : null;
        d.stats = tradeStats(tr?.items);
        if (d.platform === "four" || d.platform === "gangv1") d.quoteUsd = d.quoteUsd ?? (await bnbUsd());
        if (d.platform === "idagent" && !d.mcUsd) {
          const h = await history(d).catch(() => null);
          const last = h?.points?.at(-1);
          if (last && h.supply) { d.mcUsd = last.p * h.supply; d.mcEstimated = true; }
          if (h?.trades?.[0]) d.lastTradeAt = h.trades[0].ts;
        }
        if (d.platform === "four") {
          const last = tr?.items?.[0];
          if (last && d.stage === "inner" && d.saleAmount) { d.progress = Math.min(100, ((d.saleAmount - last.remaining) / d.saleAmount) * 100); d.lastTradeAt = last.ts; }
          if (last) { d.priceQuote = last.price; d.mcUsd = last.price * d.supply * (d.quoteUsd ?? 0) || null; }
        }
        d.public = true;
        return d;
      }));
      case "/api/history": return send(res, 200, await cached("h:" + needCa().toLowerCase(), 3_000, async () => {
        const d = await detectCached(b.ca);
        const h = await history(d);
        return { source: h.source, partial: h.partial, quote: h.quote, quoteUsd: h.quoteUsd, supply: h.supply, supplyNote: h.supplyNote, points: h.points, dex: h.dex, total: h.trades.length, mine: [] };
      }));
      case "/api/notes": return send(res, 200, await cached("n:" + needCa().toLowerCase(), 5_000, () => gangNotes(b.ca.toLowerCase())));
      case "/api/ticker": {
        // 只给扫链列表里的币算涨跌,每个币再多扣 1 个令牌(一次最多 30 个币,每个都要拉 K 线)
        const list = [...new Set((Array.isArray(b.cas) ? b.cas : []).filter((c) => ethers.isAddress(c)).map((c) => c.toLowerCase()))].filter((ca) => tokenMeta(ca)).slice(0, 30);
        if (!allow(ip, list.length)) return json(res, 429, { error: "请求太频繁,稍等几秒" });
        const out = await Promise.all(list.map((ca) => tickerOf(ca).catch(() => null)));
        return json(res, 200, Object.fromEntries(list.map((ca, i) => [ca, out[i]])));
      }
      case "/api/tradespage": {
        // 参数先规整,缓存键和计算用同一组值(只许 100 / 200 / 500 条一页)
        const before = Number(b.before) > 0 ? Math.floor(Number(b.before)) : 0;
        const n = [100, 200, 500].includes(Number(b.limit)) ? Number(b.limit) : 100;
        return send(res, 200, await cached(`t:${needCa().toLowerCase()}:${before}:${n}`, 3_000, async () => {
        const d = await detectCached(b.ca);
        const h = await history(d);
        const start = before ? h.trades.findIndex((t) => t.ts < before) : 0;
        const items = start < 0 ? [] : h.trades.slice(start, start + n);
        // .ai 名字每次最多查 100 个(其余留空,下次翻页 / 刷新再补)
        const need = [...new Set(items.filter((t) => !t.handle).map((t) => t.trader))].slice(0, 100);
        const names = await Promise.all(need.map((a) => handleOf(a).catch(() => null)));
        const nm = Object.fromEntries(need.map((a, i) => [a, names[i]]));
        return { source: h.source, partial: h.partial, total: h.trades.length, end: start < 0 || start + n >= h.trades.length, items: items.map((t) => ({ ...t, handle: t.handle ?? nm[t.trader] ?? null })) };
        }));
      }
      case "/api/trader": {
        if (!ethers.isAddress(b.trader ?? "")) throw new Error("地址格式不对");
        const d = await detectCached(needCa());
        const st = await traderStats(d, b.trader);
        st.handle ??= await handleOf(b.trader.toLowerCase()).catch(() => null);
        return json(res, 200, st);
      }
      // 公开追踪动态:访客浏览器把自己的名单(最多 100 个地址)发过来,按最近 24 小时的成交过滤
      case "/api/pub/feed": {
        const set = new Set((Array.isArray(b.addresses) ? b.addresses : []).filter((a) => ethers.isAddress(a)).slice(0, 100).map((a) => a.toLowerCase()));
        const before = Number(b.before) || Infinity, n = Math.min(300, Math.max(1, Number(b.limit) || 150));
        const out = [];
        for (let i = ring.length - 1; i >= 0 && out.length < n; i--) { const e = ring[i]; if (e.ts < before && set.has(e.trader)) out.push(e); }
        return json(res, 200, { items: out, since: ring[0]?.ts ?? null });
      }
      case "/api/tip-info": return json(res, 200, JSON.parse(readFileSync(here("../contracts/tip.json"), "utf8")), 3600);
      case "/api/live-status": return json(res, 200, pubLive());
    }
    return json(res, 404, { error: "公开版没有这个功能(下单、钱包、跟单请用本地版)" });
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: scrub(e?.message ?? e).slice(0, 200) });
    else res.end();
  }
});
server.keepAliveTimeout = 65_000;
server.listen(PORT, HOST, () => {
  console.log(`TIGER POWER 公开只读版已启动:http://${HOST}:${PORT}(允许的网址:${[...ORIGINS].join(", ")})`);
  startLive().catch((e) => console.error("[实时] 启动失败", e.message));
  startFlapNft().catch((e) => console.error("[Flap 门槛盘] 启动失败", e.message));
  scan().catch(() => {});   // 启动就先扫一遍
});

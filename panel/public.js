// 公开版(tigerpower.online)专用:只由 public-server.mjs 注入,本地版不加载。
//   1. 界面和本地版一样(没登录的样子);点买卖 / 登录 / 钱包设置,或页面调到要钱包的接口时,弹「需要登录」说明。
//   2. 个人数据存在访客自己的浏览器里:收藏 / 屏蔽、追踪名单。页面照旧请求 /api/lists、/api/track…,在这里就地处理,不发到服务器。
//   3. 追踪动态:按本机名单向服务器取最近 24 小时的公开成交;实时推送里命中名单的成交,补发成「追踪」事件给页面。
(() => {
  window.TP_PUBLIC = true;
  document.documentElement.classList.add("tp-public");
  const GH = "https://github.com/bzd6661/TIGER-POWER-Terminal";

  // ---------- 界面和本地版一样;真正要用钱包的操作(买卖、登录、钱包 / 设置)弹「需要登录」 ----------
  const css = `
  .tp-lm { position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:200; display:flex; align-items:center; justify-content:center; padding:16px; }
  .tp-lm[hidden] { display:none; }
  .tp-lm .box { width:min(420px,100%); background:var(--panel, #14171d); border:1px solid var(--line, #262b34); border-radius:12px; padding:22px 22px 18px; color:var(--mute, #9aa3b2); font-size:13px; line-height:1.7; box-shadow:0 20px 60px rgba(0,0,0,.5); }
  .tp-lm h3 { margin:0 0 10px; color:var(--text, #e8ebf0); font-size:17px; }
  .tp-lm ul { margin:10px 0 0; padding-left:18px; }
  .tp-lm .row { display:flex; gap:10px; justify-content:flex-end; margin-top:18px; }
  .tp-lm .row a, .tp-lm .row button { padding:8px 14px; border-radius:8px; font:inherit; font-weight:700; cursor:pointer; text-decoration:none; }
  .tp-lm .row a { background:var(--acc, #f0b90b); color:#111; border:0; }
  .tp-lm .row button { background:transparent; color:var(--mute, #9aa3b2); border:1px solid var(--line, #262b34); }`;
  const st = document.createElement("style"); st.textContent = css;
  (document.head || document.documentElement).appendChild(st);
  let dlg = null;
  window.tpNeedLogin = () => {
    if (!dlg) {
      dlg = document.createElement("div");
      dlg.className = "tp-lm";
      dlg.innerHTML = `<div class="box" role="dialog" aria-modal="true"><h3>需要登录钱包</h3><div>下单要用你自己的币安 Agentic 钱包签名,网页上暂时还不能直接登录。</div>
        <ul><li>现在:下载本地版,在自己电脑上登录后就能一键买卖</li><li>网页直接连本地钱包的功能正在做</li></ul>
        <div class="row"><button type="button" data-x>知道了</button><a href="${GH}" target="_blank" rel="noopener">下载本地版 →</a></div></div>`;
      dlg.onclick = (e) => { if (e.target === dlg || e.target.closest("[data-x]")) dlg.hidden = true; };
      document.body.appendChild(dlg);
    }
    dlg.hidden = false;
  };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && dlg && !dlg.hidden) dlg.hidden = true; });
  // 点买卖按钮就直接提示(不等报价 / 确认框)
  const NEED = "#buyBox button, #sellBox button, #cfYes, [data-buy], [data-b], .card .buy, .msrow .buy, td .buy, .qbuy, #setBtn";
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.(NEED)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    window.tpNeedLogin();
  }, true);

  // ---------- 本机存储 ----------
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? ""));
  const lc = (a) => String(a ?? "").toLowerCase();
  const label = (s) => String(s ?? "").slice(0, 40);
  // 收藏 / 屏蔽(格式和本地版 lists.json 一样)
  let L = load("tp_lists", { groups: [{ id: "default", name: "默认" }], favs: {}, blockTokens: {}, blockDevs: {} });
  function listOp(b) {
    switch (b.op) {
      case "fav": { const ca = lc(b.ca); if (!isAddr(ca)) throw new Error("地址格式不对"); if (b.on) L.favs[ca] = { group: L.groups.some((g) => g.id === b.group) ? b.group : L.favs[ca]?.group ?? "default", symbol: label(b.symbol), platform: label(b.platform), at: L.favs[ca]?.at ?? Date.now() }; else delete L.favs[ca]; break; }
      case "addGroup": { const name = label(b.name).trim(); if (!name) throw new Error("分组名不能为空"); L.groups.push({ id: "g" + Date.now().toString(36), name }); break; }
      case "renameGroup": { const g = L.groups.find((x) => x.id === b.id); if (g) g.name = label(b.name).trim() || g.name; break; }
      case "deleteGroup": { if (b.id !== "default") { L.groups = L.groups.filter((x) => x.id !== b.id); for (const f of Object.values(L.favs)) if (f.group === b.id) f.group = "default"; } break; }
      case "blockToken": { const ca = lc(b.ca); if (b.on) L.blockTokens[ca] = { label: label(b.label), at: Date.now() }; else delete L.blockTokens[ca]; break; }
      case "blockDev": { const a = lc(b.address); if (b.on) L.blockDevs[a] = { label: label(b.label), at: Date.now() }; else delete L.blockDevs[a]; break; }
      default: throw new Error("不支持的操作");
    }
    save("tp_lists", L);
    return L;
  }
  // 追踪名单(只支持直接填地址;.ai / .bnb 名字解析要用币安钱包,公开版没有)
  let T = load("tp_track", { targets: [], groups: ["默认"] });
  const saveT = () => save("tp_track", T);
  const targetOf = (a) => T.targets.find((t) => t.address === lc(a));

  // 扫链数据里的名字 / 底池币,给追踪动态补上
  let meta = null, metaAt = 0;
  async function metaMap() {
    if (meta && Date.now() - metaAt < 60_000) return meta;
    try { const d = await realFetch("/api/scan").then((r) => r.json()); meta = Object.fromEntries(d.tokens.map((t) => [t.ca, t])); metaAt = Date.now(); } catch { meta = meta ?? {}; }
    return meta;
  }
  const QUOTE_BNB = new Set(["four", "gangv1", "idagent"]);
  function toFeed(e, m) {
    const t = targetOf(e.trader), s = m[e.ca] ?? {};
    const quote = e.quoteSym || (QUOTE_BNB.has(e.platform) ? "BNB" : s.quote || "");
    return { id: `${e.tx}:${e.li ?? 0}`, ts: e.ts, target: e.trader, targetName: t?.name || null, group: t?.group || "默认", side: e.side, platform: e.platform, ca: e.ca,
      market: e.market ?? null, symbol: s.symbol || e.ca.slice(0, 8), quote, quoteAmt: e.quote, usd: null, tokens: e.tokens, tx: e.tx, action: e.side === "buy" ? "买入" : "卖出", pct: null };
  }

  // ---------- 请求就地处理 ----------
  const realFetch = window.fetch.bind(window);
  const ok = (obj) => Promise.resolve(new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } }));
  const err = (msg) => Promise.resolve(new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "content-type": "application/json" } }));
  const NO_TRADE = "需要登录钱包";
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0];
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch {}
    try {
      switch (path) {
        // 扫链结果所有人都一样:改走 GET,Cloudflare 能缓存几秒,服务器不用每人算一遍
        case "/api/scan": return realFetch(body.lite ? "/api/scan?lite=1" : "/api/scan?full=1");
        case "/api/lists": return ok(L);
        case "/api/lists/op": return ok(listOp(body));
        case "/api/wallets": return ok({ sessions: [{ acct: "1", installed: true }], accounts: [], tokens: [], bnbUsd: null });
        case "/api/settings": return ok({ maxBuyBnb: 0, autoClaim: false });
        case "/api/autotransfer": return ok({ to: null, appConfirm: false, tokens: {} });
        case "/api/copy": return ok({ tasks: [], paused: false, log: [], defaults: {} });
        case "/api/approvals": return ok({ items: [] });
        case "/api/quote-balances": return ok({});
        case "/api/latency-stats": return ok({});
        case "/api/track": return ok({ ...T, status: { running: false, last: null, queued: [] }, hasPrivate: true, public: true });
        case "/api/track/add": {
          const a = lc(String(body.input ?? "").trim());
          if (!isAddr(a)) throw new Error("公开版只支持直接填地址(0x…);.ai / .bnb 名字请用本地版");
          const g = label(body.group || "默认") || "默认";
          if (!T.groups.includes(g)) T.groups.push(g);
          const cur = targetOf(a), v = { address: a, name: label(body.name ?? cur?.name ?? ""), handle: null, remark: label(body.remark ?? cur?.remark ?? ""), group: g, addedAt: cur?.addedAt ?? Date.now(), backfilledAt: Date.now() };
          if (!cur && T.targets.length >= 100) throw new Error("公开版最多追踪 100 个地址");
          if (cur) Object.assign(cur, v); else T.targets.push(v);
          saveT(); setTimeout(() => window.dispatchEvent(new CustomEvent("tp-track-list")), 0);
          return ok(v);
        }
        case "/api/track/update": { const t = targetOf(body.address); if (!t) throw new Error("没在关注这个地址"); if (body.name !== undefined) t.name = label(body.name); if (body.remark !== undefined) t.remark = label(body.remark); if (body.group !== undefined) { t.group = label(body.group) || "默认"; if (!T.groups.includes(t.group)) T.groups.push(t.group); } saveT(); window.dispatchEvent(new CustomEvent("tp-track-list")); return ok(t); }
        case "/api/track/remove": { T.targets = T.targets.filter((t) => t.address !== lc(body.address)); saveT(); window.dispatchEvent(new CustomEvent("tp-track-list")); return ok({ ok: true }); }
        case "/api/track/group": { const g = label(body.name).trim(); if (!g) throw new Error("分组名不能空"); if (body.op === "add" && !T.groups.includes(g)) T.groups.push(g); if (body.op === "delete" && g !== "默认") { T.groups = T.groups.filter((x) => x !== g); for (const t of T.targets) if (t.group === g) t.group = "默认"; } saveT(); window.dispatchEvent(new CustomEvent("tp-track-list")); return ok(T); }
        case "/api/track/backfill": return ok({ ok: true });
        case "/api/track/feed": {
          let addrs = T.targets.map((t) => t.address);
          if (body.target) addrs = addrs.filter((a) => a === lc(body.target));
          else if (body.group && body.group !== "all") addrs = T.targets.filter((t) => t.group === body.group).map((t) => t.address);
          if (!addrs.length) return ok({ items: [], more: false });
          const r = await realFetch("/api/pub/feed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ addresses: addrs, before: body.before, limit: body.limit }) });
          const d = await r.json(); if (!r.ok) throw new Error(d.error);
          const m = await metaMap();
          return ok({ items: d.items.map((e) => toFeed(e, m)), more: d.items.length >= (Number(body.limit) || 150) });
        }
        case "/api/run": case "/api/send": case "/api/tip": case "/api/quote": case "/api/approvals/revoke":
          window.tpNeedLogin(); return err(NO_TRADE);
      }
      if (path.startsWith("/api/login/") || path.startsWith("/api/autotransfer/") || path.startsWith("/api/copy/") || path === "/api/settings/set") { window.tpNeedLogin(); return err(NO_TRADE); }
    } catch (e) { return err(e.message); }
    return realFetch(input, init);
  };

  // ---------- 实时推送:命中本机追踪名单的成交,补发成「追踪」事件 ----------
  const RealES = window.EventSource;
  window.EventSource = class extends RealES {
    constructor(url, opts) {
      super(url, opts);
      this.addEventListener("message", (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.type !== "trade" || !ev.trader || !targetOf(ev.trader)) return;
        metaMap().then((mm) => {
          const e = { type: "track", ...toFeed(ev, mm) };
          const fake = new MessageEvent("message", { data: JSON.stringify(e) });
          if (typeof this.onmessage === "function") this.onmessage(fake);
        });
      });
    }
  };
  // 追踪名单改了:让追踪页重新读名单(本地版靠服务器推 track-list 事件)
  window.addEventListener("tp-track-list", () => {
    if (typeof window.loadList === "function") window.loadList().then(() => window.loadFeed?.());
  });
})();

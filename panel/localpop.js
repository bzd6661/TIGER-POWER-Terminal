// 本机页面共用的弹窗(本机助手页 helper.html,和完整面板的交易 / 扫链 / 追踪三个页面):
//   网站请求配对 → 大号配对码;网站请求转账 / 改设置这类操作 → 批准框(「批准」/「拒绝」);网站请本机登录 → 弹扫码登录。
//   页面在 TOKEN 定好之后调 window.tpLocalPop?.init(() => TOKEN):这个脚本自己连一条本机事件流(批准 / 配对 / 登录请求只推给本机页面)。
//   页面自己已经开着事件流的(交易 / 扫链 / 追踪页)调 init(() => TOKEN, { stream: false }),再把收到的每条事件交给 window.tpLocalPop?.event(ev):
//   浏览器对同一个地址(127.0.0.1:4400)最多同时开 6 条连接,每个页面两条推送的话,三个页面一开就占满,别的请求全卡住。
//   网站(tigerpower.online)发的页面里没有这个脚本(public-server.mjs 去掉了),万一加载了,window.TP_PUBLIC 时什么都不做。
//   批准框的内容是本机服务器按验过的参数写的,但值(地址、留言)来自网页请求:一律 textContent,不拼 HTML。
//   批准框是网站被黑时唯一的一道关:「批准」在卡片刚出现、卡片位置变了、页面刚回到前台时都先禁用 1 秒(防连点 / 点击劫持),「拒绝」随时能点;
//   弹出的东西(批准框、配对码、登录请求)都放在右上角同一个容器里,批准框永远排第一个,不用整页遮罩,谁也盖不住它。
//   页面可以定义 window.tpLoginRequested(acct)(网站请求登录时调它)、window.tpLinkChanged()(配对完成 / 作废后调它,好刷新连接状态)。
(() => {
  let started = false;
  const T = (s) => (window.tr ? window.tr(s) : s);   // 浏览器通知不在页面里,i18n 管不到,自己翻
  const CSS = `
  .tplp-stack { position:fixed; top:64px; right:16px; z-index:100; width:min(420px, calc(100vw - 32px)); max-height:calc(100vh - 80px); overflow:auto; display:flex; flex-direction:column; gap:10px; font:13px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .tplp-stack:empty { display:none; }
  .tplp-card { background:var(--s1, #101318); color:var(--text, #e7eaf0); border:1px solid var(--line2, #2a313d); border-radius:12px; padding:14px; box-shadow:0 12px 40px rgba(0,0,0,.55); }
  .tplp-card.tplp-ask { border-color:var(--acc, #f0b90b); }
  .tplp-head { font-weight:800; color:var(--acc, #f0b90b); }
  .tplp-sub { color:var(--mute, #8d96a7); font-size:12px; margin-top:2px; }
  .tplp-title { font-size:15px; font-weight:800; margin:10px 0 2px; }
  .tplp-from { color:var(--faint, #5b6372); font-size:12px; } .tplp-from .tplp-mono { color:var(--mute, #8d96a7); }
  .tplp-lines { margin:8px 0; padding:8px 10px; background:var(--s2, #151920); border:1px solid var(--line, #1e232c); border-radius:9px; }
  .tplp-lines div { overflow-wrap:anywhere; } .tplp-lines .tplp-warn { color:var(--down, #ea3943); font-weight:700; }
  .tplp-left { color:var(--mute, #8d96a7); font-size:12px; } .tplp-left b { color:var(--text, #e7eaf0); font-variant-numeric:tabular-nums; }
  .tplp-err { color:var(--down, #ea3943); font-size:12px; margin-top:6px; }
  .tplp-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }
  .tplp-row button, .tplp-row a { display:block; text-align:center; text-decoration:none; cursor:pointer; border-radius:9px; padding:9px 0; border:1px solid var(--line2, #2a313d); background:var(--s3, #1b2029); color:var(--text, #e7eaf0); font:inherit; font-weight:700; }
  .tplp-row button:disabled { opacity:.5; cursor:default; pointer-events:none; }
  .tplp-row .tplp-ok { background:var(--up, #16c784); border-color:var(--up, #16c784); color:#04140d; }
  .tplp-row .tplp-go { color:var(--acc, #f0b90b); }
  .tplp-mono { font-family:"JetBrains Mono", Consolas, "SF Mono", monospace; }
  .tplp-card.tplp-pair { text-align:center; border-color:var(--acc, #f0b90b); }
  .tplp-pair h3 { margin:0 0 4px; font-size:16px; overflow-wrap:anywhere; }
  .tplp-pair .tplp-row { grid-template-columns:1fr; }
  .tplp-code { font:800 44px Consolas, monospace; letter-spacing:10px; color:var(--acc, #f0b90b); margin:14px 0 6px; padding-left:10px; }
  .tplp-faint { color:var(--faint, #5b6372); font-size:12px; }
  .tplp-pwarn { color:var(--down, #ea3943); font-size:12px; line-height:1.55; margin-top:10px; }`;
  // 小工具:建元素;子节点是字符串就是文字节点(每段中文单独一个节点,i18n 才能整句对上词典)
  function h(tag, cls, ...kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
    return e;
  }
  const APPROVE_DELAY_MS = 1000;   // 「批准」露出来多久之后才能点
  const ready = (fn) => (document.body ? fn() : document.addEventListener("DOMContentLoaded", fn, { once: true }));

  let handle = null;   // init 之后才有:处理一条事件
  function init(getToken, { stream = true } = {}) {
    if (window.TP_PUBLIC || started) return;
    started = true;
    const token = () => String((typeof getToken === "function" ? getToken() : "") ?? "");
    // 本机接口:带页面令牌 + JSON;出错抛服务器给的错误
    async function post(path, body = {}) {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-panel-token": token() }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || "HTTP " + r.status);
      return d;
    }

    let stack = null;   // 批准框 / 登录请求卡片的容器(页面 DOM 好了才建,见最后)

    // ---------- 批准框 ----------
    const cards = new Map();   // id → { a, el, left }
    const seen = new Set();    // 已经提醒过的请求(只对新来的弹通知 / 响一声)
    let askBox = null, tickT = null, refreshSeq = 0;
    // 这两种是网页给的原文(留言、跟单名称):值放在不翻译的节点里,英文界面也照原样显示
    const RAW = ["留言", "名称"];
    function lineEl(s) {
      const i = s.indexOf(":");
      if (i > 0 && RAW.includes(s.slice(0, i))) {
        const v = h("span", null, s.slice(i + 1)); v.dataset.notr = "1";
        return h("div", null, h("span", null, s.slice(0, i)), ":", v);
      }
      return h("div", s.startsWith("⚠") ? "tplp-warn" : null, s);
    }
    function ensureAskBox() {
      if (askBox) return askBox;
      askBox = h("div", "tplp-card tplp-ask",
        h("div", "tplp-head", "网站请求你批准"),
        h("div", "tplp-sub", "核对清楚再批准;不是你自己在网站上发起的,点「拒绝」"));
      stack.prepend(askBox);
      return askBox;
    }
    function cardOf(a) {
      const left = h("b", null, "");
      const err = h("div", "tplp-err"); err.hidden = true;
      const no = h("button", null, "拒绝"), yes = h("button", "tplp-ok", "批准");
      no.type = yes.type = "button";
      yes.disabled = true;   // 先灰着:插进页面后由 arm 计时解锁
      const origin = h("span", "tplp-mono", String(a.origin ?? "")); origin.dataset.notr = "1";
      const el = h("div", null,
        h("div", "tplp-title", String(a.title ?? "")),
        h("div", "tplp-from", h("span", null, "来自"), " ", origin),
        h("div", "tplp-lines", ...(Array.isArray(a.lines) ? a.lines : []).map((s) => lineEl(String(s)))),
        h("div", "tplp-left", left, " ", h("span", null, "秒后自动拒绝")),
        err,
        h("div", "tplp-row", no, yes));
      const c = { a, el, left, yes, armT: null, busy: false };
      const decide = async (ok) => {
        if (ok && yes.disabled) return;   // 还没解锁的「批准」不算(禁用的按钮浏览器本来也不会触发点击)
        c.busy = true; no.disabled = yes.disabled = true; err.hidden = true;
        try { await post("/api/approve/decide", { id: a.id, ok }); drop(a.id); }
        catch { err.replaceChildren("没处理成功,再试一次"); err.hidden = false; c.busy = false; no.disabled = false; arm(c); }
        refreshApprovals();
      };
      no.onclick = () => decide(false);
      yes.onclick = () => decide(true);
      // 「批准」还没解锁时在这张卡片上按下鼠标:重新等 1 秒(一直连点就一直解不了锁)。禁用的按钮不接鼠标事件(样式里 pointer-events:none),
      //   按在它上面的那一下落到卡片上,同样算
      el.onpointerdown = () => { if (yes.disabled && !c.busy) arm(c); };
      return c;
    }
    // 防连点 / 点击劫持:被黑的网站可以自己弹出本机页面、自己发起批准请求,再骗用户在同一个位置连点(双击、按下后换位置),
    //   让第二下正好落在「批准」上。所以「批准」每次重新露出来(卡片刚插进来、别的卡片增减让它挪了位置、页面刚拿到焦点 / 回到前台)
    //   都先禁用 1 秒,还没解锁时在卡片上按下鼠标也重新计时;页面在后台时一直禁用,回到前台再计时。「拒绝」不受影响
    function arm(c) {
      clearTimeout(c.armT); c.armT = null;
      c.yes.disabled = true;
      if (c.busy || document.hidden) return;
      c.armT = setTimeout(() => { c.armT = null; if (!c.busy && !document.hidden) c.yes.disabled = false; }, APPROVE_DELAY_MS);
    }
    const armAll = () => { for (const c of cards.values()) arm(c); };
    window.addEventListener("focus", armAll);
    document.addEventListener("visibilitychange", armAll);
    function drop(id) {
      const c = cards.get(id); if (!c) return;
      clearTimeout(c.armT);
      c.el.remove(); cards.delete(id);
      if (!cards.size) { askBox?.remove(); askBox = null; clearInterval(tickT); tickT = null; }
      else armAll();   // 下面的卡片往上挪了:它们的「批准」重新等 1 秒
    }
    function tick() {
      for (const [id, c] of cards) {
        const s = Math.ceil((Number(c.a.expiresAt) - Date.now()) / 1000);
        if (!(s > 0)) drop(id);   // 服务器那边同时也超时拒绝了(还会推一次 approve)
        else c.left.textContent = String(s);
      }
    }
    async function refreshApprovals() {
      const seq = ++refreshSeq;
      let list;
      try { list = await post("/api/approve/pending"); } catch { return; }
      if (seq !== refreshSeq || !stack || !Array.isArray(list)) return;   // 后发的请求先回来了:用新的
      const ids = new Set(list.map((a) => a.id));
      for (const id of [...cards.keys()]) if (!ids.has(id)) drop(id);
      const fresh = [];
      let added = 0;
      for (const a of list) {
        if (cards.has(a.id)) continue;
        const c = cardOf(a);
        cards.set(a.id, c);
        ensureAskBox().appendChild(c.el);
        added++;
        if (!seen.has(a.id)) { seen.add(a.id); fresh.push(a); }
      }
      if (added) armAll();   // 新卡片插进来:新卡片在这里开始计时,别的卡片也重新等 1 秒
      if (cards.size && !tickT) tickT = setInterval(tick, 1000);
      tick();
      if (fresh.length && document.hidden) alertHidden(fresh);
    }
    // 页面在后台时来了新的批准请求:浏览器通知 + 响一声
    function alertHidden(fresh) {
      beep();
      try {
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        const a = fresh[0];
        const n = new Notification(T("网站请求批准") + ": " + T(String(a.title ?? "")), { body: (a.lines ?? []).map((s) => T(String(s))).join("\n"), tag: "tplp-approve" });
        n.onclick = () => { window.focus(); n.close(); };
      } catch {}
    }
    function beep() {
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const o = ac.createOscillator(), g = ac.createGain();
        o.frequency.value = 880; g.gain.setValueAtTime(0.15, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.35);
        o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.36);
        setTimeout(() => ac.close?.(), 600);
      } catch {}
    }
    // 浏览器通知要用户点过页面才能申请:第一次点页面时问一次
    document.addEventListener("click", () => { try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch {} }, { once: true });

    // ---------- 网站请求配对:大号配对码(事件里没有码,向本机另取)。倒计时到 0 自动关;每 2 秒问一次本机,配对完成 / 作废了就提前关 ----------
    let pairShown = null, pairT = null, pairEl = null;
    function closePair(changed) {
      clearInterval(pairT); pairT = null; pairShown = null;
      pairEl?.remove(); pairEl = null;
      if (changed) try { window.tpLinkChanged?.(); } catch {}
    }
    async function checkPair() {
      let p;
      try { p = await post("/api/link/pending"); } catch { return; }
      if (p?.code && (!pairShown || p.code !== pairShown.code)) showPair(p);
    }
    function showPair(p) {
      closePair(false);
      if (!stack) return;
      pairShown = p;
      const end = Date.now() + Math.max(0, Number(p.expiresIn) || 0) * 1000;
      const left = h("span", null, "");
      const close = h("button", null, "关闭"); close.type = "button";
      const origin = h("span", "tplp-mono", String(p.origin ?? "")); origin.dataset.notr = "1";
      pairEl = h("div", "tplp-card tplp-pair",
        h("h3", null, origin, " ", h("span", null, "请求连接你的钱包助手")),
        h("div", "tplp-faint", "把这个码输进网页上的配对框"),
        h("div", "tplp-code", String(p.code)),
        h("div", "tplp-faint", left, " ", h("span", null, "秒内有效")),
        h("div", "tplp-pwarn", "不是你自己在网站上点的「连接」,就别把这个码给任何人"),
        h("div", "tplp-row", close));
      // 和批准框同一个容器、排在它后面(批准框后来才出现也是插到最前面):不盖住批准框,也不挪动它的按钮
      if (askBox) askBox.after(pairEl); else stack.prepend(pairEl);
      close.onclick = () => closePair(false);
      let n = 0;
      const count = () => { const s = Math.ceil((end - Date.now()) / 1000); if (s <= 0) return closePair(false); left.textContent = String(s); };
      count();
      if (pairShown !== p) return;
      pairT = setInterval(async () => {
        count();
        if (pairShown !== p || ++n % 2) return;
        let q;
        try { q = await post("/api/link/pending"); } catch { return; }
        if (pairShown !== p) return;   // 等回答的时候已经关了 / 换成别的码了
        if (q === null) closePair(true);   // 配对完成 / 次数用完作废 / 过期:不再显示一个已经没用的码
        else if (q?.code && q.code !== p.code) showPair(q);
      }, 1000);
    }

    // ---------- 网站请本机登录:页面自己的扫码登录(tpLoginRequested / openLogin),都没有就弹一张小卡片链到 / ----------
    function onLoginReq(acct) {
      acct = String(acct ?? "");
      if (!/^[12]$/.test(acct)) return;
      if (typeof window.tpLoginRequested === "function") return window.tpLoginRequested(acct);
      if (typeof window.openLogin === "function") return window.openLogin(acct);
      if (!stack) return;
      const close = h("button", null, "关闭"); close.type = "button";
      const go = h("a", "tplp-go", "去扫码登录 →"); go.href = "/";
      const card = h("div", "tplp-card", h("div", "tplp-head", h("span", null, "网站请求登录账号"), " " + acct), h("div", "tplp-row", close, go));
      close.onclick = () => card.remove();
      stack.appendChild(card);
      setTimeout(() => card.remove(), 120_000);
    }

    // ---------- 事件:只关心批准 / 配对 / 登录请求。hello = 事件流(重新)连上了:断开期间可能漏了,补取一次 ----------
    function sync() { refreshApprovals(); checkPair(); }
    handle = (ev) => {
      if (ev?.type === "approve") refreshApprovals();
      else if (ev?.type === "linkpair") checkPair();
      else if (ev?.type === "loginreq") onLoginReq(ev.acct);
      else if (ev?.type === "hello") sync();
    };
    // 自己的事件流(stream: true,本机助手页面用):被拒(令牌换过)/ 连不上时 EventSource 不会再连,3 秒后用最新令牌重连
    let es = null;
    function connect() {
      try { es?.close(); } catch {}
      es = new EventSource("/api/stream?t=" + encodeURIComponent(token()));
      es.onerror = () => { if (es.readyState === 2) setTimeout(connect, 3000); };
      es.onmessage = (m) => { let ev; try { ev = JSON.parse(m.data); } catch { return; } handle(ev); };
    }
    // 样式和容器放到最后建:页面已经有 body 时 ready 是同步调的,sync 要用到上面声明的那些变量
    ready(() => {
      const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
      stack = h("div", "tplp-stack"); document.body.appendChild(stack);
      sync();
    });
    if (stream) connect();
  }

  // 页面自己的事件流收到的事件(init 时 stream: false 的页面转过来;别的类型这里不管)
  window.tpLocalPop = { init, event: (ev) => handle?.(ev) };
})();

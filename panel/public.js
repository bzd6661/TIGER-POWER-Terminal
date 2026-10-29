// 公开版(tigerpower.online)专用:只由 public-server.mjs 注入,本地版不加载。
//   1. 没连本机钱包助手时:界面和本地版一样(没登录的样子);点买卖 / 登录 / 钱包设置,或页面调到要钱包的接口时,弹「连接本机钱包助手」。
//   2. 个人数据存在访客自己的浏览器里:收藏 / 屏蔽、追踪名单。页面照旧请求 /api/lists、/api/track…,在这里就地处理,不发到服务器。
//   3. 追踪动态:按本机名单向服务器取最近 24 小时的公开成交;实时推送里命中名单的成交,补发成「追踪」事件给页面。
//   4. 这个浏览器和本机助手(用户自己电脑上的 TIGER-POWER-Helper,或者完整本地版,都在 127.0.0.1:4400)配过对:window.TP_HELPER = true,请求分两路:
//      钱包相关的(HELPER_PATHS:钱包 / 报价 / 下单 / 转账 / 设置 / 自动转出 / 跟单 / 登录状态…)带配对令牌发到本机助手;
//      代币页的 /api/inspect、/api/history 照旧问网站,再合上本机助手 /api/mine 给的「我的持仓 / 成本 / 买卖点」;其余和没连助手时一样(网站 + 浏览器里的名单)。
//      实时推送两条:网站的(成交 / 新盘 / 毕业)+ 本机助手的 scope=wallet(通知、掉线、跟单…);追踪名单和没连时一样在浏览器里,追踪动态照第 3 条补。
//      转账、改设置这类动钱的请求要在本机助手页面点「批准」:等着的时候页面顶上提示去哪批准。
//      只有已经配过对、或点了「连接本机助手」才会去连 127.0.0.1 —— 不然每个访客都会被浏览器问「访问本地网络」。
(() => {
  window.TP_PUBLIC = true;
  document.documentElement.classList.add("tp-public");
  const GH = "https://github.com/bzd6661/TIGER-POWER-Terminal";   // 完整本地版
  const HELPER_REPO = "https://github.com/bzd6661/TIGER-POWER-Helper";   // 本机助手:只有助手的小仓库;链到仓库页面,下载方法和用法都在它的 README 里
  const realFetch = window.fetch.bind(window);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const onReady = (f) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", f, { once: true }) : f());

  // ---------- 浏览器存储(无痕窗口 / 禁用网站数据时会抛错:读当作没有,写 / 删返回 false) ----------
  const store = (get) => ({
    get: (k) => { try { return get().getItem(k); } catch { return null; } },
    set: (k, v) => { try { get().setItem(k, v); return get().getItem(k) === v; } catch { return false; } },
    del: (k) => { try { get().removeItem(k); return get().getItem(k) === null; } catch { return false; } },
  });
  const LS = store(() => localStorage), SS = store(() => sessionStorage);

  // ---------- 本机钱包助手:要不要用、连哪 ----------
  //   localStorage.tp_helper_token   配对令牌(配对时本机助手发的,只存在这个浏览器里)
  //   sessionStorage.tp_helper_off   "1" = 这个标签页暂时不用助手(连不上 / 版本太旧);tp_helper_why 记原因(down / old / gone),顶部提示用
  //   sessionStorage.tp_helper_reload 上次因为助手的问题自动刷新的时间(防止来回刷);tp_helper_hush = 用户关掉了哪种顶部提示
  //   助手地址固定是本机 4400;只有在 localhost 上联调时才认 localStorage.tp_helper_base(公开网址上谁也改不了要连哪)
  const HELPER_BASE = (() => {
    const o = location.hostname === "localhost" ? String(LS.get("tp_helper_base") ?? "").trim().replace(/\/+$/, "") : "";
    return /^https?:\/\/[^/\s?#]+$/.test(o) ? o : "http://127.0.0.1:4400";
  })();
  const HELPER_API = 2;   // 网站要求的最低助手接口版本(本机 /link/hello 里报的 api);2 = 转账 / 改设置这类要本机批准、有 /api/mine 和 scope=wallet 推送
  const TOKEN = LS.get("tp_helper_token") || "";
  const HELPER = !!TOKEN && SS.get("tp_helper_off") !== "1";
  window.TP_HELPER = HELPER;
  // 没走助手时别先画出上次助手给的余额(index.html 的缓存;那是本机的数据,现在没连着)
  if (!HELPER) LS.del("walletsCache");
  const OLD_MSG = "本机助手版本太旧,请下载最新的本机助手(用完整版的请 git pull)后重新运行 start.cmd";
  const NONE_MSG = "没检测到本机助手:先下载本机助手并双击 start.cmd;如果已经在运行,浏览器问「访问本地网络」时请点允许";
  const LOST_MSG = "连不上本机助手了,确认它还开着再试";
  const BAR_MSG = { down: "本机助手未连接", old: OLD_MSG, gone: "本机助手已断开,请重新连接" };

  // ---------- 连着助手时哪些请求发到本机助手(其余走网站 / 浏览器本地);两个集合 tests/public-routing.test.mjs 会按名字读出来核对,只写字符串 ----------
  // 钱包相关:钱包 / 报价 / 下单 / 转账 / 打赏 / 设置 / 授权 / 自动转出 / 登录状态 / 跟单 / 网页连接管理 / 代币页「我的」部分
  const HELPER_PATHS = new Set([
    "/api/wallets", "/api/quote", "/api/run", "/api/send", "/api/tip", "/api/settings", "/api/settings/set",
    "/api/approvals", "/api/approvals/revoke", "/api/quote-balances", "/api/latency-stats",
    "/api/autotransfer", "/api/autotransfer/target", "/api/autotransfer/set", "/api/autotransfer/appconfirm",
    "/api/login/status", "/api/login/logout", "/api/login/unpin", "/api/login/request",
    "/api/copy", "/api/copy/tasks", "/api/copy/pause-all", "/api/link/state", "/api/link/revoke", "/api/link/limits", "/api/mine",
  ]);
  // 可能要在本机批准的(要不要批准由本机助手按「路径 + 请求体」定,见 weblink.mjs 的 approvalKind):0.4 秒还没回来就在页面顶上提示去哪批准
  const APPROVE_PATHS = new Set([
    "/api/send", "/api/tip", "/api/settings/set", "/api/autotransfer/target", "/api/autotransfer/set", "/api/autotransfer/appconfirm",
    "/api/login/unpin", "/api/link/limits", "/api/copy/tasks", "/api/copy/pause-all",
  ]);
  // 转账 / 打赏是文本流,要批准时本机助手先写这一行(和 weblink.mjs 的 APPROVAL_WAIT_TEXT 一字不差)
  const APPROVAL_WAIT_TEXT = "⏳ 等待本机助手批准…(请在本机助手页面点「批准」)";

  // 探测本机助手 → { h }(h = /link/hello 的回应)或 { fail: "down" | "old" }。只在已经配过对、或用户点了「连接」时调用
  async function probe(token, ms) {
    try {
      const r = await realFetch(HELPER_BASE + "/link/hello", { headers: token ? { authorization: "Bearer " + token } : {}, cache: "no-store", signal: AbortSignal.timeout(ms) });
      const h = r.ok ? await r.json().catch(() => null) : null;
      if (h?.app !== "tigerpower-helper") return { fail: "down" };
      return Number(h.api) >= HELPER_API ? { h } : { fail: "old" };
    } catch (e) {
      // 马上就连不上(不是超时):再用 no-cors 敲一下 —— 有回应说明本机 4400 上有服务、只是不认 /link/hello,是还没有网页连接功能的旧本地版
      if (e?.name === "TypeError") {
        try { await realFetch(HELPER_BASE + "/link/hello", { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(800) }); return { fail: "old" }; } catch {}
      }
      return { fail: "down" };
    }
  }

  // ---------- 刷新:因为助手的问题自动刷新,同一个标签页 15 秒内只刷一次(存不进 sessionStorage 时不刷,只在顶部提示) ----------
  let reloading = false;
  function reloadOnce(why) {
    if (reloading) return;
    const last = Number(SS.get("tp_helper_reload")) || 0;
    if (Date.now() - last < 15_000 || !SS.set("tp_helper_reload", String(Date.now()))) return showBar(why);
    reloading = true;
    location.reload();
  }
  // 用户自己点的(配对成功 / 重新连接 / 断开连接):不算自动刷新
  function userReload() { SS.del("tp_helper_reload"); reloading = true; location.reload(); }
  const clearState = () => { SS.del("tp_helper_off"); SS.del("tp_helper_why"); SS.del("tp_helper_hush"); };

  // 连不上 / 太旧:这个标签页先不用助手(sessionStorage,关掉标签页就忘),刷新一次退回公开只读版,顶部提示「重新连接」
  function goOff(why) {
    SS.set("tp_helper_why", why);
    if (SS.set("tp_helper_off", "1")) reloadOnce(why); else showBar(why);
  }
  // 令牌失效(本机面板里点了断开 / 本地版重装过):删掉令牌,刷新一次回到公开版,顶部提示「已断开」
  function gone() {
    if (reloading) return;
    if (LS.get("tp_helper_token") === TOKEN) LS.del("tp_helper_token");   // 别的标签页刚配好的新令牌不删
    SS.del("tp_helper_off"); SS.del("tp_helper_hush");
    SS.set("tp_helper_why", "gone");
    if (LS.get("tp_helper_token") !== TOKEN) reloadOnce("gone"); else showBar("gone");
  }

  // 后台核对:打开页面马上问一次(带令牌,1.2 秒超时:连不上时尽快退回公开版);用着用着连不上时再核对(1.5 秒超时,隔 3 秒再试一次,扛得住本地版重启)
  let checking = false, lastCheck = 0, verified = false;
  async function verify(tries, ms = 1500) {
    if (checking || reloading) return;
    checking = true; lastCheck = Date.now();
    try {
      let res = await probe(TOKEN, ms);
      for (let i = 1; i < tries && res.fail === "down"; i++) { await new Promise((ok) => setTimeout(ok, 3000)); res = await probe(TOKEN, ms); }
      if (res.fail) goOff(res.fail);
      else if (res.h.paired === false) gone();
      else { verified = true; SS.del("tp_helper_why"); chip?.classList.add("on"); }
    } finally { checking = false; }
  }
  const recheckSoon = () => { if (!checking && !reloading && Date.now() - lastCheck > 10_000) verify(2); };

  // ---------- 样式 ----------
  const css = `
  .tp-lm { position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:200; display:flex; align-items:center; justify-content:center; padding:16px; }
  .tp-lm[hidden] { display:none; }
  .tp-lm .box { width:min(440px,100%); background:var(--panel, #14171d); border:1px solid var(--line, #262b34); border-radius:12px; padding:22px 22px 18px; color:var(--mute, #9aa3b2); font-size:13px; line-height:1.7; box-shadow:0 20px 60px rgba(0,0,0,.5); }
  .tp-lm h3 { margin:0 0 10px; color:var(--text, #e8ebf0); font-size:17px; }
  .tp-lm .row { display:flex; gap:10px; justify-content:flex-end; align-items:center; flex-wrap:wrap; margin-top:18px; }
  .tp-lm .row a, .tp-lm .row button { padding:8px 14px; border-radius:8px; font:inherit; font-weight:700; cursor:pointer; text-decoration:none; }
  .tp-lm .row a { background:var(--acc, #f0b90b); color:#111; border:0; }
  .tp-lm .row button { background:transparent; color:var(--mute, #9aa3b2); border:1px solid var(--line, #262b34); }
  .tp-lm .row button.pri { background:var(--acc, #f0b90b); color:#111; border-color:transparent; }
  .tp-lm .row button:disabled { opacity:.55; cursor:default; }
  .tp-lm .tp-st > div { margin-top:12px; } .tp-lm .tp-st > div:first-child { margin-top:0; }
  .tp-lm .tp-st a { color:var(--acc, #f0b90b); }
  .tp-lm .err { color:var(--down, #ea3943); } .tp-lm .ok { color:var(--up, #16c784); }
  .tp-lm .tp-code { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .tp-lm .tp-code input { width:160px; box-sizing:border-box; background:var(--s2, #151920); color:var(--text, #e8ebf0); border:1px solid var(--line2, #2a313d); border-radius:8px; padding:8px 10px; font:inherit; font-size:17px; letter-spacing:5px; text-align:center; }
  .tp-lm .tp-code button { background:none; border:0; padding:0; color:var(--mute, #9aa3b2); font:inherit; font-size:12px; text-decoration:underline; cursor:pointer; }
  .tp-lm .tp-msg:empty { display:none; }
  .tp-lm .box.wide { width:min(580px,100%); max-height:calc(100vh - 32px); max-height:calc(100dvh - 32px); overflow:auto; }
  .tp-lm .tp-modes { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .tp-lm .tp-mode { border:1px solid var(--line, #262b34); border-radius:9px; padding:10px 12px; font-size:12px; line-height:1.6; }
  .tp-lm .tp-mode b, .tp-lm .tp-how > b { color:var(--text, #e8ebf0); font-size:13px; }
  .tp-lm .tp-mode .tp-tag { margin-left:6px; color:var(--acc, #f0b90b); }
  .tp-lm .tp-mode div { margin-top:4px; }
  .tp-lm .tp-how ol { margin:6px 0 0; padding-left:20px; }
  .tp-lm .tp-how li { margin-top:4px; }
  .tp-lm .tp-how li a { color:var(--acc, #f0b90b); white-space:nowrap; }
  .tp-lm .tp-how .tp-guide { margin-left:10px; font-size:12px; font-weight:700; }
  @media (max-width:520px) { .tp-lm .tp-modes { grid-template-columns:1fr; } }
  .tp-apbar { position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:260; display:flex; align-items:center; justify-content:center; gap:12px; flex-wrap:wrap; box-sizing:border-box; max-width:calc(100vw - 32px); padding:10px 16px; background:var(--s1, #101318); border:1px solid var(--acc, #f0b90b); border-radius:10px; color:var(--text, #e7eaf0); font-size:13px; box-shadow:0 12px 32px rgba(0,0,0,.5); }
  .tp-apbar[hidden] { display:none; }
  .tp-apbar a { color:var(--acc, #f0b90b); font-weight:700; text-decoration:none; white-space:nowrap; }
  .tp-hchip { position:relative; flex:none; margin-left:auto; }
  .tp-hchip + .wallets { margin-left:0; }
  .tp-hbtn { display:flex; align-items:center; gap:7px; height:32px; padding:0 11px; background:var(--s2, #151920); border:1px solid var(--line, #1e232c); border-radius:9px; color:var(--text, #e7eaf0); font:inherit; font-size:12px; cursor:pointer; white-space:nowrap; }
  .tp-hbtn:hover { border-color:var(--line2, #2a313d); }
  .tp-hdot { width:7px; height:7px; border-radius:50%; background:var(--faint, #5b6372); flex:none; }
  .tp-hchip.on .tp-hdot { background:var(--up, #16c784); box-shadow:0 0 6px var(--up, #16c784); }
  .tp-hdot.off { background:var(--down, #ea3943); }
  .tp-hmenu { position:absolute; right:0; top:calc(100% + 6px); z-index:150; min-width:220px; background:var(--s1, #101318); border:1px solid var(--line2, #2a313d); border-radius:9px; padding:10px 12px; font-size:12px; color:var(--mute, #8d96a7); box-shadow:0 12px 32px rgba(0,0,0,.5); }
  .tp-hmenu[hidden] { display:none; }
  .tp-hmenu .tp-mono { font-family:ui-monospace, Consolas, monospace; color:var(--text, #e7eaf0); }
  .tp-hmenu button { display:block; width:100%; margin-top:10px; padding:7px 10px; background:transparent; color:var(--down, #ea3943); border:1px solid var(--line2, #2a313d); border-radius:7px; font:inherit; cursor:pointer; }
  .tp-hbar { flex:none; display:flex; align-items:center; justify-content:center; gap:8px; flex-wrap:wrap; padding:6px 16px; background:var(--s2, #151920); border-bottom:1px solid var(--line, #1e232c); color:var(--text, #e7eaf0); font-size:12.5px; }
  .tp-hbar .tp-sep { color:var(--faint, #5b6372); }
  .tp-hbar button { background:none; border:0; padding:0; color:var(--acc, #f0b90b); font:inherit; font-weight:700; cursor:pointer; }
  .tp-hbar button:disabled { opacity:.6; cursor:default; }
  .tp-hbar button.x { color:var(--mute, #8d96a7); font-weight:400; margin-left:6px; }`;
  const st = document.createElement("style"); st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  // ---------- 顶部:连上了显示「● 本机钱包已连接」(点开能断开);没连上 / 太旧 / 被断开显示一条提示 ----------
  let chip = null, bar = null;
  function mountChip() {
    const top = document.querySelector(".top"); if (!top) return;
    chip = document.createElement("div");
    chip.className = "tp-hchip" + (verified ? " on" : "");
    chip.innerHTML = `<button type="button" class="tp-hbtn" aria-haspopup="true"><span class="tp-hdot"></span><span>本机钱包已连接</span></button>
      <div class="tp-hmenu" hidden><div><span>本机助手</span> <span class="tp-mono">${esc(HELPER_BASE.replace(/^https?:\/\//, ""))}</span></div><button type="button" data-hoff>断开连接</button></div>`;
    const menu = chip.querySelector(".tp-hmenu");
    chip.querySelector(".tp-hbtn").onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    chip.querySelector("[data-hoff]").onclick = () => { LS.del("tp_helper_token"); clearState(); userReload(); };
    document.addEventListener("click", (e) => { if (!menu.hidden && !chip.contains(e.target)) menu.hidden = true; });
    const at = document.getElementById("wchips") || top.querySelector(".xlink");
    if (at) at.before(chip); else top.appendChild(chip);
  }
  function showBar(why) {
    if (SS.get("tp_helper_hush") === why) return;
    onReady(() => {
      const top = document.querySelector(".top"); if (!top) return;
      if (!bar) { bar = document.createElement("div"); bar.className = "tp-hbar"; top.after(bar); }
      const tok = !!LS.get("tp_helper_token");
      bar.innerHTML = `<span class="tp-hdot off"></span><span>${esc(BAR_MSG[why] ?? BAR_MSG.down)}</span><span class="tp-sep">·</span><button type="button" data-hre>${tok ? "重新连接" : "连接本机助手"}</button><button type="button" class="x" data-hx title="关闭">✕</button>`;
      bar.querySelector("[data-hre]").onclick = tok ? reconnect : () => window.tpNeedLogin();
      bar.querySelector("[data-hx]").onclick = () => { SS.set("tp_helper_hush", why); bar.remove(); bar = null; };
    });
  }
  // 「重新连接」:先在这个页面探一下(多等一会儿:浏览器可能正在问「访问本地网络」),连得上才清掉 tp_helper_off 刷新;连不上就地改提示
  async function reconnect(e) {
    const btn = e?.currentTarget;
    if (btn) { btn.disabled = true; btn.textContent = "连接中…"; }
    const tok = LS.get("tp_helper_token") || "";
    const res = HELPER || !tok ? null : await probe(tok, 20_000);
    if (res?.fail) { SS.set("tp_helper_why", res.fail); SS.del("tp_helper_hush"); return showBar(res.fail); }
    if (res && res.h.paired === false) { LS.del("tp_helper_token"); clearState(); SS.set("tp_helper_why", "gone"); return showBar("gone"); }
    clearState();
    userReload();
  }
  if (HELPER) verify(1, 1200);
  onReady(() => {
    if (HELPER) return mountChip();
    if (TOKEN) showBar(SS.get("tp_helper_why") === "old" ? "old" : "down");   // 配过对,但这个标签页暂时没用助手
    else if (SS.get("tp_helper_why") === "gone") showBar("gone");
  });

  // ---------- 「登录钱包」对话框:没连助手时点买卖 / 登录 / 钱包设置都弹它。先讲清楚两种用法(装的是两个不同的东西)和本机助手模式的步骤,再从这里连接 ----------
  let dlg = null, dlgStage = "", busy = false;
  const btn = (attr, text, pri = false) => `<button type="button" ${attr}${pri ? ' class="pri"' : ""}>${text}</button>`;
  const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>`;
  // 每段文字单独一个文字节点(链接放在 span 外面):i18n.js 按整段查英文
  //   本机助手模式下载的是 TIGER-POWER-Helper(只有助手);完整本地版下载的是 TIGER-POWER-Terminal(它自己也带助手,两个只开一个)
  const INTRO = `<div>网站服务器上没有任何钱包,下单都由你自己电脑上的程序签名。两种用法装的不是同一个东西:</div>
    <div class="tp-modes">
      <div class="tp-mode"><b>本机助手模式</b><span class="tp-tag">推荐</span>
        <div>只装「本机助手」(TIGER-POWER-Helper,一个小程序),在这个网站上看持仓、买卖、设置、跟单</div>
        <div>网站随时更新,助手很少需要更新</div>
        <div>转账、改限额这类动钱的操作,要在本机助手页面点「批准」</div></div>
      <div class="tp-mode"><b>完整本地版</b><span class="tp-tag">全在自己电脑上</span>
        <div>装「完整版」(TIGER-POWER-Terminal),所有操作都在本机页面 127.0.0.1:4400 里做,不用这个网站</div>
        <div>完整版本身也带本机助手,两个只开一个(都用 4400 端口)</div>
        <div>${link(GH, "下载完整版 →")}</div></div>
    </div>
    <div class="tp-how"><b>本机助手模式怎么用</b><a class="tp-guide" href="/guide" target="_blank" rel="noopener">看图文教程 →</a><ol>
      <li><span>打开本机助手的页面,照说明安装:装好 Node.js 20 以上,下载本机助手,解压后双击 start.cmd</span> ${link(HELPER_REPO, "本机助手下载和使用说明 →")}</li>
      <li><span>本机助手页面会自动打开,用 Binance App 扫码登录钱包</span> ${link(HELPER_BASE + "/", "打开本机助手 →")}</li>
      <li>回到这个网站点「连接本机助手」。要用运行助手的同一台电脑;浏览器问「访问本地网络」时点允许</li>
      <li>本机助手页面会弹出 6 位配对码,填进来就连上了。配对一次就行,以后打开网站会自动连接</li>
    </ol></div>`;
  function stage(name, msg = "") {
    dlgStage = name;
    const box = dlg.querySelector(".tp-st"), row = dlg.querySelector(".row");
    dlg.querySelector("h3").textContent = name === "intro" ? "登录钱包" : "连接本机助手";
    if (name === "intro") {
      box.innerHTML = INTRO;
      row.innerHTML = btn("data-x", "知道了") + btn("data-go", "连接本机助手", true);
    } else if (name === "busy") {
      box.innerHTML = "<div>正在连接本机助手…</div><div>浏览器问「允许访问本地网络上的设备」时请点允许</div>";
      row.innerHTML = btn("data-x", "知道了") + '<button type="button" class="pri" disabled>连接中…</button>';
    } else if (name === "code") {
      box.innerHTML = `<div>配对码显示在本机助手页面的弹窗里,或打开 <a href="${esc(HELPER_BASE)}/pair" target="_blank" rel="noopener">${esc(HELPER_BASE)}/pair</a> 查看</div>
        <div class="tp-code"><input inputmode="numeric" maxlength="6" autocomplete="one-time-code" spellcheck="false" placeholder="6 位配对码"><button type="button" data-go>重新获取配对码</button></div>
        <div class="tp-msg"></div>`;
      row.innerHTML = btn("data-x", "取消") + btn("data-fin", "完成配对", true);
      const inp = box.querySelector("input");
      inp.onkeydown = (e) => { if (e.key === "Enter") finish(); };
      setTimeout(() => inp.focus(), 0);
    } else {   // none / old / err:连不上、太旧、或助手报错
      box.innerHTML = `<div class="err">${esc(name === "old" ? OLD_MSG : name === "none" ? NONE_MSG : msg)}</div>`;
      row.innerHTML = btn("data-x", "知道了") + btn("data-go", "再试一次") + link("/guide", "看图文教程 →");   // 连不上 / 太旧:图文教程从下载讲到配对,里面也有本机助手的下载链接
    }
  }
  function setMsg(text, cls = "err") { const m = dlg.querySelector(".tp-msg"); if (m) { m.className = "tp-msg " + cls; m.textContent = text; } }
  window.tpNeedLogin = () => {
    if (!dlg) {
      dlg = document.createElement("div");
      dlg.className = "tp-lm";
      dlg.innerHTML = `<div class="box wide" role="dialog" aria-modal="true"><h3>登录钱包</h3><div class="tp-st"></div><div class="row"></div></div>`;
      dlg.onclick = (e) => {
        if (e.target === dlg || e.target.closest("[data-x]")) dlg.hidden = true;
        else if (e.target.closest("[data-go]")) connect();
        else if (e.target.closest("[data-fin]")) finish();
      };
      document.body.appendChild(dlg);
    }
    if (dlgStage !== "code" && !busy) stage("intro");   // 正在输配对码时关掉再打开,保留输入框
    dlg.hidden = false;
  };
  // 「连接本机助手」:这里才第一次去连 127.0.0.1(用户点的,多等一会儿:浏览器可能正在问「访问本地网络」)
  async function connect() {
    if (busy) return;
    busy = true; stage("busy");
    try {
      const tok = LS.get("tp_helper_token") || "";
      const res = await probe(tok, 20_000);
      if (res.fail) return stage(res.fail === "old" ? "old" : "none");
      if (tok && res.h.paired) { clearState(); return userReload(); }   // 早就配过对,只是这个标签页暂时没用助手
      const r = await realFetch(HELPER_BASE + "/link/pair/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return stage("err", (await r.json().catch(() => null))?.error || "HTTP " + r.status);
      stage("code");
    } catch { stage("none"); }
    finally { busy = false; }
  }
  // 「完成配对」:码交给本机助手换令牌 → 存进这个浏览器 → 刷新页面(之后页面就走本机助手)
  async function finish() {
    if (busy || dlgStage !== "code") return;
    const code = String(dlg.querySelector(".tp-code input")?.value ?? "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) return setMsg("配对码是 6 位数字");
    const fin = dlg.querySelector("[data-fin]");
    busy = true; fin.disabled = true; fin.textContent = "配对中…";
    try {
      const r = await realFetch(HELPER_BASE + "/link/pair/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, label: navigator.userAgent.slice(0, 60) }), signal: AbortSignal.timeout(10_000) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || typeof d.token !== "string" || !d.token) return setMsg(d.error || "HTTP " + r.status);
      if (!LS.set("tp_helper_token", d.token)) return setMsg("这个浏览器存不了配对令牌,换个普通窗口(不是无痕窗口)再试");
      clearState();
      setMsg("配对成功,正在刷新…", "ok");
      userReload();
    } catch { setMsg(LOST_MSG); }
    finally { busy = false; if (!reloading) { fin.disabled = false; fin.textContent = "完成配对"; } }
  }

  // ---------- 连着助手时本机助手回 403「只能在本机…」(比如直接发起钱包登录、看配对码):说明要去本机助手页面做 ----------
  const LO_TITLE = "这个操作只能在本机助手页面里做";
  let lo = null;
  function localOnly() {
    if (!lo) {
      lo = document.createElement("div");
      lo.className = "tp-lm";
      lo.innerHTML = `<div class="box" role="dialog" aria-modal="true"><h3>${LO_TITLE}</h3><div>为了安全,这一步网站碰不到,请到你电脑上的本机助手页面操作</div>
        <div class="row"><button type="button" data-x>知道了</button>${link(HELPER_BASE + "/", "打开本机助手 →")}</div></div>`;
      lo.onclick = (e) => { if (e.target === lo || e.target.closest("[data-x]")) lo.hidden = true; };
      document.body.appendChild(lo);
    }
    lo.hidden = false;
  }
  // ---------- 连着助手时点「登录」:请本机助手页面弹出这个账号的扫码登录(/api/login/request 只说「账号 N」,二维码只在本机显示、不经过网站) ----------
  //   index.html 的 openLogin 在 window.TP_HELPER 时调它;本机助手页面没开着(helperPage === false)就提示先打开。扫完这里自动刷新
  let ll = null, llPoll = null, llGen = 0;
  const LOGIN_SHOWN = (acct) => `已在本机助手页面弹出账号 ${acct} 的二维码,用 Binance App 扫码;扫完这里会自动刷新`;   // 账号 1 / 2 两句词典里都有
  const LOGIN_NO_PAGE = "本机助手页面没开着:点下面打开,再点「扫码登录」";
  const helperPost = (path, body, ms) => viaHelper(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  window.tpLocalLogin = async (acct) => {
    acct = String(acct ?? "") === "2" ? "2" : "1";
    if (!ll) {
      ll = document.createElement("div");
      ll.className = "tp-lm";
      ll.innerHTML = `<div class="box" role="dialog" aria-modal="true"><h3>请在本机助手页面扫码登录</h3><div class="tp-st"></div>
        <div class="row"><button type="button" data-x>知道了</button><button type="button" data-re>刷新</button>${link(HELPER_BASE + "/", "打开本机助手 →")}</div></div>`;
      ll.onclick = (e) => {
        if (e.target === ll || e.target.closest("[data-x]")) ll.hidden = true;
        else if (e.target.closest("[data-re]")) userReload();
      };
      document.body.appendChild(ll);
    }
    clearTimeout(llPoll);
    const gen = ++llGen;   // 连点两次「登录」:只留最后一次的轮询
    const box = ll.querySelector(".tp-st");
    let d = {};
    try {
      const r = await helperPost("/api/login/request", { acct }, 10_000);
      d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    } catch (e) {
      if (gen !== llGen) return;
      box.innerHTML = `<div class="err">${esc(e?.name === "TypeError" || e?.name === "TimeoutError" ? LOST_MSG : e?.message)}</div>`;
      ll.hidden = false;
      return;
    }
    if (gen !== llGen) return;
    box.innerHTML = `<div>${esc(d.helperPage === false ? LOGIN_NO_PAGE : LOGIN_SHOWN(acct))}</div>`;
    ll.hidden = false;
    watchLogin(acct, gen);
  };
  // 等本机扫码:每 2 秒问一次这个账号的登录状态(对话框关了就停,最多 10 分钟)。先看到「待扫码」再看到「成功」才刷新 —— 之前登录留下的旧「成功」不算
  function watchLogin(acct, gen) {
    let seen = false;
    const until = Date.now() + 600_000;
    const live = () => gen === llGen && !ll.hidden && !reloading;
    const tick = async () => {
      if (!live() || Date.now() > until) return;
      try {
        const r = await helperPost("/api/login/status", { acct }, 5_000);
        const s = r.ok ? await r.json() : null;
        if (s?.state === "pending") seen = true;
        else if (s?.state === "ok" && seen && live()) return userReload();
      } catch {}
      if (live()) llPoll = setTimeout(tick, 2000);
    };
    llPoll = setTimeout(tick, 2000);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (dlg && !dlg.hidden) dlg.hidden = true;
    if (lo && !lo.hidden) lo.hidden = true;
    if (ll && !ll.hidden) ll.hidden = true;
    const m = chip?.querySelector(".tp-hmenu"); if (m) m.hidden = true;
  });
  // 没连助手:点买卖按钮就直接弹连接对话框(不等报价 / 确认框)。连着助手什么都不拦:转账、改设置这类由本机助手页面批准
  const NEED = "#buyBox button, #sellBox button, #cfYes, [data-buy], [data-b], .card .buy, .msrow .buy, td .buy, .qbuy, #setBtn";
  // 扫链页「快捷买」那一栏里的新盘提示音开关不用钱包,没连助手也照常能开
  if (!HELPER) document.addEventListener("click", (e) => {
    if (!e.target.closest?.(NEED) || e.target.closest?.("#sndBtn")) return;
    e.preventDefault(); e.stopImmediatePropagation();
    window.tpNeedLogin();
  }, true);

  // ---------- 等本机批准:请求 0.4 秒还没有结果,页面顶上固定一条「等待本机助手批准…」+ 打开本机助手的链接;有结果就收起(几条一起等时,全部有结果才收) ----------
  let apBar = null, apWait = 0;
  function approvalWait(d) {
    apWait = Math.max(0, apWait + d);
    if (!apWait) { if (apBar) apBar.hidden = true; return; }
    if (!apBar) {
      apBar = document.createElement("div");
      apBar.className = "tp-apbar";
      apBar.setAttribute("role", "status");
      apBar.innerHTML = `<span>等待本机助手批准… 请到本机助手页面点「批准」</span>${link(HELPER_BASE + "/", "打开本机助手 →")}`;
      document.body.appendChild(apBar);
    }
    apBar.hidden = false;
  }
  async function viaApprove(path, init) {
    let shown = false, over = false;
    const t = setTimeout(() => { if (!over) { shown = true; approvalWait(1); } }, 400);
    const done = () => { if (over) return; over = true; clearTimeout(t); if (shown) approvalWait(-1); };
    let r;
    try { r = await viaHelper(path, init); } catch (e) { done(); throw e; }
    if (!r.ok || !r.body || !/^text\/plain/i.test(r.headers.get("content-type") ?? "")) { done(); return r; }
    return untilAnswered(r, done);
  }
  // 转账 / 打赏是文本流:响应头马上就回来了,第一行是「⏳ 等待本机助手批准…」—— 要等后面的内容(批准后的执行 / 没批准)到了、或者流结束,才算有结果。
  //   内容原样转给页面;第一行不是等批准(不用批准)就马上算有结果
  function untilAnswered(r, done) {
    const rd = r.body.getReader(), dec = new TextDecoder();
    let head = "", answered = false;
    const look = (chunk) => {
      if (answered) return;
      head += dec.decode(chunk, { stream: true });
      const i = head.indexOf("\n");
      if (i >= 0 && (head.slice(0, i).trim() !== APPROVAL_WAIT_TEXT || head.slice(i + 1).trim())) { answered = true; head = ""; done(); }
    };
    const body = new ReadableStream({
      async pull(ctl) {
        let x;
        try { x = await rd.read(); } catch (e) { done(); return ctl.error(e); }
        if (x.done) { done(); return ctl.close(); }
        ctl.enqueue(x.value);
        look(x.value);
      },
      cancel(why) { done(); return rd.cancel(why); },
    });
    return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
  }

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

  // ---------- 连着助手:钱包相关的请求发到本机助手(method / body 照旧,加上配对令牌;path 是本站的 /api/…,令牌只发 HELPER_BASE) ----------
  async function viaHelper(path, init) {
    const headers = new Headers(init.headers);
    headers.set("authorization", "Bearer " + TOKEN);
    let r;
    try { r = await realFetch(HELPER_BASE + path, { ...init, headers }); }
    catch (e) { if (e?.name === "TypeError") recheckSoon(); throw e; }   // 连不上了:核对一下,真没了就退回公开版
    if (r.status === 401) gone();   // 令牌失效(本机页面里点了断开)
    else if (r.status === 403) r.clone().json().then((d) => { if (/只能在本机/.test(d?.error ?? "")) localOnly(); }).catch(() => {});   // 「本机没有批准」不弹,页面自己显示
    return r;
  }
  // 代币页「我的」部分:本机 /api/mine,同一个币 3 秒内只问一次;出错 / 连不上 / 回的不是这个币 → null,不进缓存。
  //   trades = false:只要持仓(合进 /api/inspect,不等本机拉完整成交,冷门币也快);true:连我的买卖点(合进 /api/history)。两种分开缓存
  const MINE_MS = 3_000, mineCache = new Map();   // 「小写 CA|t 或 p」→ { at, p }
  function mineOf(ca, trades) {
    const c = lc(ca), k = c + (trades ? "|t" : "|p"), now = Date.now();
    for (const [x, e] of mineCache) if (now - e.at >= MINE_MS) mineCache.delete(x);
    let e = mineCache.get(k);
    if (!e) {
      const p = helperPost("/api/mine", trades ? { ca: c } : { ca: c, trades: false }, 15_000)
        .then((r) => (r.ok ? r.json() : null)).then((d) => (d && lc(d.ca) === c ? d : null)).catch(() => null);
      mineCache.set(k, (e = { at: now, p }));
      p.then((d) => { if (!d && mineCache.get(k) === e) mineCache.delete(k); });
    }
    return e.p;
  }
  // 网站的 /api/inspect、/api/history(代币本身的数据)+ 本机的「我的」部分合成一份给页面:
  //   inspect 拿 wallets / holdings / costs / quoteBnb(网站有就用网站的)/ nftGate.wallets;history 拿 mine。本机那边不行就原样回网站的
  async function withMine(path, ca, site) {
    if (!isAddr(ca)) return site;
    const [r, m] = await Promise.all([site, mineOf(ca, path === "/api/history")]);
    if (!r.ok || !m) return r;
    let d;
    try { d = await r.clone().json(); } catch { return r; }
    if (!d || typeof d !== "object") return r;
    if (path === "/api/inspect") {
      d.wallets = m.wallets ?? d.wallets; d.holdings = m.holdings ?? d.holdings; d.costs = m.costs ?? d.costs;
      d.quoteBnb ??= m.quoteBnb;
      if (d.nftGate && m.nftGate) d.nftGate = { ...d.nftGate, wallets: m.nftGate.wallets };
    } else d.mine = m.mine ?? d.mine;
    return new Response(JSON.stringify(d), { status: r.status, statusText: r.statusText, headers: { "content-type": "application/json" } });
  }

  // ---------- 没连助手(连着助手时不是钱包接口的也一样):请求就地处理,或照旧发网站 ----------
  const ok = (obj) => Promise.resolve(new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } }));
  const err = (msg) => Promise.resolve(new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "content-type": "application/json" } }));
  const NO_TRADE = "先连接本机钱包助手";
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (HELPER) {
      const u = new URL(url, location.href);
      if (u.origin === location.origin && HELPER_PATHS.has(u.pathname)) return (APPROVE_PATHS.has(u.pathname) ? viaApprove : viaHelper)(u.pathname + u.search, init);
    }
    const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0];
    let body = {};
    try { body = init.body ? JSON.parse(init.body) : {}; } catch {}
    // 连着助手:代币页的数据问网站,「我的持仓 / 成本 / 买卖点」问本机助手,合成一份
    if (HELPER && (path === "/api/inspect" || path === "/api/history")) return withMine(path, body.ca, realFetch(input, init));
    // 连着助手:鼠标悬停预取除了问网站,也让本机助手先识别一下(紧接着点开时持仓来得快);不等它,出错不管
    if (HELPER && path === "/api/prefetch") viaHelper("/api/prefetch", init).catch(() => {});
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
      if (path.startsWith("/api/login/") || path.startsWith("/api/autotransfer/") || path.startsWith("/api/copy/") || path === "/api/settings/set") {
        // 连着助手还走到这里的(比如直接发起钱包登录 /api/login/start):只能在本机助手页面做,也别发给网站
        if (HELPER) { localOnly(); return err(LO_TITLE); }
        window.tpNeedLogin(); return err(NO_TRADE);
      }
    } catch (e) { return err(e.message); }
    return realFetch(input, init);
  };

  // ---------- 实时推送:网站这条照旧(成交 / 新盘 / 毕业)。连着助手时另开一条本机助手的(scope=wallet:通知、掉线、跟单…),消息交给页面同一个处理函数;
  //   追踪名单在浏览器里,连没连助手都一样:网站推来的成交命中名单,补发成「追踪」事件(本机助手不推追踪事件)
  const RealES = window.EventSource;
  const isStream = (url) => { try { const u = new URL(String(url), location.href); return u.origin === location.origin && u.pathname === "/api/stream"; } catch { return false; } };
  window.EventSource = class extends RealES {
    #h = null;   // 本机助手那一条
    constructor(url, opts) {
      super(url, opts);
      if (!isStream(url)) return;
      const fromHelper = new WeakSet();   // 从本机助手转过来的消息:不拿来补追踪(只认网站推的成交)
      if (HELPER) {
        // EventSource 设不了请求头,令牌放查询参数(只发给本机助手)。页面用 onmessage / addEventListener("message") 都收得到;本机那条断了就核对一下助手还在不在
        const h = (this.#h = new RealES(`${HELPER_BASE}/api/stream?scope=wallet&t=${encodeURIComponent(TOKEN)}`));
        h.onmessage = (m) => { const ev = new MessageEvent("message", { data: m.data }); fromHelper.add(ev); this.dispatchEvent(ev); };
        h.onerror = () => recheckSoon();
      }
      this.addEventListener("message", (m) => {
        if (fromHelper.has(m)) return;
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.type !== "trade" || !ev.trader || !targetOf(ev.trader)) return;
        metaMap().then((mm) => {
          const e = { type: "track", ...toFeed(ev, mm) };
          const fake = new MessageEvent("message", { data: JSON.stringify(e) });
          if (typeof this.onmessage === "function") this.onmessage(fake);
        });
      });
    }
    close() { this.#h?.close(); super.close(); }   // 页面关推送(重连前会先关旧的):两条一起关
  };
  // 追踪名单改了:让追踪页重新读名单(本地版靠服务器推 track-list 事件)
  window.addEventListener("tp-track-list", () => {
    if (typeof window.loadList === "function") window.loadList().then(() => window.loadFeed?.());
  });
})();

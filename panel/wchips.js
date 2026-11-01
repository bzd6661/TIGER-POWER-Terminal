// 扫链页 / 追踪页顶栏的账号余额(和交易页一样:「● 账号1 0.7183 BNB」;没登录的号显示「+ 登录账号N」,点了去交易页登录)
//   页面调 tpWalletChips(post):post 是页面自己带令牌的请求函数;网站版(public.js)会把 /api/wallets 转给本机助手或回一个空的
//   先用上次的结果(和交易页共用 localStorage.walletsCache)画出来,再每 30 秒刷新
window.tpWalletChips = (post) => {
  const top = document.querySelector(".top");
  if (!top || document.getElementById("wchips")) return;
  const st = document.createElement("style");
  st.textContent = `.top .wallets{display:flex;gap:8px;flex:none}.top .wchip{display:flex;align-items:center;gap:7px;height:32px;padding:0 11px;background:var(--s2);border:1px solid var(--line);border-radius:9px;white-space:nowrap;font-size:12px;color:var(--text);text-decoration:none}
  .top .wchip .dot{width:7px;height:7px;border-radius:50%;background:var(--up);box-shadow:0 0 6px var(--up);flex:none}.top .wchip.add{color:var(--acc);border-style:dashed;border-color:rgba(240,185,11,.45)}
  .top .wchip b{font-variant-numeric:tabular-nums}.top .wchip .u{color:var(--faint)}.top .wchip .m{color:var(--mute)}`;
  document.head.appendChild(st);
  const box = document.createElement("div");
  box.className = "wallets"; box.id = "wchips";
  const at = top.querySelector(".setwrap");
  if (at) at.before(box); else top.appendChild(box);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const draw = (d) => {
    if (!d?.sessions) return;
    box.innerHTML = d.sessions.map((s) => {
      const a = (d.accounts ?? []).find((x) => x.acct === s.acct);
      return a ? `<div class="wchip" title="${esc(a.address)}"><span class="dot"></span><span class="m">账号${esc(a.acct)}</span><b>${a.bnb === null || a.bnb === undefined ? "—" : Number(a.bnb).toFixed(4)}</b><span class="u">BNB</span></div>`
        : s.installed === false ? "" : `<a class="wchip add" href="/trade?go=secWallets">+ 登录账号${esc(s.acct)}</a>`;
    }).join("");
  };
  try { draw(JSON.parse(localStorage.getItem("walletsCache") || "null")); } catch {}
  const load = async () => {
    try {
      const r = await post("/api/wallets", {});
      const d = await r.json();
      if (r.ok) { draw(d); try { if (d.accounts?.length) localStorage.setItem("walletsCache", JSON.stringify(d)); } catch {} }
    } catch {}
  };
  load();
  setInterval(() => { if (!document.hidden) load(); }, 30_000);
};

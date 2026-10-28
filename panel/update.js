// 新版本提醒(三个页面共用):GitHub 上有「重大更新」时,左下角弹一个提示,点开看更新内容和更新步骤。
//   「稍后」只是这次关掉;「这个版本不再提示」记在本机浏览器,下一次重大更新还会提示。
(() => {
  const KEY = "updDismissed";
  const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const set = (v) => { try { localStorage.setItem(KEY, v); } catch {} };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = `
  .updpill { position:fixed; left:16px; bottom:58px; z-index:95; display:flex; align-items:center; gap:10px; max-width:440px; padding:10px 12px 10px 14px; border-radius:14px;
    background:#F47A1F; color:#140A04; box-shadow:0 10px 30px rgba(0,0,0,.45); font-size:13px; font-weight:700; }
  .updpill b { font-weight:900; } .updpill span { flex:1; line-height:1.4; }
  .updpill button { border:0; border-radius:8px; padding:6px 10px; font-weight:800; font-size:12px; cursor:pointer; white-space:nowrap; }
  .updpill .go { background:#140A04; color:#F47A1F; } .updpill .later { background:transparent; color:#140A04; opacity:.7; }
  .updmodal { position:fixed; inset:0; z-index:96; background:rgba(0,0,0,.6); display:flex; align-items:center; justify-content:center; padding:16px; }
  .updbox { width:560px; max-width:100%; max-height:90vh; overflow:auto; background:#151920; color:#e7eaf0; border:1px solid #2a313d; border-radius:14px; padding:20px 22px; font-size:13px; line-height:1.6; }
  .updbox h3 { margin:0 0 4px; font-size:17px; } .updbox .v { color:#8d96a7; font-size:12px; margin-bottom:12px; }
  .updbox ul { margin:0 0 14px; padding-left:18px; } .updbox li { margin:3px 0; }
  .updbox .how { background:#0f1217; border:1px solid #2a313d; border-radius:10px; padding:12px 14px; }
  .updbox .how b { color:#F47A1F; } .updbox code { display:block; margin:8px 0; padding:8px 10px; border-radius:7px; background:#000; color:#16c784; font-family:Consolas, monospace; font-size:12px; white-space:pre-wrap; word-break:break-all; }
  .updbox .row { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; }
  .updbox .row button, .updbox .row a { border:1px solid #2a313d; background:#1b2029; color:#e7eaf0; border-radius:8px; padding:6px 12px; font-size:12px; cursor:pointer; text-decoration:none; }
  .updbox .row .pri { background:#F47A1F; color:#140A04; border-color:#F47A1F; font-weight:800; }`;
  async function run() {
    let u;
    try { u = await fetch("/api/update-status").then((r) => r.json()); } catch { return; }
    if (!u?.major || !u.remote || get() === String(u.remote.build)) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const pill = document.createElement("div");
    pill.className = "updpill";
    pill.innerHTML = `<span>🎉 有重大更新 <b>v${esc(u.remote.version)}</b>:<i data-notr style="font-style:normal">${esc(u.remote.title)}</i></span><button class="go">怎么更新</button><button class="later" title="这次先不提示">稍后</button>`;
    document.body.appendChild(pill);
    pill.querySelector(".later").onclick = () => pill.remove();
    pill.querySelector(".go").onclick = () => {
      const en = window.UI_LANG === "en";
      // 本机助手页面(helper.html 的 <html data-ui="helper">)叫「本机助手页面」,完整版的三个页面叫「面板窗口」
      const helper = document.documentElement.dataset.ui === "helper";
      const steps = u.git
        ? (en ? `<b>You installed with git</b>: open a terminal and run<code>cd /d "${esc(u.dir)}"\ngit pull</code>then close the ${helper ? "local helper page" : "panel window"} and double-click <b>start.cmd</b> again (the startup check installs new dependencies).`
              : `<b>你是用 git 下载的</b>:在项目文件夹打开命令行,运行<code>cd /d "${esc(u.dir)}"\ngit pull</code>然后关掉${helper ? "本机助手页面" : "面板窗口"},重新双击 <b>start.cmd</b>(启动检查会自动装新依赖)。`)
        : (en ? `<b>You downloaded a zip</b>: download the latest zip and extract it <b>over</b> your old folder (<code>${esc(u.dir)}</code>). Your .env, logins and the data files in panel are kept (they are not in the zip). Then double-click <b>start.cmd</b> again.`
              : `<b>你是下载压缩包的</b>:下载最新压缩包,解压后<b>覆盖</b>到原来的文件夹(<code>${esc(u.dir)}</code>)。<br>覆盖不会动你的 .env、登录信息和 panel 里的数据文件(它们不在压缩包里)。然后重新双击 <b>start.cmd</b>。`);
      const m = document.createElement("div");
      m.className = "updmodal";
      m.innerHTML = `<div class="updbox"><h3 data-notr>${esc(u.remote.title)}</h3>
        <div class="v">新版本 v${esc(u.remote.version)}(${esc(u.remote.date ?? "")})· 你现在是 v${esc(u.local.version)}</div>
        ${u.remote.notes?.length ? `<ul data-notr>${u.remote.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
        <div class="how" data-notr>${steps}</div>
        <div class="row"><button data-a="mute">这个版本不再提示</button><a href="${esc(u.page)}" target="_blank" rel="noopener">GitHub 主页</a>${u.git ? "" : `<a class="pri" href="${esc(u.zip)}" target="_blank" rel="noopener">下载最新压缩包</a>`}<button data-a="close" class="${u.git ? "pri" : ""}">知道了</button></div></div>`;
      document.body.appendChild(m);
      m.onclick = (e) => { if (e.target === m || e.target.dataset.a === "close") m.remove(); };
      m.querySelector('[data-a="mute"]').onclick = () => { set(String(u.remote.build)); m.remove(); pill.remove(); };
    };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();

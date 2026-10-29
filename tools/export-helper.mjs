#!/usr/bin/env node
// 从这个仓库(完整版 TIGER-POWER-Terminal)按白名单导出本机助手仓库 TIGER-POWER-Helper:
//   node tools/export-helper.mjs <输出目录> [--allow-dirty]
// · 只拿 git 跟踪的文件(git ls-files):.env / .wallet / baw2/.baw / 状态和缓存文件都没被跟踪,不会带上;
//   复制的文件逐字节照抄,只有 .cmd / .vbs 统一成 CRLF(cmd 的 goto / 标签遇到 LF 会出错)
// · 读的是工作区里的文件:要导出的文件(和生成 README 等用到的源文件)有一个和 HEAD 不一样(改了没提交 / add 了没 commit)就拒绝并列出来,
//   免得把没提交、没审过的改动发出去;确实要导出没提交的改动,加 --allow-dirty
// · 从下单脚本 + panel/server.mjs / setup.mjs / daemon.mjs 出发,顺着相对 import、here("…") / new URL("…", import.meta.url) /
//   join(…) / ROOT + "…" 里的文件名、以及写成字面量的脚本路径("gang/gangbuy.mjs")往下找;运行时要读的 json 等也一起带上
// · README.md / version.json / .env.example / package.json / package-lock.json / .gitattributes 现场生成;
//   version.json 的 build 跟主仓库,版本号 / majorBuild / 标题 / 说明来自 tools/helper-release.json
// · 最后按本机的禁用清单(仓库外的 JSON,见下面「禁用清单」)扫一遍,命中就报错;清单没有或格式不对也报错。都是输出目录一个字都不写
// · 输出目录:不存在 / 空的 / 只有 .git 和上次导出的文件(按 .export-manifest)。上次导出、这次没有的删掉;.git 不碰;
//   有别的不认识的文件就拒绝(不覆盖别人的东西);要删 / 要写的路径经过链接(junction / 符号链接)指到 .git 里或输出目录外面,也拒绝
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HELPER_REPO = "bzd6661/TIGER-POWER-Helper";
const FULL_REPO = "bzd6661/TIGER-POWER-Terminal";
const MANIFEST = ".export-manifest";
const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url));

// 起点:下单会起的脚本(server.mjs 的 route() / 跟单 / 转账 / 自动转出 / 自动领取 / 打赏)+ 助手本身
const START = [
  "fast.mjs", "sell.mjs", "fourbuy.mjs", "foursell.mjs", "dexbuy.mjs", "dexsell.mjs", "flapportal.mjs", "transfer.mjs", "claim.mjs", "tip.mjs",
  "gang/gangbuy.mjs", "gang/gangv1buy.mjs", "gang/gangv1sell.mjs", "gang/gangv2sell.mjs", "gang/gangv3.mjs",
  "panel/server.mjs", "panel/setup.mjs", "panel/daemon.mjs",
];
// 代码里找不到引用、但助手要用的文件(启动脚本、页面、账号 2 的 baw)
const STATIC = [
  "start.cmd", "panel/start.cmd", "panel/daemon.vbs", "panel/helper.html", "panel/localpop.js", "panel/i18n.js", "panel/update.js", "panel/favicon.svg",
  "contracts/tip.json", "contracts/TMTip.json", "baw2/package.json", "baw2/package-lock.json", "baw2/baw2.cmd", ".gitignore",
];
// 现场生成的(不从主仓库照抄)
const GENERATED = ["README.md", "version.json", ".env.example", "package.json", "package-lock.json", ".gitattributes"];
// 发助手新版本时改这个文件(在 tools/ 里,本身不导出)
const RELEASE = "tools/helper-release.json";
// 现场生成那几个文件时读的源文件(连同导出工具自己:助手的 README 模板写在这里面);和要导出的文件一起查有没有没提交的改动
const GEN_SOURCES = ["README.md", "version.json", RELEASE, ".env.example", "package.json", "package-lock.json", "tools/export-helper.mjs"];
// 完整版界面 / 网站 / 开发用的:server.mjs 在完整版模式下会读这些页面,助手模式用不到 → 引用到了也跳过;被 import 到就报错
const FULL_ONLY = ["panel/index.html", "panel/scan.html", "panel/track.html", "panel/public.js", "panel/public-server.mjs", "panel/vendor/",
  "deploy/", "tools/", "tests/", "CHANGELOG.md", ".dockerignore", "gang/v3-tax-recipients.csv"];
const isFullOnly = (f) => FULL_ONLY.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));
// 登录凭证 / 钱包信息:就算哪天被 git add -f 了也绝不导出
const SECRET = [/(^|\/)\.env$/, /(^|\/)\.wallet\d*$/, /(^|\/)\.baw\//, /\.panel-token$/, /wallet-pins\.json$/, /web-pairs\.json$/];

// ── 顺着引用找文件 ──
// 一个 .mjs 里引用到的路径(还没解析):相对 import、here / new URL / join 里的字符串、大写常量 + "…"、写成字面量的 .mjs 路径
const lits = (text, re, i = 2) => [...text.matchAll(re)].map((m) => m[i]).filter((s) => !s.includes("${"));
function refsOf(text) {
  return [
    ...lits(text, /(?:\bfrom|\bimport)\s*\(?\s*(["'`])(\.{1,2}\/[^"'`]+)\1/g),
    ...lits(text, /\bhere\(\s*(["'`])([^"'`]+)\1\s*\)/g),
    ...lits(text, /new URL\(\s*(["'`])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)/g),
    ...[...text.matchAll(/\bjoin\(([^()]*)\)/g)].map((m) => lits(m[1], /(["'`])([^"'`]*)\1/g)).filter((a) => a.length).map((a) => posix.join(...a)),
    ...lits(text, /\b[A-Z][A-Z0-9_]*\s*\+\s*(["'`])([^"'`]+)\1/g),
    ...lits(text, /(["'`])((?:\.{1,2}\/)*[\w-]+(?:\/[\w.-]+)*\.mjs)\1/g),
  ];
}
// 先按引用它的文件所在目录解析;那里不是 git 跟踪的文件时再按仓库根目录(setup.mjs 的 here、cwd=根目录跑的代码字符串、AGENTBUY + "…")。
// 解析不到跟踪文件(运行时才生成的状态文件、目录、npm 包里的文件)返回 null
function resolveRef(from, spec, tracked) {
  if (!spec || spec.includes("\\") || isAbsolute(spec) || /^[a-z]+:/i.test(spec)) return null;
  const a = posix.normalize(posix.join(posix.dirname(from), spec));
  if (tracked.has(a)) return a;
  const b = posix.normalize(spec);
  return !b.startsWith("../") && tracked.has(b) ? b : null;
}
function collect(root, tracked) {
  const got = new Set();
  const need = (f) => { if (!tracked.has(f)) throw new Error(`白名单里的 ${f} 不是 git 跟踪的文件`); };
  const add = (f, from) => {
    if (got.has(f)) return;
    if (isFullOnly(f)) {
      if (f.endsWith(".mjs")) throw new Error(`${from} 引用了完整版专用的 ${f},助手仓库没有它会跑不起来`);
      return;
    }
    got.add(f);
    if (f.endsWith(".mjs")) for (const spec of refsOf(readFileSync(join(root, f), "utf8"))) {
      const t = resolveRef(f, spec, tracked);
      if (t) add(t, f);
    }
  };
  for (const f of [...START, ...STATIC]) { need(f); add(f, "白名单"); }
  for (const f of GENERATED) got.delete(f);
  return got;
}

// ── 现场生成的文件 ──
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const jsonText = (obj, eol) => JSON.stringify(obj, null, 2).split("\n").join(eol) + eol;

// 助手的 version.json:build / date 跟主仓库;版本号、majorBuild、标题、说明来自 tools/helper-release.json。
//   发助手新版本:改 helper-release.json 的 version / title / notes;要提醒用户「重大更新」时才把 majorBuild 改成当时主仓库的 build
//   (majorBuild 不跟着主仓库走,不然主仓库每改一次版本号,助手用户都会被提示重大更新)
export function helperVersion(mainText, releaseText) {
  const main = JSON.parse(mainText), rel = JSON.parse(releaseText), build = Number(main.build);
  if (!Number.isInteger(build) || build <= 0) throw new Error("主仓库 version.json 的 build 不是数字");
  const str = (v) => typeof v === "string" && v.length > 0;
  if (!str(rel.version) || !str(rel.title) || !Array.isArray(rel.notes) || !rel.notes.length || !rel.notes.every(str)
    || !Number.isInteger(rel.majorBuild) || rel.majorBuild <= 0) {
    throw new Error(`${RELEASE} 格式不对:要有 version(文字)、majorBuild(数字)、title(文字)、notes(文字列表)`);
  }
  // majorBuild 比 build 还新的话,装了最新版的人也会一直被提示更新
  if (rel.majorBuild > build) throw new Error(`${RELEASE} 的 majorBuild ${rel.majorBuild} 比主仓库的 build ${build} 还新`);
  return jsonText({ version: rel.version, build, date: main.date, majorBuild: rel.majorBuild, repo: HELPER_REPO, title: rel.title, notes: rel.notes }, eolOf(mainText));
}
// 助手仓库的 .gitattributes:cmd / vbs 在仓库里存 LF,取出来和 GitHub 下载的压缩包里都是 CRLF
const GITATTRIBUTES = "# Windows 启动脚本一律 CRLF(cmd 的 goto / 标签遇到 LF 会出错;GitHub 下载的压缩包也按这里转换)\n*.cmd text eol=crlf\n*.vbs text eol=crlf\n";
// 按字节把单独的 LF 换成 CRLF(已经是 CRLF 的不动;不经过文字解码,什么编码都不会坏)
function toCrlf(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) { if (buf[i] === 0x0a && buf[i - 1] !== 0x0d) out.push(0x0d); out.push(buf[i]); }
  return Buffer.from(out);
}
// 主仓库的 .env.example 去掉 QUOTE_MIN_LIQ_USD 那段(连同上面的注释和后面的空行)
function envExample(text) {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^QUOTE_MIN_LIQ_USD=/.test(l));
  if (i >= 0) {
    let s = i, e = i + 1;
    while (s > 0 && lines[s - 1].startsWith("#")) s--;
    if (lines[e] === "") e++;
    lines.splice(s, e - s);
  }
  return lines.join(eolOf(text));
}
// 包名改成 tigerpower-helper;锁文件也要改,不然第一次 npm install 会改写它,之后 git pull 就冲突
function renamePackage(text, lock) {
  const j = JSON.parse(text);
  j.name = "tigerpower-helper";
  if (lock && j.packages?.[""]) j.packages[""].name = "tigerpower-helper";
  return jsonText(j, eolOf(text));
}
function readme(eol) {
  const zip = `https://github.com/${HELPER_REPO}/archive/refs/heads/main.zip`;
  return `# TIGER POWER 本机助手

## 这是什么

[tigerpower.online](https://tigerpower.online) 的本机钱包助手:装在你自己的电脑上,让网站能用你自己的 **币安 Agentic Wallet**(\`baw\` 命令行)下单。

**第一次用,跟着图文教程走一遍最快:<https://tigerpower.online/guide>**(从下载、启动、扫码登录到连上网站,每一步都有截图)。

- 本机页面 <http://127.0.0.1:4400> 只有这几样:钱包扫码登录、网站连接时的 6 位配对码、网站请求的批准框、已连接的网站(可以一键断开)。
- 买卖、持仓、设置、自动转出、跟单、转账都在网站上操作。网站一直在更新,你不用跟着更新助手。
- 网站发来的动钱 / 放松限制的请求 —— 转账、打赏、改设置 / 改网页限额、设置或打开自动转出、开真实跟单 / 恢复跟单、解除地址锁定 —— 要在本机助手页面点 **「批准」** 才执行;点「拒绝」或 120 秒没人点就不执行。
- 网站买入有额度:默认单笔最多 0.5 BNB(每个号分别算)、每天合计最多 2 BNB;在网站上改额度也要本机批准。

想在本机直接扫链、看 K 线、下单,用完整版 [TIGER-POWER-Terminal](https://github.com/${FULL_REPO}):它已经包含本机助手,装了完整版就不用再装这个。

## 安装(Windows)

1. **装 Node.js 20 以上**:<https://nodejs.org>(一路下一步)
2. **下载这个仓库**,放在一个固定的文件夹:
   - 不用 git:下载压缩包 <${zip}> 解压;
   - 用 git:\`git clone https://github.com/${HELPER_REPO}.git\`
3. **双击根目录的 \`start.cmd\`**。第一次会自动:检查 Node 版本 → 安装依赖(\`npm install\`)→ 没装币安钱包命令行(baw)就问你要不要装(\`npm i -g @binance/agentic-wallet\`)→ 在后台启动助手 → 打开 <http://127.0.0.1:4400>。

助手在后台运行(没有窗口),cmd 窗口可以关掉;崩了会自动拉起,日志在 \`panel/panel.log\`。启动不起来时 \`start.cmd\` 会把日志最后几行打印出来。

**买卖 Gang V2 内盘** 还要装 Gang 官方命令行(其他平台不用):

\`\`\`bash
npm i -g @gangfun/cli
\`\`\`

登录前,Binance App 里要准备好:

- 开通 Agentic Wallet,并**绑定 Agent ID**(four Agent 模式 / Gang / Flap 内盘都要求钱包有 Agent ID)
- 钱包设置里打开**开发者模式**(合约调用要用,开一次大约 7 天后要重开)和**允许交易所有代币**
- 「异常交易处理」建议设成 **需要确认**(Gang 内盘卖出、被标风险的转账要用;设成自动拒绝的话这类交易会直接被拒)

可选:把 \`.env.example\` 复制成 \`.env\` 再填(代理、自己的节点、Telegram 推送),改完重新双击 \`start.cmd\`。

## 怎么用

1. **扫码登录**:在本机助手页面 <http://127.0.0.1:4400> 点「扫码登录」,用 Binance App 扫码、在 App 里确认。登录最长 48 小时,过期了再扫一次。
2. **连接网站**:打开 <https://tigerpower.online>,点「连接本机助手」。浏览器问「允许访问本地网络上的设备」时点允许。
3. **填配对码**:本机助手页面会弹出 6 位配对码,填进网站。配对一次就行,之后网站上能看自己的持仓、一键买卖、设置自动转出和跟单。
4. **批准**:网站上转账、改设置这类操作,本机助手页面会弹出批准框,写清楚要做什么(金额、收款地址是不是你自己的等)。看清楚再点「批准」。这个页面要开着才能批准。
5. **断开**:本机助手页面的「已连接的网站」里列出配对过的浏览器,点「断开」后那个浏览器马上就不能再用助手了(它还在等的批准也一起作废);要再用得在网站上重新配对。

## 安全

- 下单、转账都由你电脑上的助手签名;钱包登录只存在你自己的电脑上(账号 1 在 Windows 凭据管理器里,账号 2 在 \`baw2/.baw\`)。
- 网站服务器上没有任何钱包;网站用不到你的钱包地址和余额,网站的页面也不会把它们发给网站服务器(只有你自己点开某个地址的交易人详情时,这个地址会发给网站服务器查公开成交)。
- 登录二维码只在本机助手页面显示:网站上点登录,只是请本机助手弹出二维码。
- 动钱的请求要你在本机点「批准」;批准框里的文字由助手按校验过的参数自己生成,不用网站给的文字。
- 助手只监听 \`127.0.0.1\`,只接受配对过的 tigerpower.online 页面;10 分钟内输错 10 次配对码、或有 3 轮配对没配成(过期 / 试太多次 / 被新的一轮顶掉),就锁 15 分钟,这期间不接受新的配对。
- 每笔交易先走币安钱包的预览(链上模拟 + 风控),不通过或有风险提示就不执行;授权只授权这一笔要用的数量。
- 不要把助手放到公网服务器上。

## 第二个账号(可选)

想同时用两个币安账号,要给账号 2 单独装一份 baw(凭证存在 \`baw2/.baw\`,和账号 1 互不影响):

\`\`\`bash
cd baw2
npm install
\`\`\`

然后刷新本机助手页面,就能给账号 2 扫码登录;网站上可以选「账号 2」或「两个号」同时下单。

账号 2 的登录永远只存在 \`baw2/.baw\` 里、和账号 1 分开(就算 npm install 时装上了 keytar,也不会用 Windows 凭据管理器)。

## 更新

网站更新不用你管,只有助手本身改了才需要更新。助手每 6 小时看一次 GitHub 上的 \`version.json\`(GitHub 打不开时改用 jsDelivr),有**重大更新**时本机助手页面会提示,双击 \`start.cmd\` 时也会提醒一句。只读一个公开的版本号文件,不会自动下载或运行任何东西。

- 用 git 下载的:在助手文件夹运行 \`git pull\`,再重新双击 \`start.cmd\`。
- 下载压缩包的:下载最新压缩包,解压覆盖到原来的文件夹(\`.env\`、登录信息和 panel 里的数据文件不在压缩包里,不会被覆盖),再重新双击 \`start.cmd\`。

不想要提醒:\`.env\` 里加一行 \`AGENTBUY_NO_UPDATE_CHECK=1\`。

## 常见问题

### 端口 4400 被占 / 双击 start.cmd 打开的是完整版页面

完整版 TIGER-POWER-Terminal 已经包含本机助手,两个都用 4400 端口,同时只能开一个。装了完整版就直接用完整版连网站,不用再装助手;要换成助手,重启电脑后只双击助手的 \`start.cmd\`。

### 登录报 Connect Timeout / 连不上币安

登录、下单都要连 \`www.binance.com\`。有些网络的普通 DNS 会把它解析到假地址,扫码登录就会报 \`Connect Timeout Error\`——浏览器能打开币安是因为走了代理或「安全 DNS」,而命令行程序默认两样都不用。

**助手已经自动处理 DNS 污染**:币安的域名改用阿里 / 腾讯的加密 DNS(DoH)解析,多数情况直接就能登录。如果还是连不上(说明连真实地址也被拦了),再开代理:

- **最省事**:打开代理软件的 **TUN 模式**(虚拟网卡;Clash 里叫「TUN 模式」,v2rayN 里叫「启用 Tun」),所有程序都会走代理,登录一般就好了。
- **或者**:打开 Clash / v2rayN 等代理软件的 **「系统代理」**,助手 30 秒内会自动用上,不用重启。
- **或者手动指定**:在助手文件夹的 \`.env\` 里加一行 \`HTTPS_PROXY=http://127.0.0.1:端口\`(Clash 一般是 7890,v2rayN 一般是 10809),然后重新双击 \`start.cmd\`。

双击 \`start.cmd\` 时会自动测一次能不能连上币安,并告诉你现在走没走代理。

### 怎么停掉本机助手

助手在后台运行(没有窗口):关掉本机助手页面、关掉 cmd 窗口都不会停掉它。它由一个守护进程(\`panel/daemon.mjs\`)看着,只结束助手本身(\`panel/server.mjs\`)的话几秒后会被重新拉起来,所以两个都要结束:

- **任务管理器**:按 Ctrl+Shift+Esc →「详细信息」,结束两个 \`node.exe\`(分不清哪个是助手的:在列标题上右键 →「选择列」勾上「命令行」,看是不是 \`daemon.mjs\` / \`server.mjs\`)。电脑上没在跑别的 Node 程序的话,把 \`node.exe\` 都结束就行。
- **或者在 PowerShell 里运行**(只结束占着 4400 端口的助手,和拉起它的那个守护进程;别的 Node 程序不碰。在 \`.env\` 里改过 \`PANEL_PORT\` 的话,把 4400 换成你的端口):

\`\`\`powershell
$s = Get-NetTCPConnection -LocalPort 4400 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess
if ($s) { $d = (Get-CimInstance Win32_Process -Filter "ProcessId=$s").ParentProcessId; Get-CimInstance Win32_Process -Filter "ProcessId=$d" | Where-Object { $_.CommandLine -match 'daemon\\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Stop-Process -Id $s -Force }
\`\`\`

停掉以后网站就连不上本机助手了:还能看数据,但持仓、下单、转账这些都用不了。想再用就重新双击 \`start.cmd\`。重启电脑后助手也不会自己起来(除非你自己把它加进了开机启动),要用时双击 \`start.cmd\`。

---

本工具只是帮你调用自己钱包的下单接口,不构成任何投资建议。内盘币风险极高,自己判断。
`.split("\n").join(eol);
}

// ── 禁用清单 ──
// 不能出现在导出内容里的东西,写在仓库外的本机文件里(这个仓库自己也是公开的,清单内容不能放进来):
//   默认 ~/.config/tigerpower/export-forbidden.json;环境变量 TP_EXPORT_FORBIDDEN 可以指定别的文件。
//   格式:{ "rules": [ { "name": "规则名(报错时显示)", "pattern": "正则", "flags": "i" } ] }(flags 可省,只能用 i / m / s / u)
//   文件没有、不是合法 JSON、没有规则、规则格式不对或正则写错 → 一律报错,不导出
export const DEFAULT_FORBIDDEN_FILE = join(homedir(), ".config", "tigerpower", "export-forbidden.json");
export function loadForbidden(file = process.env.TP_EXPORT_FORBIDDEN || DEFAULT_FORBIDDEN_FILE) {
  const bad = (why) => new Error(`禁用清单 ${file} ${why}。导出前必须有这个本机文件(格式见 tools/export-helper.mjs「禁用清单」),也可以用环境变量 TP_EXPORT_FORBIDDEN 指定`);
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { throw bad(e.code === "ENOENT" ? "不存在" : "读不出来"); }
  let j;
  try { j = JSON.parse(text.replace(/^﻿/, "")); } catch { throw bad("不是合法的 JSON"); }
  if (!Array.isArray(j?.rules) || !j.rules.length) throw bad("里没有规则(要有非空的 rules 列表)");
  return j.rules.map((r, i) => {
    const flags = r?.flags ?? "";
    if (typeof r?.name !== "string" || !r.name || typeof r.pattern !== "string" || !r.pattern || typeof flags !== "string" || !/^[imsu]*$/.test(flags)) {
      throw bad(`的第 ${i + 1} 条规则格式不对(要有 name、pattern;flags 只能用 i / m / s / u)`);
    }
    try { return { name: r.name, re: new RegExp(r.pattern, flags) }; } catch { throw bad(`的第 ${i + 1} 条规则「${r.name}」正则写错了`); }
  });
}
// files = Map(相对路径 → Buffer),rules = loadForbidden() 的结果。文件名和内容都扫;
//   命中就抛错,列出「文件:规则名」(只报规则名,不把命中的内容再打出来);没有规则也不放行
export function checkPublishable(files, rules) {
  if (!Array.isArray(rules) || !rules.length) throw new Error("没有禁用规则,不导出");
  const hits = [];
  for (const [f, buf] of files) {
    const text = buf.toString("utf8");
    for (const { name, re } of rules) if (re.test(f) || re.test(text)) hits.push(`${f}:${name}`);
    if (SECRET.some((re) => re.test(f))) hits.push(`${f}:登录凭证 / 钱包文件`);
  }
  if (hits.length) throw new Error(`导出内容里有不能公开的东西,什么都没写:\n  ${hits.join("\n  ")}`);
}

// ── 没提交的改动 ──
// files 里和 HEAD 不一样的(改了没提交、git add 了没 commit 的都算;换行符按 git 的设置比,不会误报),返回相对路径(排好序)
export function dirtyFiles(root, files) {
  if (!files.length) return [];
  // stderr 收起来:git 对 LF / CRLF 的提醒(warning: … LF will be replaced by CRLF)不打到屏幕上;真出错时 execFileSync 照样抛
  const out = execFileSync("git", ["--literal-pathspecs", "diff", "--name-only", "-z", "HEAD", "--", ...files], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

// ── 写输出目录 ──
const inside = (parent, child) => { const r = relative(parent, child); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
// 目录里的全部文件(相对路径,/ 分隔);顶层 .git 不算。链接 / junction 也当文件(不跟进去)
function listFiles(dir, base = "") {
  return readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (rel === ".git") return [];
    return e.isDirectory() ? listFiles(dir, rel) : [rel];
  });
}
// 清单路径里的一段在 Windows 上会不会其实是 .git(或者根本不是它看上去的那个名字):
//   先转小写、去掉末尾的点和空格(Windows 打开文件时会去掉,.GIT、.git.、.git  都是 .git)再比 .git;
//   GIT~1 这种短文件名可能就是 .git;带冒号的是 NTFS 数据流;末尾有点 / 空格的(含 ...)真正打开的不是这个名字 —— 都不认
function badSegment(seg) {
  const lower = seg.toLowerCase();
  const norm = lower.replace(/[. ]+$/, "");
  return norm === ".git" || /^git~\d+$/.test(norm) || norm !== lower || seg.includes(":");
}
// 清单里的每一行必须是普通的相对路径:不能是绝对路径、不能带 ..、哪一段都不能是 .git(不然改过的清单能让我们删别处的文件)
function readManifest(dir) {
  const lines = readFileSync(join(dir, MANIFEST), "utf8").split(/\r?\n/).filter(Boolean);
  for (const f of lines) {
    const ok = !isAbsolute(f) && !/^[a-z]:/i.test(f) && !f.includes("\\") && posix.normalize(f) === f && !f.split("/").includes("..")
      && !f.split("/").some(badSegment) && f !== MANIFEST;
    if (!ok) throw new Error(`${MANIFEST} 清单里有不合法的路径:${f}`);
  }
  return lines;
}
// 输出目录里要删 / 要写的路径,按真实路径(跟着 junction / 符号链接走到底)核对:必须在输出目录里面、不在输出目录的 .git 里。
//   清单里的路径本身已经验过,但输出目录里可能有链接(比如 lnk → .git):「lnk/config」看着正常,删的却是 .git/config。
//   还不存在的路径按最近一个存在的上级目录算;断掉的链接(指的东西不在了)也不敢动
const present = (p) => { try { lstatSync(p); return true; } catch { return false; } };   // 链接本身在就算(不管它指的东西在不在)
function checkTargets(out, list) {
  if (!existsSync(out)) return;   // 新建的输出目录:里面还没有任何链接
  const realOut = realpathSync.native(out);
  const gitDir = join(realOut, ".git");
  for (const f of list) {
    const parts = f.split("/");
    let i = parts.length;
    while (i > 0 && !present(join(out, ...parts.slice(0, i)))) i--;
    let real;
    try { real = join(i > 0 ? realpathSync.native(join(out, ...parts.slice(0, i))) : realOut, ...parts.slice(i)); } catch { real = null; }
    if (real === null || real === realOut || !inside(realOut, real)) throw new Error(`${MANIFEST} 清单 / 导出里的 ${f} 实际指到输出目录外面,不敢动,什么都没改`);
    if (inside(gitDir, real)) throw new Error(`${MANIFEST} 清单 / 导出里的 ${f} 实际指到输出目录的 .git 里,不敢动,什么都没改`);
  }
}
function prepareOut(out, root) {
  if (inside(root, out)) throw new Error(`输出目录不能在源仓库里面:${out}`);
  if (inside(out, root)) throw new Error(`输出目录不能包住源仓库:${out}`);
  if (!existsSync(out)) return [];
  if (!statSync(out).isDirectory()) throw new Error(`输出路径不是目录:${out}`);
  const existing = listFiles(out);
  if (!existing.length) return [];
  if (!existing.includes(MANIFEST)) throw new Error(`输出目录不是空的,也不是上次导出的(没有 ${MANIFEST}),不敢写:${out}`);
  const old = readManifest(out);
  const known = new Set([...old, MANIFEST]);
  const unknown = existing.filter((f) => !known.has(f));
  if (unknown.length) throw new Error(`输出目录里有不认识的文件,不敢覆盖:${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? " …" : ""}`);
  return old;
}
function writeOut(out, files, old) {
  const gone = old.filter((f) => !files.has(f));
  checkTargets(out, [...gone, ...files.keys(), MANIFEST]);   // 先全部核对(一个不对就什么都不动),再删、再写
  // 上次导出、这次没有的:删掉文件,再把删空的目录往上清掉(到输出目录为止)
  for (const f of gone) {
    rmSync(join(out, f), { force: true });
    for (let d = posix.dirname(f); d !== "."; d = posix.dirname(d)) {
      const abs = join(out, d);
      if (!existsSync(abs) || readdirSync(abs).length) break;
      rmdirSync(abs);
    }
  }
  for (const [f, buf] of files) {
    mkdirSync(dirname(join(out, f)), { recursive: true });
    writeFileSync(join(out, f), buf);
  }
  writeFileSync(join(out, MANIFEST), [...files.keys()].sort().join("\n") + "\n");
}

// allowDirty:要导出的文件有没提交的改动也照导(命令行 --allow-dirty);默认不导
export async function exportHelper(outDir, { root = DEFAULT_ROOT, allowDirty = false } = {}) {
  if (!outDir) throw new Error("要给输出目录");
  const rules = loadForbidden();   // 先读禁用清单:没有或格式不对就什么都不做
  root = resolve(root);
  const out = resolve(String(outDir));
  const old = prepareOut(out, root);
  const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean));
  const read = (f) => readFileSync(join(root, f), "utf8");
  const picked = [...collect(root, tracked)].sort();
  if (!allowDirty) {
    const dirty = dirtyFiles(root, [...picked, ...GEN_SOURCES.filter((f) => tracked.has(f))]);
    if (dirty.length) throw new Error(`这些要导出的文件(或生成助手文件用的源文件)和最新提交(HEAD)不一样,什么都没写:\n  ${dirty.join("\n  ")}\n先提交再导出;确实要导出没提交的改动,加 --allow-dirty`);
  }
  const files = new Map();
  for (const f of picked) {
    const buf = readFileSync(join(root, f));
    files.set(f, /\.(cmd|vbs)$/i.test(f) ? toCrlf(buf) : buf);
  }
  files.set("README.md", Buffer.from(readme(eolOf(read("README.md")))));
  files.set("version.json", Buffer.from(helperVersion(read("version.json"), read(RELEASE))));
  files.set(".env.example", Buffer.from(envExample(read(".env.example"))));
  files.set("package.json", Buffer.from(renamePackage(read("package.json"), false)));
  files.set("package-lock.json", Buffer.from(renamePackage(read("package-lock.json"), true)));
  files.set(".gitattributes", Buffer.from(GITATTRIBUTES));
  checkPublishable(files, rules);   // 最后一步检查:不过就抛错,输出目录还没动过
  writeOut(out, files, old);
  return { files: [...files.keys()].sort() };
}

// 命令行
const self = fileURLToPath(import.meta.url);
const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
if (process.platform === "win32" ? argv1.toLowerCase() === self.toLowerCase() : argv1 === self) {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--")), rest = args.filter((a) => !a.startsWith("--"));
  if (rest.length !== 1 || flags.some((f) => f !== "--allow-dirty")) {
    console.error("用法:node tools/export-helper.mjs <输出目录> [--allow-dirty](输出目录:空目录,或上次导出的目录;--allow-dirty:要导出的文件有没提交的改动也照导)");
    process.exit(2);
  }
  const dir = rest[0];
  try {
    const { files } = await exportHelper(dir, { allowDirty: flags.includes("--allow-dirty") });
    console.log(`导出 ${files.length} 个文件 → ${resolve(dir)}`);
  } catch (e) { console.error("✗ " + e.message); process.exit(1); }
}

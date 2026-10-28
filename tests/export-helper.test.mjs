// 本机助手仓库导出(tools/export-helper.mjs):导到临时目录,检查该有的都有、不该有的都没有、
//   导出的脚本里引用到的文件都在(少一个下单脚本要到下单时才报错)、版本号 / 包名对、启动脚本是 CRLF;
//   禁用清单(仓库外的本机文件)没有就不导出、命中就报错;再导一次能覆盖旧的导出、遇到不认识的文件拒绝;
//   panel/update.mjs 的仓库名从 version.json 读
// 这里只导文件、import 一下 update.mjs(不联网),不启动任何导出来的程序。
// 禁用清单用测试自己造的(环境变量 TP_EXPORT_FORBIDDEN 指过去),所以没有本机清单也能跑;本机有清单时另外用它扫一遍导出结果
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, appendFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportHelper, checkPublishable, loadForbidden, helperVersion, DEFAULT_FORBIDDEN_FILE } from "../tools/export-helper.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TOOL = fileURLToPath(new URL("../tools/export-helper.mjs", import.meta.url));
const src = (f) => readFileSync(join(ROOT, f), "utf8");
const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean));
const tmp = () => mkdtempSync(join(tmpdir(), "tp-helper-export-"));
// 对源仓库本身的导出一律带 allowDirty:这些测试看导出的内容,不该因为工作区里有还没提交的改动就失败(「没提交就拒绝」另有测试,用克隆出来的仓库测)
const DIRTY_OK = { allowDirty: true };
// 目录里的全部文件(相对路径,/ 分隔),顶层 .git 不算
const listFiles = (dir, base = "") => readdirSync(join(dir, base), { withFileTypes: true }).flatMap((e) => {
  const rel = base ? `${base}/${e.name}` : e.name;
  if (rel === ".git") return [];
  return e.isDirectory() ? listFiles(dir, rel) : [rel];
});

// 现场生成的(不是原样复制的)
const GENERATED = new Set(["README.md", "version.json", ".env.example", "package.json", "package-lock.json", ".gitattributes", ".export-manifest"]);
const PRESENT = ["start.cmd", "panel/start.cmd", "panel/setup.mjs", "panel/daemon.mjs", "panel/daemon.vbs", "panel/server.mjs", "panel/weblink.mjs",
  "panel/helper.html", "panel/localpop.js", "panel/i18n.js", "panel/update.js", "panel/favicon.svg", "accounts.mjs", "env.mjs", "proxy.mjs",
  "nokeytar.mjs", "transfer.mjs", "tip.mjs", "claim.mjs", "contracts/tip.json", "baw2/package.json", "README.md", "version.json", ".env.example",
  ".gitignore", "package.json", "package-lock.json", ".gitattributes",
  // 下单路径上的脚本(server.mjs 的 route() / 跟单 / 自动转出 / 自动领取会起的)
  "fast.mjs", "sell.mjs", "fourbuy.mjs", "foursell.mjs", "dexbuy.mjs", "dexsell.mjs", "flapportal.mjs", "gang/gangbuy.mjs", "gang/gangv1buy.mjs",
  "gang/gangv1sell.mjs", "gang/gangv2sell.mjs", "gang/gangv3.mjs", "gang/gangcore.mjs", "contracts/TMTip.json", "baw2/package-lock.json", "baw2/baw2.cmd"];
// 结尾是 / 的是整个目录
const ABSENT = ["panel/index.html", "panel/scan.html", "panel/track.html", "panel/public.js", "panel/public-server.mjs", "panel/vendor/", "deploy/",
  "tools/", "tests/", "gang/v3-tax-recipients.csv", ".env", ".wallet", "CHANGELOG.md"];
const isAbsent = (f) => ABSENT.some((a) => (a.endsWith("/") ? f.startsWith(a) : f === a));

// 测试用的禁用清单:假规则,和导出内容无关(真规则只在仓库外的本机文件里)
const rulesDir = tmp();
const writeRules = (name, data) => { const f = join(rulesDir, name); writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data)); return f; };
const TEST_RULES = writeRules("rules.json", { rules: [{ name: "测试项目名", pattern: "secretproj", flags: "i" }, { name: "测试用户目录", pattern: String.raw`Users[\\/]+someone`, flags: "i" }] });
const savedEnv = process.env.TP_EXPORT_FORBIDDEN;
process.env.TP_EXPORT_FORBIDDEN = TEST_RULES;   // 命令行测试的子进程也继承

let out, res, files;
before(async () => {
  out = tmp();
  res = await exportHelper(out, DIRTY_OK);
  files = listFiles(out);
});
after(() => {
  if (out) rmSync(out, { recursive: true, force: true });
  rmSync(rulesDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.TP_EXPORT_FORBIDDEN; else process.env.TP_EXPORT_FORBIDDEN = savedEnv;
});
const read = (f) => readFileSync(join(out, f), "utf8");
const crlf = (s) => s.replace(/\r?\n/g, "\r\n");   // LF → CRLF(已经是 CRLF 的不动)

test("该有的文件都在,不该有的都没有", () => {
  for (const f of PRESENT) assert.ok(files.includes(f), `缺 ${f}`);
  for (const f of files) assert.ok(!isAbsent(f), `不该导出 ${f}`);
  for (const f of files) assert.ok(!/(^|\/)\.env$|(^|\/)\.wallet\d*$|(^|\/)\.baw\//.test(f), `不该导出 ${f}`);
});

test("除了现场生成的,导出的都是 git 跟踪的文件、和源文件逐字节一样(cmd / vbs 只会换成 CRLF);清单和返回值一致", () => {
  for (const f of files) {
    if (GENERATED.has(f)) continue;
    assert.ok(tracked.has(f), `${f} 不是 git 跟踪的文件`);
    if (/\.(cmd|vbs)$/.test(f)) assert.equal(read(f), crlf(src(f)), `${f} 和源文件不一样`);
    else assert.ok(readFileSync(join(out, f)).equals(readFileSync(join(ROOT, f))), `${f} 和源文件不一样`);
  }
  const manifest = read(".export-manifest").split(/\r?\n/).filter(Boolean);
  assert.deepEqual(manifest, [...res.files].sort());
  assert.deepEqual([...res.files].sort(), files.filter((f) => f !== ".export-manifest").sort());
});

// 引用的解析:先按引用它的文件所在目录;那里不是源仓库的文件时再按仓库根目录(setup.mjs 的 here 和 cwd=根目录跑的代码字符串都按根目录)
function resolveRef(from, spec) {
  const a = posix.normalize(posix.join(posix.dirname(from), spec));
  if (tracked.has(a)) return a;
  const b = posix.normalize(spec);
  return tracked.has(b) ? b : a;
}
const literals = (text, re, i = 2) => [...text.matchAll(re)].map((m) => m[i]).filter((s) => !s.includes("${"));
const mjs = () => files.filter((f) => f.endsWith(".mjs"));

test("导出的 .mjs 里每个相对 import / import() 都能在导出目录里找到", () => {
  let n = 0;
  for (const f of mjs()) {
    for (const spec of literals(read(f), /(?:\bfrom|\bimport)\s*\(?\s*(["'`])(\.{1,2}\/[^"'`]+)\1/g)) {
      n++;
      const t = resolveRef(f, spec);
      assert.ok(files.includes(t), `${f} 引用的 ${spec}(${t})没导出`);
    }
  }
  assert.ok(n > 50, `只找到 ${n} 个 import,正则可能不对`);
});

test("here(…) / new URL(…, import.meta.url) / join(…) 里的 .mjs 都在;引用到的 git 跟踪文件(json 等)也都在", () => {
  const seen = new Set();
  for (const f of mjs()) {
    const text = read(f);
    const refs = [
      ...literals(text, /\bhere\(\s*(["'`])([^"'`]+)\1\s*\)/g),
      ...literals(text, /new URL\(\s*(["'`])([^"'`]+)\1\s*,\s*import\.meta\.url\s*\)/g),
      // join(…):参数里的字符串按顺序拼起来
      ...[...text.matchAll(/\bjoin\(([^()]*)\)/g)].map((m) => literals(m[1], /(["'`])([^"'`]*)\1/g)).filter((a) => a.length).map((a) => posix.join(...a)),
    ];
    for (const spec of refs) {
      const t = resolveRef(f, spec);
      seen.add(t);
      if (spec.endsWith(".mjs")) assert.ok(files.includes(t), `${f} 引用的 ${spec}(${t})没导出`);
      else if (tracked.has(t) && !isAbsent(t)) assert.ok(files.includes(t), `${f} 运行时要读的 ${spec}(${t})没导出`);
    }
  }
  // 抽查几个:server.mjs 读的版本号 / 打赏合约,tip.mjs 读的合约 ABI,setup.mjs 起的守护进程
  for (const f of ["version.json", "contracts/tip.json", "contracts/TMTip.json", "panel/daemon.vbs", "panel/helper.html", "proxy.mjs", "nokeytar.mjs"]) assert.ok(seen.has(f), `没认出对 ${f} 的引用`);
});

test("写成字面量的脚本路径(下单路由、网页滑点表、ROOT + \"x.mjs\")都能找到", () => {
  for (const f of mjs()) {
    for (const spec of literals(read(f), /(["'`])((?:\.{1,2}\/)*[\w-]+(?:\/[\w.-]+)*\.mjs)\1/g)) {
      const t = resolveRef(f, spec);
      assert.ok(files.includes(t), `${f} 里的 "${spec}"(${t})没导出`);
    }
  }
});

test("start.cmd / daemon.vbs / baw2.cmd 调起的文件都在", () => {
  for (const f of files.filter((x) => /\.(cmd|vbs)$/.test(x))) {
    const text = read(f);
    const refs = [...literals(text, /(%~dp0)([^"%\s]+?\.(?:mjs|cmd))/g), ...literals(text, /(")\\([\w.-]+\.mjs)"/g)];
    for (const spec of refs) {
      const t = posix.normalize(posix.join(posix.dirname(f), spec.replace(/\\/g, "/")));
      assert.ok(files.includes(t), `${f} 调的 ${spec}(${t})没导出`);
    }
  }
});

test(".gitattributes 让 cmd / vbs 在仓库外都是 CRLF;导出的 cmd / vbs 本身也是 CRLF", () => {
  const lines = read(".gitattributes").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  assert.ok(lines.includes("*.cmd text eol=crlf"), lines.join(" | "));
  assert.ok(lines.includes("*.vbs text eol=crlf"), lines.join(" | "));
  const scripts = files.filter((f) => /\.(cmd|vbs)$/.test(f));
  assert.ok(scripts.length >= 4, scripts.join(" "));
  for (const f of scripts) assert.doesNotMatch(read(f), /(^|[^\r])\n/, `${f} 里有不带 CR 的换行`);
});

test("version.json:build 跟主仓库;版本号 / majorBuild / 标题 / 说明来自 tools/helper-release.json;package.json / package-lock.json 改名", () => {
  const main = JSON.parse(src("version.json"));
  const rel = JSON.parse(src("tools/helper-release.json"));
  const v = JSON.parse(read("version.json"));
  assert.equal(v.repo, "bzd6661/TIGER-POWER-Helper");
  assert.equal(typeof v.build, "number");
  assert.equal(v.build, main.build);
  assert.equal(v.version, rel.version);
  assert.equal(v.majorBuild, rel.majorBuild);
  assert.equal(v.title, rel.title);
  assert.deepEqual(v.notes, rel.notes);
  assert.equal(v.date, main.date);
  const p = JSON.parse(read("package.json")), mp = JSON.parse(src("package.json"));
  assert.equal(p.name, "tigerpower-helper");
  assert.deepEqual({ ...p, name: mp.name }, mp);
  // 锁文件里的名字也要改,不然 npm install 会改写它,之后 git pull 就冲突
  const l = JSON.parse(read("package-lock.json")), ml = JSON.parse(src("package-lock.json"));
  assert.equal(l.name, "tigerpower-helper");
  assert.equal(l.packages[""].name, "tigerpower-helper");
  l.name = ml.name; l.packages[""].name = ml.packages[""].name;
  assert.deepEqual(l, ml);
});

test("helperVersion:majorBuild 用发版文件里的,不跟主仓库 build;发版文件不对就报错", () => {
  const main = JSON.stringify({ version: "9.9.9", build: 2030010105, date: "2030-01-01", majorBuild: 2030010105 });
  const rel = { version: "1.2.0", majorBuild: 2029120101, title: "测试版", notes: ["一", "二"] };
  const v = JSON.parse(helperVersion(main, JSON.stringify(rel)));
  assert.deepEqual(v, { version: "1.2.0", build: 2030010105, date: "2030-01-01", majorBuild: 2029120101, repo: "bzd6661/TIGER-POWER-Helper", title: "测试版", notes: ["一", "二"] });
  // majorBuild 比 build 还新:装了最新版的人也会一直被提示更新
  assert.throws(() => helperVersion(main, JSON.stringify({ ...rel, majorBuild: 2030010106 })), /majorBuild/);
  for (const bad of [{ ...rel, version: "" }, { ...rel, title: 1 }, { ...rel, notes: [] }, { ...rel, notes: ["", "x"] }, { ...rel, majorBuild: "2029120101" }, { version: "1", title: "x", notes: ["x"] }]) {
    assert.throws(() => helperVersion(main, JSON.stringify(bad)), /helper-release\.json/, JSON.stringify(bad));
  }
  assert.throws(() => helperVersion(JSON.stringify({ build: "x" }), JSON.stringify(rel)), /build/);
});

test(".env.example:去掉 QUOTE_MIN_LIQ_USD,其余照旧", () => {
  const e = read(".env.example");
  assert.doesNotMatch(e, /QUOTE_MIN_LIQ_USD/);
  assert.doesNotMatch(e, /流动性门槛/);
  for (const k of ["BSC_LOG_RPC=", "BSC_RPC=", "BSC_WSS=", "TG_BOT_TOKEN=", "TG_CHAT_ID=", "HTTPS_PROXY="]) assert.ok(e.includes(k), `缺 ${k}`);
  assert.doesNotMatch(e, /(\r?\n){3}/);   // 去掉那段后不留连着的空行
});

test("README:助手自己的说明(安装 / 怎么用 / 安全 / 第二个账号 / 更新 / 端口)", () => {
  const r = read("README.md");
  for (const s of ["## 这是什么", "## 安装(Windows)", "## 怎么用", "## 安全", "## 第二个账号", "## 更新", "## 常见问题",
    "https://github.com/bzd6661/TIGER-POWER-Helper/archive/refs/heads/main.zip", "https://github.com/bzd6661/TIGER-POWER-Helper.git",
    "http://127.0.0.1:4400", "https://tigerpower.online", "连接本机助手", "配对码", "「批准」", "start.cmd", "Node.js 20",
    "npm i -g @binance/agentic-wallet", "npm i -g @gangfun/cli", "cd baw2", "TIGER-POWER-Terminal", "4400", "0.5 BNB", "2 BNB", "HTTPS_PROXY", "git pull",
    // 本机助手页面能断开网站;怎么停掉助手(守护进程会把单独结束的 server 拉起来,两个都要结束)
    "已连接的网站", "「断开」", "### 怎么停掉本机助手", "daemon.mjs", "server.mjs", "Stop-Process"]) {
    assert.ok(r.includes(s), `README 缺「${s}」`);
  }
  // 配对锁定的规则照 weblink.mjs 写准(错码 10 次 / 失败 3 轮,10 分钟内 → 锁 15 分钟);钱包地址的说法不能比实际更绝对
  assert.ok(r.includes("10 分钟内输错 10 次配对码、或有 3 轮配对没配成"));
  assert.doesNotMatch(r, /连续输错/);
  assert.doesNotMatch(r, /只在你的浏览器和本机助手之间传/);
  assert.ok(r.includes("只有你自己点开某个地址的交易人详情时"));
  // 停助手的 PowerShell 命令原样出现在 README 里(模板字符串里的 $_ / 反斜杠没被吃掉),而且只认 4400 端口上的助手和它的守护进程,
  // 不再按命令行里有没有 server.mjs 去结束 —— 那样会连别的项目的 node 服务一起结束
  assert.ok(r.includes("$s = Get-NetTCPConnection -LocalPort 4400 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess"));
  assert.ok(r.includes("Where-Object { $_.CommandLine -match 'daemon\\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Stop-Process -Id $s -Force }"));
  assert.doesNotMatch(r, /daemon\.mjs\|server\.mjs/);
});

test("本机有禁用清单时:用真规则扫一遍导出结果(没有就跳过)", (t) => {
  if (!existsSync(DEFAULT_FORBIDDEN_FILE)) return t.skip("本机没有禁用清单");
  const map = new Map(files.map((f) => [f, readFileSync(join(out, f))]));
  assert.doesNotThrow(() => checkPublishable(map, loadForbidden(DEFAULT_FORBIDDEN_FILE)));
});

test("扫描:命中就抛错,列出文件和规则名(不带命中的内容);路径也扫;没有规则不放行", () => {
  const map = (o) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
  const rules = [{ name: "项目名", re: /secretproj/i }, { name: "用户目录", re: /Users[\\/]+someone/i }];
  assert.doesNotThrow(() => checkPublishable(map({ "a.mjs": "const x = 1;" }), rules));
  const cases = [
    [{ "a.mjs": "// SecretProj 0x1" }, /a\.mjs:项目名/],
    [{ "c.js": "C:\\Users\\someone\\x" }, /c\.js:用户目录/],
    [{ "docs/secretproj.md": "x" }, /secretproj\.md:项目名/],
    [{ ".env": "X=1" }, /\.env:登录凭证/],
    [{ "baw2/.baw/session.json": "{}" }, /登录凭证/],
  ];
  for (const [o, re] of cases) {
    assert.throws(() => checkPublishable(map(o), rules), (e) => re.test(e.message) && !e.message.includes("0x1") && !e.message.includes("\\x"), JSON.stringify(Object.keys(o)));
  }
  assert.throws(() => checkPublishable(map({ "a.mjs": "x" }), []), /禁用规则/);
  assert.throws(() => checkPublishable(map({ "a.mjs": "x" })), /禁用规则/);
});

test("禁用清单:没有 / 不是 JSON / 没有规则 / 规则格式不对 / 正则写错 → 报错;带 BOM 的能读", () => {
  const cases = [
    [join(rulesDir, "nope.json"), /不存在/],
    [writeRules("bad.json", "{ rules: "), /JSON/],
    [writeRules("empty.json", { rules: [] }), /没有规则/],
    [writeRules("norules.json", { other: 1 }), /没有规则/],
    [writeRules("noname.json", { rules: [{ pattern: "x" }] }), /第 1 条/],
    [writeRules("nopat.json", { rules: [{ name: "a", pattern: "" }] }), /第 1 条/],
    [writeRules("gflag.json", { rules: [{ name: "a", pattern: "x", flags: "g" }] }), /第 1 条/],
    [writeRules("badre.json", { rules: [{ name: "a", pattern: "x" }, { name: "b", pattern: "(" }] }), /第 2 条/],
  ];
  for (const [f, re] of cases) assert.throws(() => loadForbidden(f), (e) => /禁用清单/.test(e.message) && re.test(e.message), f);
  const bom = writeRules("bom.json", "\uFEFF" + JSON.stringify({ rules: [{ name: "a", pattern: "x", flags: "i" }] }));
  const r = loadForbidden(bom);
  assert.equal(r.length, 1);
  assert.ok(r[0].re.test("X"));
  // 不传路径:用环境变量 TP_EXPORT_FORBIDDEN
  assert.deepEqual(loadForbidden().map((x) => x.name), ["测试项目名", "测试用户目录"]);
});

test("导出时:禁用清单没有就不导出,命中就报错,输出目录都不动", async () => {
  const d = tmp();
  try {
    process.env.TP_EXPORT_FORBIDDEN = join(rulesDir, "nope.json");
    await assert.rejects(exportHelper(d), /禁用清单/);
    assert.deepEqual(readdirSync(d), []);
    // 一条会命中导出内容的规则(README 的标题):报出文件,什么都不写
    process.env.TP_EXPORT_FORBIDDEN = writeRules("hit.json", { rules: [{ name: "命中测试", pattern: "TIGER POWER 本机助手" }] });
    await assert.rejects(exportHelper(d, DIRTY_OK), /README\.md:命中测试/);
    assert.deepEqual(readdirSync(d), []);
  } finally {
    process.env.TP_EXPORT_FORBIDDEN = TEST_RULES;
    rmSync(d, { recursive: true, force: true });
  }
});

test("panel/update.mjs:仓库名从 version.json 的 repo 读,格式不对用完整版仓库", async () => {
  const helper = await import(pathToFileURL(join(out, "panel/update.mjs")).href);
  assert.equal(helper.REPO, "bzd6661/TIGER-POWER-Helper");
  assert.equal(helper.updateStatus().zip, "https://github.com/bzd6661/TIGER-POWER-Helper/archive/refs/heads/main.zip");
  const full = await import("../panel/update.mjs");
  assert.equal(full.REPO, "bzd6661/TIGER-POWER-Terminal");
  for (const [repo, want] of [["someone/Some-Repo.x", "someone/Some-Repo.x"], ["a/b/c", null], ["", null], [123, null], ["a b/c", null], [undefined, null]]) {
    const d = tmp();
    try {
      mkdirSync(join(d, "panel"));
      copyFileSync(join(ROOT, "panel/update.mjs"), join(d, "panel/update.mjs"));
      writeFileSync(join(d, "version.json"), JSON.stringify({ version: "1", build: 1, repo }));
      const m = await import(pathToFileURL(join(d, "panel/update.mjs")).href);
      assert.equal(m.REPO, want ?? "bzd6661/TIGER-POWER-Terminal", `repo=${JSON.stringify(repo)}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test("再导一次:上次导出、这次没有的删掉,.git 不动;有不认识的文件就拒绝、什么都不动", async () => {
  const d = tmp();
  try {
    await exportHelper(d, DIRTY_OK);
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, ".git/HEAD"), "ref: refs/heads/main\n");
    // 假装上一版还导出过 old/stale.mjs,而且有人改过一个导出的文件
    mkdirSync(join(d, "old"));
    writeFileSync(join(d, "old/stale.mjs"), "");
    writeFileSync(join(d, ".export-manifest"), readFileSync(join(d, ".export-manifest"), "utf8") + "old/stale.mjs\n");
    writeFileSync(join(d, "accounts.mjs"), "改过");
    const again = await exportHelper(d, DIRTY_OK);
    assert.ok(!existsSync(join(d, "old/stale.mjs")) && !existsSync(join(d, "old")), "旧文件和空目录要删掉");
    assert.equal(readFileSync(join(d, ".git/HEAD"), "utf8"), "ref: refs/heads/main\n");
    assert.ok(readFileSync(join(d, "accounts.mjs")).equals(readFileSync(join(ROOT, "accounts.mjs"))));
    assert.deepEqual(again.files, res.files);
    // 不认识的文件
    writeFileSync(join(d, "notes.txt"), "x");
    await assert.rejects(exportHelper(d, DIRTY_OK), /notes\.txt/);
    assert.ok(existsSync(join(d, "notes.txt")));
    assert.ok(existsSync(join(d, "accounts.mjs")));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("拒绝:没有清单的非空目录、清单里指向 .git 或目录外的条目、源仓库里面的目录", async () => {
  const d = tmp();
  try {
    writeFileSync(join(d, "a.txt"), "x");
    await assert.rejects(exportHelper(d), /export-manifest/);
    assert.deepEqual(readdirSync(d), ["a.txt"]);
    rmSync(join(d, "a.txt"));
    // Windows 上路径不分大小写、每一段末尾的点和空格会被去掉、GIT~1 是 .git 的短文件名、冒号是 NTFS 数据流:这些都可能指到 .git
    for (const bad of [".git/config", "../x.mjs", "a/../../x", "C:/x.mjs", "/etc/x", ".GIT/config", ".git./config", ".git /config", ".Git../hooks/x",
      "a/.git/config", "GIT~1/config", "git~2/x", ".git::$INDEX_ALLOCATION/config", "a:b", "...", "x./y", "x /y"]) {
      writeFileSync(join(d, ".export-manifest"), bad + "\n");
      await assert.rejects(exportHelper(d), /清单/, bad);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
  const inside = join(ROOT, "panel", "export-test-should-not-exist");
  await assert.rejects(exportHelper(inside), /源仓库/);
  assert.ok(!existsSync(inside));
});

test("命令行:node tools/export-helper.mjs <目录>;不给目录报用法;没有禁用清单就失败", () => {
  const d = tmp(), d2 = tmp();
  try {
    const r = spawnSync(process.execPath, [TOOL, d, "--allow-dirty"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`${res.files.length} 个文件`));
    assert.ok(existsSync(join(d, ".export-manifest")));
    const u = spawnSync(process.execPath, [TOOL], { encoding: "utf8", timeout: 60_000 });
    assert.notEqual(u.status, 0);
    assert.match(u.stderr, /用法/);
    const env = { ...process.env, TP_EXPORT_FORBIDDEN: join(rulesDir, "nope.json") };
    const m = spawnSync(process.execPath, [TOOL, d2, "--allow-dirty"], { encoding: "utf8", timeout: 60_000, env });
    assert.equal(m.status, 1);
    assert.match(m.stderr, /禁用清单/);
    assert.deepEqual(readdirSync(d2), []);
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(d2, { recursive: true, force: true }); }
});

// 输出目录里有链接(junction / 符号链接)指到 .git 或目录外:清单里的路径看着正常,真正要删的文件却在别处 → 拒绝,什么都不删
test("拒绝:清单里的路径经过链接指到输出目录的 .git 里、或输出目录外面 → 一个都不删", async () => {
  const d = tmp(), outside = tmp();
  try {
    await exportHelper(d, DIRTY_OK);
    const manifest = readFileSync(join(d, ".export-manifest"), "utf8");
    mkdirSync(join(d, ".git"));
    writeFileSync(join(d, ".git/config"), "[core]\n");
    symlinkSync(join(d, ".git"), join(d, "lnk"), "junction");
    writeFileSync(join(d, ".export-manifest"), manifest + "lnk/config\nlnk\n");
    await assert.rejects(exportHelper(d, DIRTY_OK), /\.git/);
    assert.equal(readFileSync(join(d, ".git/config"), "utf8"), "[core]\n", ".git 里的文件没被删");
    // 指到输出目录外面
    unlinkSync(join(d, "lnk"));
    writeFileSync(join(outside, "victim.txt"), "keep");
    symlinkSync(outside, join(d, "ext"), "junction");
    writeFileSync(join(d, ".export-manifest"), manifest + "ext/victim.txt\next\n");
    await assert.rejects(exportHelper(d, DIRTY_OK), /输出目录外面/);
    assert.equal(readFileSync(join(outside, "victim.txt"), "utf8"), "keep", "目录外的文件没被删");
    assert.ok(existsSync(join(d, "accounts.mjs")), "拒绝时输出目录也没动");
  } finally {
    for (const l of ["lnk", "ext"]) try { unlinkSync(join(d, l)); } catch {}
    rmSync(d, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── 要导出的文件和 HEAD 不一样(还没提交)就拒绝,除非 --allow-dirty / allowDirty ──
// 用源仓库的克隆(--shared:不复制对象,很快):克隆出来和 HEAD 一样、是干净的,在克隆里改文件不会碰到源仓库
function cloneRepo() {
  const d = tmp();
  execFileSync("git", ["clone", "-q", "--shared", ROOT, join(d, "repo")]);
  return { dir: d, repo: join(d, "repo") };
}

test("没提交的改动:要导出的文件(或生成它们用的源文件)和 HEAD 不一样 → 拒绝并列出文件;allowDirty 才照导;不导出的文件不管", async () => {
  const c = cloneRepo(), o1 = tmp(), o2 = tmp();
  try {
    const clean = await exportHelper(o1, { root: c.repo });
    assert.deepEqual(clean.files, res.files, "干净的克隆照常导出");
    appendFileSync(join(c.repo, "accounts.mjs"), "\n// 还没提交的改动\n");
    appendFileSync(join(c.repo, "README.md"), "\n还没提交\n");   // README.md 是生成助手 README 用的源文件之一
    appendFileSync(join(c.repo, "CHANGELOG.md"), "\n还没提交\n");   // 不导出,不管
    await assert.rejects(exportHelper(o2, { root: c.repo }), (e) =>
      /HEAD/.test(e.message) && /accounts\.mjs/.test(e.message) && /README\.md/.test(e.message) && /--allow-dirty/.test(e.message) && !/CHANGELOG/.test(e.message));
    assert.deepEqual(readdirSync(o2), [], "拒绝时什么都没写");
    // 已经 git add、还没 commit 的也算
    execFileSync("git", ["add", "accounts.mjs", "README.md"], { cwd: c.repo });
    await assert.rejects(exportHelper(o2, { root: c.repo }), /accounts\.mjs/);
    // 明确要导没提交的改动
    await exportHelper(o2, { root: c.repo, allowDirty: true });
    assert.match(readFileSync(join(o2, "accounts.mjs"), "utf8"), /还没提交的改动/);
  } finally { for (const x of [c.dir, o1, o2]) rmSync(x, { recursive: true, force: true }); }
});

test("命令行 --allow-dirty:不加 → 没提交的改动就失败(列出文件);加了(放在目录前后都行)→ 照导;不认识的选项报用法", () => {
  const c = cloneRepo(), o = tmp(), o2 = tmp();
  try {
    const tool = join(c.repo, "tools/export-helper.mjs");
    copyFileSync(TOOL, tool);   // 用现在这一版的导出工具(克隆里是 HEAD 的那一版)
    appendFileSync(join(c.repo, "accounts.mjs"), "\n// 还没提交的改动\n");
    const no = spawnSync(process.execPath, [tool, o], { encoding: "utf8", timeout: 60_000 });
    assert.equal(no.status, 1, no.stdout);
    assert.match(no.stderr, /accounts\.mjs/);
    assert.match(no.stderr, /--allow-dirty/);
    assert.deepEqual(readdirSync(o), []);
    const yes = spawnSync(process.execPath, [tool, o, "--allow-dirty"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(yes.status, 0, yes.stderr);
    const first = spawnSync(process.execPath, [tool, "--allow-dirty", o2], { encoding: "utf8", timeout: 60_000 });
    assert.equal(first.status, 0, first.stderr);
    const bad = spawnSync(process.execPath, [tool, o2, "--force"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /用法/);
  } finally { for (const x of [c.dir, o, o2]) rmSync(x, { recursive: true, force: true }); }
});

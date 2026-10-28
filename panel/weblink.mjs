// 网页 ⇄ 本地小助手:配对与令牌存储。
// 流程:网页(官方网址)请求配对 → 本机弹出 6 位配对码 → 用户把码输进网页 → 网页拿到令牌,之后带令牌调本机接口。
// 第一部分:「配对码 + 令牌」本身(含防爆破)。第二部分:网页能调哪些接口(白名单)、登录限制、下单限额与每日账本、
//   网页下单的滑点 / 上限决定(webOrderPlan)、网页下单记录。
// 第三部分:HTTP 请求闸门 webGate(Host / Origin / 跨域头 / 配对接口 / 令牌 / 白名单),server.mjs 在请求处理最前面调它。
// 第四部分:网页请求转账 / 改设置 / 开真实跟单等,要本机助手批准(需批准的判断、批准文案、批准队列、断开配对时作废、
//   批准前后核对配对还在 / 网页断开就撤掉、事件流可见范围)。
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dataFile } from "./datadir.mjs";
import { cleanParams } from "./copyparams.mjs";

// 允许发起配对 / 调用的网页来源(逗号分隔;默认只认官方网址)
export const WEB_ORIGINS = new Set(
  String(process.env.AGENTBUY_WEB_ORIGINS || "https://tigerpower.online")
    .split(/[\s,]+/)
    .map((s) => s.replace(/\/+$/, ""))
    .filter(Boolean),
);
export const isWebOrigin = (origin) => typeof origin === "string" && WEB_ORIGINS.has(origin);

const PAIR_TTL_MS = 120_000;
const MAX_TRIES = 5;
const TOUCH_SAVE_MS = 60_000; // lastUsed 写盘最少隔这么久
const LABEL_MAX = 60;

const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");
const sameStr = (a, b) => { // 按字节比长度:UTF-16 等长的非 ASCII 串字节数可能不同,timingSafeEqual 会抛 RangeError
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
};
const view = ({ id, origin, label, createdAt, lastUsed }) => ({ id, origin, label, createdAt, lastUsed });

// ── 待配对状态:只放内存,重启即作废 ──
let pending = null; // { code, origin, until, tries }

// ── 防爆破:一轮只能试 5 次,但重新开始配对就是新的一轮,不限的话几分钟就能把 100 万个码试一遍 ──
//   10 分钟内失败 3 轮(过期 / 试太多次作废 / 被新的一轮顶掉,都算没配成)或错码 10 次 → 15 分钟内不接受新的配对(进行中的这一轮也作废);
//   两次开始配对至少隔 10 秒。配对成功一次,失败计数清零。只放内存:重启也就清零了(重启要用户在本机操作)
const PAIR_WINDOW_MS = 600_000, PAIR_LOCK_MS = 900_000, PAIR_GAP_MS = 10_000;
const MAX_FAILED_ROUNDS = 3, MAX_WRONG_CODES = 10;
const LOCK_MSG = "配对尝试太多,请 15 分钟后再试";
const GAP_MSG = "配对太频繁,稍等几秒";
const pairGuard = { lastStart: -Infinity, lockedUntil: 0, rounds: [], wrong: [] }; // rounds / wrong:最近失败的时间点
const tooMany = (msg) => Object.assign(new Error(msg), { status: 429 }); // 带 status 的是业务拒绝(webGate 原样回给网页),不是系统错误

// 记一次失败(kind = "round" 失败轮 | "wrong" 错码,at = 发生的时间);凑够了就锁 15 分钟,返回 true
function pairFailed(kind, at, now) {
  (kind === "round" ? pairGuard.rounds : pairGuard.wrong).push(at);
  const cut = now - PAIR_WINDOW_MS;
  pairGuard.rounds = pairGuard.rounds.filter((t) => t > cut);
  pairGuard.wrong = pairGuard.wrong.filter((t) => t > cut);
  if (pairGuard.rounds.length < MAX_FAILED_ROUNDS && pairGuard.wrong.length < MAX_WRONG_CODES) return false;
  console.warn(`[网页连接] 配对失败太多(10 分钟内没配成 ${pairGuard.rounds.length} 轮、错码 ${pairGuard.wrong.length} 次),15 分钟内不接受新的配对`);
  pairGuard.lockedUntil = now + PAIR_LOCK_MS;
  pairGuard.rounds = []; pairGuard.wrong = [];
  pending = null;
  return true;
}
// 进行中的这一轮没配成就结束了:算一次失败轮(过期的按过期那一刻算)
function endRound(now) {
  if (!pending) return false;
  const at = Math.min(now, pending.until);
  pending = null;
  return pairFailed("round", at, now);
}

export function startPair(origin, now = Date.now()) {
  if (now < pairGuard.lockedUntil) throw tooMany(LOCK_MSG);
  const gap = now - pairGuard.lastStart;
  if (gap >= 0 && gap < PAIR_GAP_MS) throw tooMany(GAP_MSG); // 被拒的这一下不算「开始」,不顺延
  if (endRound(now)) throw tooMany(LOCK_MSG); // 上一轮还没配成就被顶掉 / 已经过期:记失败,这一下凑够了就锁
  pairGuard.lastStart = now;
  pending = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), origin, until: now + PAIR_TTL_MS, tries: 0 };
  return { expiresIn: PAIR_TTL_MS / 1000 };
}

export function pendingPair(now = Date.now()) {
  if (!pending || now > pending.until) return null;
  return { code: pending.code, origin: pending.origin, expiresIn: Math.max(0, Math.ceil((pending.until - now) / 1000)) };
}

// 抛出的错误带 status = 429 的是「试太多」,其余是 400(都是给网页看的业务消息)
export function finishPair(origin, code, label, now = Date.now()) {
  if (pending && now > pending.until) endRound(now);
  if (!pending || pending.origin !== origin) throw new Error("没有进行中的配对或已过期");
  if (++pending.tries > MAX_TRIES) throw tooMany(endRound(now) ? LOCK_MSG : "试太多次,重新开始配对");
  if (!sameStr(String(code ?? ""), pending.code)) {
    if (pairFailed("wrong", now, now)) throw tooMany(LOCK_MSG);
    throw new Error("配对码不对");
  }
  pending = null;
  pairGuard.rounds = []; pairGuard.wrong = []; // 配对成功:失败计数清零
  const token = randomBytes(32).toString("base64url");
  const id = randomBytes(8).toString("hex");
  load().pairs.push({
    id, hash: sha256hex(token), origin,
    label: String(label ?? "").trim().slice(0, LABEL_MAX) || "浏览器",
    createdAt: now, lastUsed: now,
  });
  save(now);
  return { token, id };
}

// ── 令牌存储:web-pairs.json = { pairs: [{ id, hash, origin, label, createdAt, lastUsed }] },磁盘上只有令牌的 sha256 ──
let db = null;
let lastSavedAt = 0;

function load() {
  if (db) return db;
  db = { pairs: [] };
  try {
    const j = JSON.parse(readFileSync(dataFile("web-pairs.json"), "utf8"));
    if (Array.isArray(j?.pairs)) db.pairs = j.pairs;
  } catch { /* 没有文件或文件坏了 → 当作还没配对过 */ }
  return db;
}

function save(now = Date.now(), data = db) {
  const file = dataFile("web-pairs.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  lastSavedAt = now;
}

export function verifyToken(origin, token, now = Date.now()) {
  if (typeof token !== "string" || !token) return null;
  const h = sha256hex(token);
  let hit = null;
  for (const p of load().pairs) { // 不提前退出:耗时不随命中位置变化
    if (typeof p?.hash === "string" && sameStr(p.hash, h)) hit = p;
  }
  if (!hit || hit.origin !== origin) return null;
  hit.lastUsed = now;
  if (now - lastSavedAt >= TOUCH_SAVE_MS) {
    // 只是记「上次使用」:写不进去也照常放行,别让每个请求都报错;隔 60 秒再试,日志也不刷屏
    try { save(now); } catch (e) { lastSavedAt = now; console.error("[网页连接] 记录令牌使用时间写盘失败:", e?.message ?? e); }
  }
  return view(hit);
}

export const listPairs = () => load().pairs.map(view);

export function revokePair(id) {
  const pairs = load().pairs;
  const i = pairs.findIndex((p) => p.id === id);
  if (i < 0) return false;
  const next = pairs.filter((_, j) => j !== i);
  save(Date.now(), { ...db, pairs: next }); // 先写盘:写不进去就抛错,内存里也还没撤销(不会出现「看着断开了,重启又连上」)
  db.pairs = next;
  return true;
}

// ════════ 第二部分:网页能做什么 ════════

// ── 接口白名单:带网页令牌的请求只能调这里列出的接口;精确匹配路径(先去掉 ?查询串 / #片段) ──
const LOCAL_ONLY_MSG = "这个操作只能在本机助手页面里做(http://127.0.0.1:4400)";
const WEB_GET = new Set(["/api/stream", "/api/live-status", "/api/update-status", "/health"]);
const WEB_POST = new Set([
  "/api/scan", "/api/trades", "/api/prefetch", "/api/inspect", "/api/history", "/api/notes", "/api/ticker",
  "/api/tradespage", "/api/trader", "/api/lists", "/api/lists/op", "/api/settings", "/api/autotransfer",
  "/api/approvals", "/api/approvals/revoke", "/api/quote", "/api/quote-balances", "/api/latency-stats",
  "/api/wallets", "/api/run", "/api/login/status", "/api/login/logout", "/api/tip-info",
  "/api/cache-status", "/api/track", "/api/track/add", "/api/track/update", "/api/track/remove",
  "/api/track/group", "/api/track/backfill", "/api/track/feed", "/api/copy", "/api/copy/pause-all",
  "/api/copy/tasks",
  // API 2:钱包相关的操作网页也能请求,但转账 / 打赏 / 改设置 / 自动转出 / 解除地址锁定 / 改限额要本机先批准(第四部分的 approvalKind,由 server.mjs 在执行前拦)
  "/api/send", "/api/tip", "/api/settings/set", "/api/autotransfer/target", "/api/autotransfer/set", "/api/autotransfer/appconfirm",
  "/api/login/unpin", "/api/login/request", "/api/mine", "/api/link/state", "/api/link/revoke", "/api/link/limits",
]);
// 只能在本机做的:不分 GET 还是 POST,网页一律不行
//   登录:网页永远不能直接发起钱包登录(/api/login/start)—— 不然被篡改的网页能让你扫它生成的码,把别人的钱包登进你的槽位;
//     网页只能 /api/login/request 请本机助手去发起,二维码只在本机面板显示;查登录状态 / 退出还是能用
//   配对码、批准列表和批准决定:批准只能由本机的人点,网页自己批准自己就没有意义了
//   /api/link/* 里除了 WEB_POST 列出的(查状态 / 撤销配对 / 改限额,其中改限额要批准),其余也只能本机
const LOCAL_ONLY = new Set(["/api/login/start", "/api/link/pending", "/api/approve/pending", "/api/approve/decide"]);

export function webPolicy(method, path) {
  const m = String(method ?? "").toUpperCase();
  const p = String(path ?? "").split(/[?#]/, 1)[0];
  if (LOCAL_ONLY.has(p) || (p.startsWith("/api/link/") && !WEB_POST.has(p))) return { ok: false, status: 403, error: LOCAL_ONLY_MSG };
  if ((m === "GET" && WEB_GET.has(p)) || (m === "POST" && WEB_POST.has(p))) return { ok: true };
  return { ok: false, status: 404, error: "没有这个接口" };
}

// ── 跟单:网页建 / 改「模拟」任务不用批准;开真实下单、把真实任务再改一遍、恢复被暂停的跟单,都要本机批准 ──
// 跟单引擎只认 body.params.dryRun(copy.mjs 的 cleanParams,且用 !! 转布尔:0 / null / "" 都等于真实下单),
// 顶层 body.dryRun 它根本不读;所以两层都要写成一致。返回 { body, approve }:
//   真实(approve: true)= params 里带了 dryRun 这个键 → 看它是不是假值;没带 → 顶层 dryRun === false 算真实;再没有 → 看同 id 的已有任务是不是真实的;
//   真实时两层都写 false(批准后照这个执行),否则两层都写死 true(今天的行为)。不抛错;调用方在 approve 为 true 时去走批准,批准通过才执行返回的 body
//   例外:已有的真实任务只暂停 / 关闭 / 删除(收紧的操作)不用批准,body 原样往下传(只有 id / status / delete,不写 dryRun:任务还是原来的真实任务)
const STOP_STATUS = new Set(["paused", "closed"]);
// body 只有 id + status(paused / closed)和 / 或 delete: true,别的键一个都没有(带 params / name / dryRun 都不算)
function onlyStops(b) {
  if (b.id == null || !Object.keys(b).every((k) => k === "id" || k === "status" || k === "delete")) return false;
  if (b.status === undefined && b.delete === undefined) return false;
  return (b.status === undefined || STOP_STATUS.has(b.status)) && (b.delete === undefined || b.delete === true);
}
export function webCopyTaskPolicy(body, tasks) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const params = b.params && typeof b.params === "object" && !Array.isArray(b.params) ? b.params : {};
  const old = b.id == null || !Array.isArray(tasks) ? null : tasks.find((t) => t?.id === b.id);
  let real;
  if (Object.hasOwn(params, "dryRun")) real = !params.dryRun;
  else if (b.dryRun === false) real = true;
  else real = old ? !old.params?.dryRun : false; // 和引擎同一个口径:params.dryRun 不是真值就是真实下单
  if (real && old && onlyStops(b)) return { body: { ...b }, approve: false };
  return { body: { ...b, dryRun: !real, params: { ...params, dryRun: !real } }, approve: real };
}

// ── 网页建 / 改跟单任务的全部决定(纯函数:任务列表由调用方传进来,不读写磁盘)。server.mjs 的 /api/copy/tasks 收到网页请求时调它 ──
// 返回 { approve, execBody, card, print }:
//   approve:要不要本机批准(webCopyTaskPolicy 的判断)。不要批准时 execBody 就是 webCopyTaskPolicy 改写过 dryRun 的 body,card / print 是 null
//   要批准时:card = 批准框照着写的 { target, name, params },params 是 cleanParams 规整过的完整一份(真实下单);
//     execBody = 批准后交给 copyTask 的 body,带完整的 params 和 name(改已有任务还带 id、status):copyTask 落地的就是批准框里那一份,
//       不会合到「等批准的这段时间里被模拟修改改过」的参数上(否则批准框写单笔 0.05,落地的却是网页趁机改成的 0.5);
//     print = 改已有任务时这个任务当时的指纹(copyTaskPrint),批准后 checkCopyTaskUnchanged 再比一次,变了就不执行;新建是 null
//   进批准队列之前就能看出不对的(任务不存在、状态不对、已关闭的要重新启动、参数不对)直接抛错,不弹批准框
// trackOf(小写地址) → 追踪名单里这个地址的 { name, handle }(新建没起名时用;可省)
export function webCopyTaskPlan(body, tasks, { trackOf } = {}) {
  const pol = webCopyTaskPolicy(body, tasks);
  if (!pol.approve) return { approve: false, execBody: pol.body, card: null, print: null };
  const b = pol.body;
  if (b.target !== undefined && !b.id) {   // 新建(和 copyTask 认新建的口径一样)
    const target = String(b.target).toLowerCase();
    const tk = trackOf?.(target);
    const name = String(b.name ?? "").slice(0, 40) || String(tk?.name || tk?.handle || "").slice(0, 40);
    const params = cleanParams(b.params);
    return { approve: true, execBody: { target, name, dryRun: false, params }, card: { target, name, params }, print: null };
  }
  const old = Array.isArray(tasks) ? tasks.find((t) => t?.id === b.id) : null;
  if (!old) throw new Error("没有这个跟单任务");
  const status = b.status || undefined;   // 和 copyTask 一样:空的不算
  if (status !== undefined) {
    if (!["running", "paused", "closed"].includes(status)) throw new Error("状态不对");
    if (old.status === "closed" && status !== "closed") throw new Error("已关闭的任务不能再启动,新建一个");
  }
  const params = cleanParams(b.params, old.params);
  const name = b.name !== undefined ? String(b.name).slice(0, 40) || old.name : old.name;
  return {
    approve: true,
    execBody: { id: b.id, ...(status !== undefined ? { status } : {}), name, dryRun: false, params },
    card: { target: old.target, name, params },
    print: copyTaskPrint(old),
  };
}

// 跟单任务的指纹:目标 / 状态 / 参数(对象的键排好序,顺序不同算同一个);名称、统计、持仓记录不算
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
export const copyTaskPrint = (t) => JSON.stringify(canon({ target: t?.target ?? null, status: t?.status ?? null, params: t?.params ?? null }));

// 批准之后、执行之前再核对一次(和 copyTask 在同一段同步代码里,中间不能有 await):改已有任务时,任务还在、
//   目标 / 状态 / 参数和弹批准框时一样才放行;不一样(等批准的这段时间被本机或网页改过、暂停 / 关闭了)就抛错,这次批准作废。
//   新建、不用批准的:没有可比的,直接放行
export const COPY_CHANGED_MSG = "这个跟单任务在等批准的时候被改过了,这次批准作废,没有执行;请重新操作";
export function checkCopyTaskUnchanged(plan, tasks) {
  if (!plan?.approve || plan.print == null) return;
  const now = Array.isArray(tasks) ? tasks.find((t) => t?.id === plan.execBody?.id) : null;
  if (!now) throw new Error("没有这个跟单任务");
  if (copyTaskPrint(now) !== plan.print) throw new Error(COPY_CHANGED_MSG);
}

// 暂停不用批准;恢复要批准。server 里是 copyPauseAll(!!b.paused),所以只有明确的真值才算暂停,{} / 0 / null / "" 都等于「恢复」
export function webPausePolicy(body) {
  return { approve: !body?.paused };
}

// ── 限额与每日账本:web-limits.json = { limits: { webMaxBuyBnb, webDailyBnb, webMaxSlip, webMaxSellSlip }, ledger: { day, spent } } ──
//   webMaxSlip 管网页买入的滑点,webMaxSellSlip 管网页卖出的滑点
const LIMIT_DEFAULTS = { webMaxBuyBnb: 0.5, webDailyBnb: 2, webMaxSlip: 25, webMaxSellSlip: 10 };
const LIMIT_RANGES = { webMaxBuyBnb: [0.01, 100], webDailyBnb: [0.01, 1000], webMaxSlip: [1, 50], webMaxSellSlip: [1, 50] };
const inRange = (k, n) => Number.isFinite(n) && n >= LIMIT_RANGES[k][0] && n <= LIMIT_RANGES[k][1];
const toNum = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN);
const round12 = (n) => Math.round(n * 1e12) / 1e12; // 0.1 累加 10 次不会变成 1.0000000000000002
const dayOf = (now) => new Date(now).toLocaleDateString("sv-SE"); // 本机日期 YYYY-MM-DD

let ldb = null;

function loadLimits() {
  if (ldb) return ldb;
  ldb = { limits: { ...LIMIT_DEFAULTS }, ledger: { day: "", spent: 0 } };
  try {
    const j = JSON.parse(readFileSync(dataFile("web-limits.json"), "utf8"));
    for (const k of Object.keys(LIMIT_DEFAULTS)) {
      const n = j?.limits?.[k];
      if (typeof n === "number" && inRange(k, n)) ldb.limits[k] = n; // 越界 / 坏值 → 回到默认(默认是保守的)
    }
    const l = j?.ledger;
    if (typeof l?.day === "string" && Number.isFinite(l.spent) && l.spent >= 0) ldb.ledger = { day: l.day, spent: l.spent };
  } catch { /* 没有文件或文件坏了 → 默认限额、今天还没花 */ }
  return ldb;
}

function saveLimits() {
  const file = dataFile("web-limits.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(ldb, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export const getWebLimits = () => ({ ...loadLimits().limits });

// 校验要改的限额(纯函数,不落地):只留认识的键并转成数字,一项不对就整体抛错。
//   网页改限额要本机批准:批准框照这里返回的数字写("5e1" 显示成 50,和真正生效的一致),批准后原样交给 setWebLimits
export function parseWebLimits(patch) {
  if (patch == null || typeof patch !== "object" || Array.isArray(patch)) throw new Error("限额数值不对");
  const next = {};
  for (const k of Object.keys(LIMIT_DEFAULTS)) {
    if (patch[k] === undefined) continue;
    const n = toNum(patch[k]);
    if (!inRange(k, n)) throw new Error("限额数值不对");
    next[k] = n;
  }
  return next;
}

export function setWebLimits(patch) {
  const next = parseWebLimits(patch); // 先全部校验再落地:一项不对就整体不生效
  Object.assign(loadLimits().limits, next);
  saveLimits();
  return getWebLimits();
}

export function webSpentToday(now = Date.now()) {
  const l = loadLimits().ledger;
  return l.day === dayOf(now) ? round12(l.spent) : 0;
}

// 单笔 + 每日上限(纯函数):bnb = 每个号这一单折合多少 BNB,accounts = 几个号同时买,spent = 今天已用
function capCheck(bnb, accounts, { webMaxBuyBnb, webDailyBnb }, spent) {
  if (typeof bnb !== "number" || !Number.isFinite(bnb) || bnb <= 0) throw new Error("算不出这笔折合多少 BNB,网页下单不能放行");
  if (!Number.isInteger(accounts) || accounts < 1) throw new Error("下单的号数不对"); // 0 / NaN 会让每日上限形同虚设
  if (bnb > webMaxBuyBnb) throw new Error(`超过网页单笔上限 ${webMaxBuyBnb} BNB`);
  if (round12(spent + bnb * accounts) > webDailyBnb) throw new Error(`超过网页每日上限 ${webDailyBnb} BNB(今天已用 ${round12(spent)})`);
}

// bnb = 每个号这一单折合多少 BNB,accounts = 几个号同时买:单笔上限按每个号比,每日上限按 bnb × accounts 算
//   (记账时调用方传合计 recordWebBuy(bnb × accounts))
export function checkWebBuy(bnb, now = Date.now(), accounts = 1) {
  capCheck(bnb, accounts, loadLimits().limits, webSpentToday(now));
}

export function recordWebBuy(bnb, now = Date.now()) {
  if (typeof bnb !== "number" || !Number.isFinite(bnb) || bnb <= 0) throw new Error("记账金额不对");
  const l = loadLimits().ledger;
  const day = dayOf(now);
  if (l.day !== day) { l.day = day; l.spent = 0; } // 换天了:账本从 0 重新开始
  l.spent = round12(l.spent + bnb);
  saveLimits();
}

// 网页传来的滑点(纯函数):空 → undefined(用各平台默认);超过上限直接拒绝,不偷偷改小
function slipCheck(slip, cap, sell) {
  if (slip === undefined || slip === null || slip === "") return undefined;
  const n = toNum(slip);
  if (Number.isNaN(n)) throw new Error("滑点数值不对");
  if (n > cap) throw new Error(sell ? `网页卖出滑点最多 ${cap}%` : `网页下单滑点最多 ${cap}%`);
  return n;
}
// 同上,上限按本机设的:买入看 webMaxSlip,卖出(action = "sell")看 webMaxSellSlip
export function clampWebSlip(slip, action = "buy") {
  const { webMaxSlip, webMaxSellSlip } = loadLimits().limits;
  return action === "sell" ? slipCheck(slip, webMaxSellSlip, true) : slipCheck(slip, webMaxSlip, false);
}

// ── 网页下单的全部决定:滑点上限、单笔 / 每日上限、Gang 按比例买的 --max-bnb、Gang 第一代按比例买拒绝 ──

// 各下单脚本自己的默认滑点(%),键 = 脚本相对 agentbuy 根目录的路径(route() 用到的全部脚本)。
//   网页没选滑点时,只有脚本默认比网页上限高才补 --slip 上限;不在表里的脚本照用它自己的默认(不补),所以表不能漏。
//   ⚠ 改了哪个脚本的 --slip 默认值、或 route() 加了新脚本,这张表要跟着改 —— tests/weblink-order.test.mjs 会读脚本源码核对,对不上就失败
export const SCRIPT_DEFAULT_SLIP = new Map([
  ["fourbuy.mjs", 30], ["foursell.mjs", 30], ["fast.mjs", 30], ["sell.mjs", 30],
  ["dexbuy.mjs", 10], ["dexsell.mjs", 10], ["flapportal.mjs", 10],
  ["gang/gangv1buy.mjs", 1], ["gang/gangbuy.mjs", 1],
  ["gang/gangv1sell.mjs", 5], ["gang/gangv2sell.mjs", 5], ["gang/gangv3.mjs", 5],
]);
// Gang 按比例买(1% / 0.5% / 自定义):花多少 BNB 是脚本按曲线现算的,网页这边只是估价 → 给认 --max-bnb 的脚本加链上前的硬上限
const GANG_MAX_BNB = new Set(["gang/gangbuy.mjs", "gang/gangv3.mjs"]);
const GANG_V1_BUY = "gang/gangv1buy.mjs"; // 不认 --max-bnb:网页按比例买直接拒绝
const isPctArg = (arg) => arg === "1pct" || arg === "half" || /^p\d/.test(String(arg));
const setArg = (args, name, v) => { const i = args.indexOf(name); if (i >= 0) args[i + 1] = String(v); else args.push(name, String(v)); };

// webOrderPlan(纯函数:不读写磁盘,限额和今天已用由调用方传进来)。server.mjs 的 /api/run 在 route() 选好脚本之后、下单之前调用。
// 入参 {
//   action:     "buy" | "sell"
//   arg:        买:"1pct" | "half" | "p0.3"(按比例)或 BNB 数量;卖:百分比
//   slip:       网页选的滑点(undefined / null / "" = 没选)
//   accounts:   几个号同时下(= plans.length)
//   plans:      route() 的结果 [{ a: 账号, script, args, … }](不改入参,返回改过的副本)
//   scriptOf:   plan → 脚本相对 agentbuy 根目录的路径(查 SCRIPT_DEFAULT_SLIP / 认 Gang 脚本;默认直接用 plan.script)
//   bnbEach:    买入时每个号这一单折合多少 BNB(算不出给 null → 拒绝);卖出不看
//   limits:     getWebLimits() 的结果
//   spentToday: webSpentToday(),记这一单之前的
// }
// 返回 { plans, slipLog: { 账号: 实际传的滑点 | "脚本默认" }, charge: 这一单要记账的合计 BNB(卖出 null), maxBnb: 加的 --max-bnb(没加 null) }
// 不放行就抛错(消息给网页看)。规则:
//   滑点:买入上限 webMaxSlip、卖出上限 webMaxSellSlip。网页选了 → 超过上限拒绝,没超过就照它的;
//         没选 → 只往下压不往上抬:已带 --slip 的超过上限压到上限,没带的脚本默认比上限高才补 --slip 上限,其余照用脚本默认
//   买入:单笔上限按每个号比,每日上限按 金额 × 号数 算;Gang 按比例买 → gangbuy / gangv3 加 --max-bnb min(单笔上限, 今天剩下的 ÷ 号数),
//         Gang 第一代按比例买拒绝
// 调用方拿到结果后紧接着 checkWebBuy(bnbEach, …, accounts) + recordWebBuy(charge),中间不能有 await(两单同时来也不会一起超额)
export function webOrderPlan({ action, arg, slip, accounts, plans, scriptOf = (p) => p.script, bnbEach = null, limits, spentToday = 0 } = {}) {
  if (action !== "buy" && action !== "sell") throw new Error("action 不对");
  if (!Number.isInteger(accounts) || accounts < 1 || !Array.isArray(plans) || plans.length !== accounts) throw new Error("下单的号数不对");
  const L = { ...LIMIT_DEFAULTS, ...limits };
  const sell = action === "sell";
  const cap = sell ? L.webMaxSellSlip : L.webMaxSlip;
  const userSlip = slipCheck(slip, cap, sell);
  if (userSlip !== undefined && !(userSlip > 0)) throw new Error("滑点数值不对");
  const out = plans.map((p) => ({ ...p, args: [...p.args] }));
  let charge = null, maxBnb = null;
  if (!sell) {
    const pct = isPctArg(arg);
    if (pct && out.some((p) => scriptOf(p) === GANG_V1_BUY)) throw new Error("Gang 第一代网页上不支持,请在本机面板下单");
    capCheck(bnbEach, accounts, L, spentToday);
    charge = round12(bnbEach * accounts);
    if (pct) {
      // 往下取整到 1e-8:只会更严;单笔上限和今天剩下的都已经验过 ≥ bnbEach > 0
      const m = Math.floor(Math.min(L.webMaxBuyBnb, (L.webDailyBnb - spentToday) / accounts) * 1e8) / 1e8;
      for (const p of out) {
        if (!GANG_MAX_BNB.has(scriptOf(p))) continue;
        const i = p.args.indexOf("--max-bnb");
        setArg(p.args, "--max-bnb", i >= 0 && Number(p.args[i + 1]) <= m ? p.args[i + 1] : m); // 已经带了更小的就留着
        maxBnb = m;
      }
    }
  }
  for (const p of out) {
    const i = p.args.indexOf("--slip");
    if (userSlip !== undefined) setArg(p.args, "--slip", userSlip);
    else if (i >= 0) { if (!(Number(p.args[i + 1]) <= cap)) p.args[i + 1] = String(cap); }
    else if ((SCRIPT_DEFAULT_SLIP.get(scriptOf(p)) ?? 0) > cap) p.args.push("--slip", String(cap));
  }
  const slipLog = Object.fromEntries(out.map((p) => { const i = p.args.indexOf("--slip"); return [p.a, i >= 0 ? Number(p.args[i + 1]) : "脚本默认"]; }));
  return { plans: out, slipLog, charge, maxBnb };
}

// 发给网页的状态里的出错信息(实时连接 / 缓存的 lastError 等):去掉网址(RPC / 数据库地址里常带 key、账号密码)和 key=… 之类的凭据
//   (同 public-server.mjs 的 scrub;本机页面照旧看完整的)
export const webScrub = (s) => (s == null ? s : String(s)
  .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'\\]+/gi, "<节点>")
  .replace(/\b(api[-_]?key|access[-_]?token|token|secret|password|passwd|pwd)\s*[=:]\s*[^\s&"',;]+/gi, "$1=***"));

// ── 网页下单记录:web-orders.jsonl,一行一单,只追加 ──
export function logWebOrder(entry, now = Date.now()) {
  appendFileSync(dataFile("web-orders.jsonl"), `${JSON.stringify({ ...entry, at: now })}\n`, { mode: 0o600 });
}

export function recentWebOrders(n = 30) {
  const count = Math.floor(Number(n));
  if (!(count > 0)) return [];
  let text;
  try { text = readFileSync(dataFile("web-orders.jsonl"), "utf8"); } catch { return []; }
  const out = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < count; i--) { // 从文件尾往前取,新的在前
    if (!lines[i].trim()) continue;
    try { out.push(JSON.parse(lines[i])); } catch { /* 写到一半的坏行跳过 */ }
  }
  return out;
}

// ════════ 第三部分:HTTP 请求闸门 ════════

// 网站要求的最低助手接口版本号:助手的接口有不兼容改动时加 1(/link/hello 会报给网页,网页发现太旧就提示更新)
// 2:转账 / 打赏 / 改设置 / 自动转出 / 解除地址锁定 / 改限额 / 真实跟单网页也能请求(要本机批准),/link/hello 多报 kind
export const HELPER_API = 2;

export const UNPAIRED_MSG = "没配对或已断开,请重新连接本机助手";
const BODY_MAX = 4096;

function gateSend(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

// 只给配对接口读请求体;读完整个流(超长的丢掉不存)再报错,这样 400 能正常发回去
async function readJsonBody(req) {
  let n = 0;
  const chunks = [];
  for await (const c of req) { n += c.length; if (n <= BODY_MAX) chunks.push(c); }
  if (n > BODY_MAX) throw new Error("请求太大");
  try {
    const j = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { throw new Error("请求格式不对"); }
}

const bearerOf = (req) => /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? "").trim())?.[1] ?? "";
// EventSource 设不了请求头,/api/stream 另外认查询参数 t
const streamTokenOf = (url) => {
  const q = url.indexOf("?");
  return q < 0 ? "" : new URLSearchParams(url.slice(q + 1).split("#", 1)[0]).get("t") ?? "";
};

// 请求闸门。返回:
//   { handled: true }  已经回过响应(421 / 403 / 预检 / 配对 / 401 / 白名单拒绝 …),调用方什么都别再做
//   { web: false }     不是网页发来的(没有 Origin,或 Origin 就是本机自己):响应原封不动,交回原来的 guard
//   { web: true, origin, pair }  官方网页 + 令牌有效 + 接口在白名单里:只多了 CORS 响应头,调用方照常处理业务(并跳过面板自己的 x-panel-token 校验)
// now:时钟(默认 Date.now;测试夹具换成能拨的,好测配对的间隔和锁定)
// 路径一律按原始 req.url 去掉 ?查询串 / #片段 来比,不做 URL 规范化(和 server.mjs 里 req.url === "…" 的路由对法一致,/a/../b、//a 之类只会 404)。
// kind:这个助手是哪一种(默认 "full" = 完整的本机面板;/link/hello 报给网页)
export async function webGate(req, res, { port, build, api = HELPER_API, onPairStart, now = Date.now, kind = "full" } = {}) {
  try {
    // 1. Host:挡 DNS 重绑定(别的域名解析到 127.0.0.1 的情形)
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { gateSend(res, 421, { error: "Host 不允许" }); return { handled: true }; }
    // 2. 没有 Origin(本机直接打开 / curl)或同源:不归这里管
    const origin = req.headers.origin;
    if (!origin || origin === `http://${host}`) return { web: false };
    // 3. 其它来源只认白名单(默认只有官方网址);不在名单的连跨域头都不给,网页读不到响应
    if (!isWebOrigin(origin)) { gateSend(res, 403, { error: "来源不允许" }); return { handled: true }; }
    // 4. 从这里起所有响应都带 CORS 头(401 / 403 也要带,否则网页看不到原因)
    res.setHeader("Access-Control-Allow-Origin", origin);
    const vary = res.getHeader("vary");
    res.setHeader("Vary", vary ? `${vary}, Origin` : "Origin");
    // 5. 预检(含 Chrome 的 Private Network Access)
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type, authorization, x-panel-token",
        "access-control-max-age": "600",
        "access-control-allow-private-network": "true",
      });
      res.end();
      return { handled: true };
    }
    const path = String(req.url ?? "").split(/[?#]/, 1)[0];
    // 6. 探测:不用令牌。网页靠它判断助手在不在、版本够不够、这个浏览器配过对没有
    if (req.method === "GET" && path === "/link/hello") {
      gateSend(res, 200, { app: "tigerpower-helper", api, build, kind, paired: verifyToken(origin, bearerOf(req), now()) !== null });
      return { handled: true };
    }
    // 7. 开始配对:来源已在第 3 步验过;配对码交给调用方去本机弹出来(不回给网页)。太频繁 / 失败太多被锁 → 429
    if (req.method === "POST" && path === "/link/pair/start") {
      let expiresIn;
      try { ({ expiresIn } = startPair(origin, now())); } catch (e) {
        if (!e?.status) throw e;
        gateSend(res, e.status, { error: e.message });
        return { handled: true };
      }
      try { onPairStart?.(pendingPair(now()).code, origin); } catch (e) { console.error("[weblink] onPairStart 出错:", e?.message ?? e); }
      gateSend(res, 200, { ok: true, expiresIn });
      return { handled: true };
    }
    // 8. 完成配对:网页把用户在本机看到的码交回来,换令牌
    if (req.method === "POST" && path === "/link/pair/finish") {
      let b;
      try { b = await readJsonBody(req); } catch (e) { gateSend(res, 400, { error: e.message }); return { handled: true }; }
      try {
        const { token, id } = finishPair(origin, b.code, b.label, now());
        gateSend(res, 200, { token, id });
      } catch (e) {
        if (e?.code) throw e; // 写盘失败之类的系统错误:不把本机路径之类的细节发给网页,走外面的 500
        gateSend(res, e?.status ?? 400, { error: e.message }); // 试太多次 / 被锁 → 429,其余 400
      }
      return { handled: true };
    }
    // 9. 其余接口都要令牌(令牌绑定配对时的来源)
    const token = bearerOf(req) || (req.method === "GET" && path === "/api/stream" ? streamTokenOf(req.url) : "");
    const pair = verifyToken(origin, token, now());
    if (!pair) { gateSend(res, 401, { error: UNPAIRED_MSG }); return { handled: true }; }
    // 10. 白名单
    const pol = webPolicy(req.method, path);
    if (!pol.ok) { gateSend(res, pol.status, { error: pol.error }); return { handled: true }; }
    // 11. 放行:交回调用方处理业务
    return { web: true, origin, pair };
  } catch (e) {
    console.error("[weblink] 请求闸门出错:", e?.message ?? e);
    if (!res.headersSent) gateSend(res, 500, { error: "本机助手出错了" }); else res.end();
    return { handled: true };
  }
}

// ════════ 第四部分:网页请求要本机批准 ════════
// 网页可以请求转账 / 打赏 / 改设置 / 自动转出 / 解除地址锁定 / 改网页限额 / 开真实跟单 / 恢复跟单,但要本机助手页面点「批准」才会真的执行:
//   approvalKind / webCopyTaskPolicy / webPausePolicy 按「路径 + 请求体」判断要不要批准(在服务器端判断,旧版网页也绕不过去);
//   describeApproval 把验过的参数写成给人看的文字(页面一律用 textContent 渲染,不拼 HTML);
//   requestApproval 把请求放进队列等本机点批准 / 拒绝,120 秒没人理当作拒绝。队列只放内存,重启即清空。
//   webApproval 是网页请求走的入口(server.mjs 和测试夹具共用):进队列前、批准后都核对配对还在;网页断开(signal)就撤掉这一条。
// 本机页面(没有 Origin / 同源,req.web 没设)发的请求不走这里,照旧直接执行。

// 哪些「路径 + 请求体」要批准(null = 不用)。自动转出的两个开关只有「开」要批准,「关」随时可以;on 必须严格 === true,和 server.mjs 里 on === true 同一个口径
const APPROVAL_BY_PATH = new Map([
  ["/api/send", "send"], ["/api/tip", "tip"], ["/api/settings/set", "settings"], ["/api/autotransfer/target", "at-target"],
  ["/api/login/unpin", "unpin"], ["/api/link/limits", "limits"],
]);
export function approvalKind(path, body) {
  const p = String(path ?? "").split(/[?#]/, 1)[0];
  if (APPROVAL_BY_PATH.has(p)) return APPROVAL_BY_PATH.get(p);
  const on = body?.on === true;
  if (p === "/api/autotransfer/appconfirm") return on ? "at-appconfirm" : null;
  if (p === "/api/autotransfer/set") return on ? "at-on" : null;
  return null;
}

// ── 批准文案 ──
const APPROVAL_TITLES = {
  send: "转账", tip: "打赏作者", settings: "改设置", "at-target": "改自动转出地址",
  "at-appconfirm": "允许中风险转出去 App 确认", "at-on": "开启发射后自动转出", unpin: "解除账号地址锁定",
  limits: "改网页下单限额", "copy-real": "开启真实跟单", "copy-resume": "恢复全部跟单",
};
const LIMIT_NAMES = { webMaxBuyBnb: "网页单笔买入上限(BNB)", webDailyBnb: "网页每日买入上限(BNB)", webMaxSlip: "网页买入滑点上限(%)", webMaxSellSlip: "网页卖出滑点上限(%)" };
const LINE_MAX = 200;
const SHOW = (v) => (v == null ? "?" : String(v)); // 缺的值显示 ?,别显示成 undefined
// 每行最长 200 字;控制字符 / 换行 / 方向控制符换成空格,免得一个值里夹带换行冒充另一行(尤其是下面的 ⚠ 提醒)
const clipLine = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ").slice(0, LINE_MAX);
const lc = (s) => String(s ?? "").trim().toLowerCase();
// 收款地址是谁的:自己的账号 → 自己设的自动转出地址 → 都不是就警告(地址大小写不分,空地址不会匹配上空的)
function whoIs(addr, ctx) {
  const a = lc(addr);
  if (a) {
    for (const [n, v] of Object.entries(ctx.own ?? {})) if (lc(v) === a) return `这是你的账号 ${n} 的地址`;
    if (lc(ctx.atTarget) === a) return "这是你设的自动转出地址";
  }
  return "⚠ 这个地址不是你的账号,也不是自动转出地址";
}
const maxBuyShow = (v) => (v === undefined ? "?" : Number(v) === 0 ? "不限" : String(v)); // 0 = 不限(extras.mjs 的 maxBuyBnb)
const onOffShow = (v) => (v === undefined ? "?" : v === true ? "开" : "关");
// 转账 / 打赏的附加选项(server.mjs 里也是严格 === true 才加 --app-confirm / --dry)
function sendExtras(q, lines) {
  if (q.appConfirm === true) lines.push("风险提示时提交到币安 App 确认");
  if (q.dry === true) lines.push("只模拟,不会真的转出");
}

// kind = approvalKind 的结果,或 "copy-real" / "copy-resume";p = 已经验过的参数(就是马上要执行的那一份,数字已经转好);
//   send:{ acct, token, amount, to, appConfirm?, dry? };tip:{ acct, amount, memo?, appConfirm?, dry? }
// ctx = { own: { "1"?: 地址, "2"?: 地址 }, atTarget: 地址 | null, limits, settings, copyDefaults }。返回 { title, lines }
export function describeApproval(kind, p, ctx) {
  if (!Object.hasOwn(APPROVAL_TITLES, kind)) throw new Error("未知的批准类型");
  const q = p && typeof p === "object" ? p : {};
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const lines = [];
  switch (kind) {
    case "send":
      lines.push(`从账号 ${SHOW(q.acct)} 转出`, `数量:${String(q.amount) === "max" ? "全部" : SHOW(q.amount)} ${SHOW(q.token)}`, `收款地址:${SHOW(q.to)}`, whoIs(q.to, c));
      sendExtras(q, lines);
      break;
    case "tip":
      lines.push(`账号 ${SHOW(q.acct)} 打赏作者 ${SHOW(q.amount)} BNB`);
      if (q.memo != null && String(q.memo) !== "") lines.push(`留言:${String(q.memo)}`);
      sendExtras(q, lines);
      break;
    case "settings": {
      const st = c.settings && typeof c.settings === "object" ? c.settings : {};
      if (q.maxBuyBnb !== undefined) lines.push(`单笔买入上限(BNB):${maxBuyShow(st.maxBuyBnb)} → ${maxBuyShow(q.maxBuyBnb)}`);
      if (q.autoClaim !== undefined) lines.push(`Flap 内盘开盘后自动领取:${onOffShow(st.autoClaim)} → ${onOffShow(q.autoClaim)}`);
      if (!lines.length) lines.push("没有要改的项");
      break;
    }
    case "at-target": {
      const to = String(q.to ?? "").trim();
      if (!to) lines.push("清空自动转出地址");
      else lines.push(`新的自动转出地址:${to}`, whoIs(to, c));
      break;
    }
    case "at-appconfirm":
      lines.push("开启后,币安判为「中风险」的自动转出也会提交", "提交后要你去 Binance App 里确认才会转出");
      break;
    case "at-on":
      lines.push(`代币:${SHOW(q.ca)}`, c.atTarget ? `发射后自动转到:${c.atTarget}` : "⚠ 还没设自动转出地址");
      break;
    case "unpin":
      lines.push(`账号 ${SHOW(q.acct)} 的地址锁定会解除`, "之后这个账号可以登录另一个钱包");
      break;
    case "limits": {
      const lim = c.limits && typeof c.limits === "object" ? c.limits : {};
      for (const k of Object.keys(LIMIT_NAMES)) if (q[k] !== undefined) lines.push(`${LIMIT_NAMES[k]}:${SHOW(lim[k])} → ${SHOW(q[k])}`);
      if (!lines.length) lines.push("没有要改的项");
      break;
    }
    case "copy-real": {
      const pr = q.params && typeof q.params === "object" ? q.params : {};
      const d = c.copyDefaults && typeof c.copyDefaults === "object" ? c.copyDefaults : {};
      lines.push(`跟单对象:${SHOW(q.target)}`);
      if (q.name != null && String(q.name) !== "") lines.push(`名称:${String(q.name)}`);
      lines.push(`单笔上限:${SHOW(pr.maxPerTrade ?? d.maxPerTrade)} BNB(每个钱包)`, `每日合计上限:${SHOW(pr.dailyCap ?? d.dailyCap)} BNB`, "开启后会用钱包里的真钱自动下单,不是模拟");
      break;
    }
    case "copy-resume":
      // server 里是 copyPauseAll(false):只解除全局暂停,任务自己的状态不变 —— 自己是「暂停」的任务还是暂停
      lines.push("解除全部暂停:状态是运行中的真实跟单任务会接着自动下单", "用的是钱包里的真钱;状态是暂停的任务还是暂停,不会启动");
      break;
  }
  return { title: APPROVAL_TITLES[kind], lines: lines.map(clipLine) };
}

// ── 批准队列:每条请求自带一个 120 秒的定时器(unref,不拖住进程退出),处理或超时就从队列里拿掉 ──
const APPROVAL_TIMEOUT_MS = 120_000;
const APPROVAL_MAX_PER_PAIR = 3; // 同一个配对最多同时等 3 条:网页刷屏式请求塞不满本机页面
const MAX_TIMER_MS = 2 ** 31 - 1;
const approvalQueue = new Map(); // id → { id, kind, title, lines, origin, pairId, at, expiresAt, resolve, timer, off }(off:取消对 signal 的监听)
const approvalSubs = new Set();

export const pendingApprovals = () => [...approvalQueue.values()].map(({ id, kind, title, lines, origin, at, expiresAt }) => ({ id, kind, title, lines: [...lines], origin, at, expiresAt }));

// 订阅队列变化(新增 / 处理 / 超时),回调拿到当时的待批列表;返回取消订阅的函数。某个订阅者出错不影响队列和别的订阅者
export function onApprovalChange(cb) {
  approvalSubs.add(cb);
  return () => { approvalSubs.delete(cb); };
}
function approvalChanged() {
  for (const cb of [...approvalSubs]) {
    try { cb(pendingApprovals()); } catch (e) { console.error("[网页连接] 批准队列订阅者出错:", e?.message ?? e); }
  }
}

// 放进队列等本机批准:resolve(true) = 批准,resolve(false) = 拒绝或超时。同一个配对已经有 3 条在等 → 同步抛 429(不是返回被拒的 Promise)
//   signal(可省):中止了(网页关了 / 刷新了,见 clientGoneSignal)→ 这一条马上当作拒绝、拿出队列、通知一次,不再占名额;
//   拿到时就已经中止 → 不进队列,直接当作拒绝
export function requestApproval({ kind, title, lines, origin, pairId } = {}, { timeoutMs = APPROVAL_TIMEOUT_MS, now = Date.now, signal } = {}) {
  if (signal?.aborted) return Promise.resolve(false);
  let waiting = 0;
  for (const a of approvalQueue.values()) if (a.pairId === pairId) waiting++;
  if (waiting >= APPROVAL_MAX_PER_PAIR) throw tooMany("等待批准的请求太多,先在本机助手页面处理");
  const id = randomBytes(6).toString("hex");
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMER_MS) : APPROVAL_TIMEOUT_MS;
  const at = now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => decideApproval(id, false), ms);
    timer.unref?.();
    const onAbort = () => decideApproval(id, false);
    signal?.addEventListener("abort", onAbort, { once: true });
    const off = () => signal?.removeEventListener("abort", onAbort);
    approvalQueue.set(id, { id, kind, title, lines: Array.isArray(lines) ? lines.map(String) : [], origin, pairId, at, expiresAt: at + ms, resolve, timer, off });
    approvalChanged();
  });
}

// 本机点了批准 / 拒绝(超时、网页断开也走这里):只有明确的 true 才算批准。返回 false = 没有这条(已处理过 / 已超时 / id 不对)
export function decideApproval(id, ok) {
  const a = approvalQueue.get(id);
  if (!a) return false;
  clearTimeout(a.timer);
  a.off?.();
  approvalQueue.delete(id); // 先拿出队列再通知:调用方 await 到结果时队列里已经没有它
  a.resolve(ok === true);
  approvalChanged();
  return true;
}

// 断开某个配对时:它还在等的批准全部当作拒绝(拿出队列、清定时器),拿掉了就通知一次。返回拿掉了几条
export function dropPairApprovals(pairId) {
  if (pairId == null) return 0;
  let n = 0;
  for (const a of [...approvalQueue.values()]) {
    if (a.pairId !== pairId) continue;
    clearTimeout(a.timer);
    a.off?.();
    approvalQueue.delete(a.id);
    a.resolve(false);
    n++;
  }
  if (n) approvalChanged();
  return n;
}

// 这个配对还在不在(断开 / 撤销之后就不在了)
export const pairAlive = (pairId) => pairId != null && load().pairs.some((p) => p?.id === pairId);
const unpaired = () => Object.assign(new Error(UNPAIRED_MSG), { status: 401 });

// 网页请求等本机批准的入口(server.mjs 和测试夹具都走这里)。item / opts 同 requestApproval(opts.signal 见 clientGoneSignal):
//   · 进队列前,在同一段同步代码里再确认一次这个配对还在:server 写批准框要先查钱包地址(可能要好几秒),这期间网页连接被断开的话,
//     断开时的 dropPairApprovals 已经跑完了,拦不到这条后来才进队列的 → 抛 401「没配对或已断开」(和请求闸门同一句)
//   · 网页断开(signal 中止)→ 这条马上撤掉、当作拒绝,不占同一个配对的 3 个名额
//   · 批准之后再确认一次配对还在,不在就抛 401。调用方拿到结果后紧接着执行,中间别再 await
// 返回 Promise<boolean>(true = 批准);401 / 429 都是同步抛出的(这时调用方还没写任何响应)
export function webApproval(item = {}, opts = {}) {
  if (!pairAlive(item.pairId)) throw unpaired();
  return requestApproval(item, opts).then((ok) => {
    if (ok && !pairAlive(item.pairId)) throw unpaired();
    return ok;
  });
}

// ── 网页查钱包登录状态(/api/login/status):只给「扫完没有」这些字段;二维码(svg)、扫码链接(url)、配对码(code)只给本机页面 ──
//   网页是用 /api/login/request 请本机弹二维码的,它轮询状态只为知道扫完没有;按白名单挑字段,登录状态以后多了什么也不会漏给网页
const WEB_LOGIN_FIELDS = ["state", "address", "expireAt", "error", "pin"];
export function webLoginStatus(s) {
  const out = {};
  for (const k of WEB_LOGIN_FIELDS) if (s?.[k] !== undefined) out[k] = s[k];
  return out;
}

// ── 等批准时用到的固定文案(server.mjs 和测试夹具共用,网页按这几句认) ──
// 文本流接口(转账 / 打赏)等批准时先写的一行
export const APPROVAL_WAIT_TEXT = "⏳ 等待本机助手批准…(请在本机助手页面点「批准」)";
export const NOT_APPROVED = "本机没有批准";
// JSON 接口没批准 / 超时:带 status = 403 的业务拒绝(server.mjs 的 catch 按它回 403)
export const notApproved = () => Object.assign(new Error(NOT_APPROVED), { status: 403 });

// 等批准的这段时间网页那边断开了(关页面 / 刷新):批准了也不再执行。
//   注意不能看 req.destroyed —— 请求体读完它就是 true 了;要看响应和 socket
export const clientGone = (res) => !!(res?.destroyed || res?.writableEnded || res?.socket?.destroyed);
// 网页断开时中止的 signal(交给 webApproval,等批准的这一条就会被撤掉):响应关闭(关页面 / 刷新 / 断网)就中止;拿到时已经断开了 → 已经中止。
//   请求正常结束时响应也会触发 close,那时批准早就处理完了,中止不会再改什么
export function clientGoneSignal(res) {
  const ac = new AbortController();
  if (clientGone(res)) ac.abort();
  else res?.once?.("close", () => ac.abort());
  return ac.signal;
}

// ── 实时事件流(/api/stream)按订阅范围给不给看某类事件 ──
//   local:本机页面,全部;web:网页,不给看批准 / 配对码 / 登录请求这几类(它们只该出现在本机页面);wallet:只读白名单,别的一概不给
//   wallet 不给追踪(track / track-list):网站的追踪名单存在浏览器里,追踪动态网页自己从网站的成交里补;助手跟单用的追踪名单是它自己内部的
const WEB_HIDDEN_EVENTS = new Set(["approve", "linkpair", "loginreq"]);
const WALLET_EVENTS = new Set(["notice", "dropout", "lists", "copy-tasks", "copy-log"]);
export function streamSees(scope, type) {
  if (scope === "local") return true;
  if (scope === "web") return !WEB_HIDDEN_EVENTS.has(type);
  if (scope === "wallet") return WALLET_EVENTS.has(type);
  return false; // 不认识的范围:什么都不给看
}

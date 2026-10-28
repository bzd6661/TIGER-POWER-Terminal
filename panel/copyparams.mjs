// 跟单参数(纯函数:不读写磁盘、不连网):默认值、规整页面 / 网页传来的参数、新建任务、把一次修改套到已有任务上。
//   copy.mjs(跟单引擎)和 weblink.mjs(网页建 / 改跟单任务要不要批准、批准框写什么、批准后执行什么)共用这一份,
//   两边算出来的参数一定一样;测试也直接用它(copy.mjs 一加载就读写 panel/ 下的任务文件,测试不能 import)
export const HARD_MAX_TRADE = 0.5;   // 单笔硬上限(BNB,每个钱包)
const lc = (a) => String(a ?? "").toLowerCase();

export const COPY_DEFAULTS = {
  mode: "fixed",          // fixed = 每次固定 BNB;ratio = 对方买入 BNB × ratioPct%
  amountBnb: 0.01, ratioPct: 10,
  maxPerTrade: 0.05,      // 单笔(每个钱包)上限
  maxPerToken: 0.05,      // 同一个币最多跟买多少(每个钱包)
  dailyCap: 0.2,          // 每天合计(所有钱包)
  maxOpen: 5,             // 最多同时持有几个跟单买的币
  onlyFirst: true,        // 只跟建仓(对方第一次买),同一个币只跟一次
  minTargetBnb: 0, maxTargetBnb: 0, maxMcUsd: 0,   // 0 = 不限
  platforms: ["four", "gang", "flap"],
  maxDelaySec: 15,        // 对方成交后超过几秒才看到就不跟
  slippage: 20,
  wallets: ["1"],
  followSell: false,
  dryRun: true,           // 模拟:只记录会怎么下单,不花钱
  maxCopies: 1,           // 最多跟几次(买入),0 = 不限;跟满自动关闭
};
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
// 规整跟单参数(base = 改已有任务时的原参数);返回完整的一份(base 的每个键都在)。对已经规整过的参数再规整一次,结果不变
export function cleanParams(p = {}, base = COPY_DEFAULTS) {
  const o = { ...base };
  if (p.mode !== undefined) o.mode = p.mode === "ratio" ? "ratio" : "fixed";
  if (p.amountBnb !== undefined) o.amountBnb = clamp(p.amountBnb, 0, HARD_MAX_TRADE, base.amountBnb);
  if (p.ratioPct !== undefined) o.ratioPct = clamp(p.ratioPct, 0, 1000, base.ratioPct);
  if (p.maxPerTrade !== undefined) o.maxPerTrade = clamp(p.maxPerTrade, 0, HARD_MAX_TRADE, base.maxPerTrade);
  if (p.maxPerToken !== undefined) o.maxPerToken = clamp(p.maxPerToken, 0, 10, base.maxPerToken);
  if (p.dailyCap !== undefined) o.dailyCap = clamp(p.dailyCap, 0, 50, base.dailyCap);
  if (p.maxOpen !== undefined) o.maxOpen = Math.round(clamp(p.maxOpen, 1, 100, base.maxOpen));
  if (p.onlyFirst !== undefined) o.onlyFirst = !!p.onlyFirst;
  for (const k of ["minTargetBnb", "maxTargetBnb", "maxMcUsd"]) if (p[k] !== undefined) o[k] = clamp(p[k], 0, 1e12, base[k]);
  if (p.platforms !== undefined) o.platforms = [...new Set([].concat(p.platforms).filter((x) => ["four", "gang", "flap"].includes(x)))];
  if (p.maxDelaySec !== undefined) o.maxDelaySec = Math.round(clamp(p.maxDelaySec, 1, 600, base.maxDelaySec));
  if (p.slippage !== undefined) o.slippage = clamp(p.slippage, 1, 50, base.slippage);
  if (p.wallets !== undefined) o.wallets = [...new Set([].concat(p.wallets).map(String).filter((x) => ["1", "2"].includes(x)))];
  if (p.followSell !== undefined) o.followSell = !!p.followSell;
  if (p.dryRun !== undefined) o.dryRun = !!p.dryRun;
  if (p.maxCopies !== undefined) o.maxCopies = Math.round(clamp(p.maxCopies, 0, 1000, base.maxCopies));
  if (!o.platforms.length) throw new Error("至少选一个平台");
  if (!o.wallets.length) throw new Error("至少选一个钱包");
  return o;
}

// 新建任务(copy.mjs 的 copyTask 新建时用):一律先「暂停」;没起名用目标地址前 8 位
export function newCopyTask(body, now = Date.now()) {
  return {
    id: "c" + now.toString(36), target: lc(body.target), name: String(body.name ?? "").slice(0, 40) || lc(body.target).slice(0, 8), createdAt: now,
    status: "paused", params: cleanParams(body.params), stats: { buyBnb: 0, buys: 0, sells: 0, sims: 0, copies: 0, simCopies: 0, lastAt: null },
    tokens: {}, days: {},
  };
}

// 把一次修改(params / name / status)套到已有任务 t 上(copy.mjs 的 copyTask 改任务时用)。
//   先全部校验再改:状态不对、已关闭的要重新启动、参数不对(cleanParams 抛错)都在改任何东西之前抛出,任务原样不动
export function applyCopyEdit(t, body, now = Date.now()) {
  if (body.status) {
    if (!["running", "paused", "closed"].includes(body.status)) throw new Error("状态不对");
    if (t.status === "closed" && body.status !== "closed") throw new Error("已关闭的任务不能再启动,新建一个");
  }
  const params = body.params ? cleanParams(body.params, t.params) : null;
  if (params) t.params = params;
  if (body.name !== undefined) t.name = String(body.name).slice(0, 40) || t.name;
  if (body.status) {
    t.status = body.status;
    if (body.status === "closed") { t.closedAt = now; t.closeReason = "手动关闭"; }
  }
  return t;
}

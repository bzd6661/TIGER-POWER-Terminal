// 历史数据缓存:各盘的历史成交、外盘分钟 K 线、BNB 历史价存起来,重启或再次打开同一个币时只补上次之后的新数据。
//   存在哪(按顺序选第一个能用的):
//     1. .env 配了 MYSQL_URL(比如 mysql://user:pass@127.0.0.1:3306/agentbuy)→ MySQL(要 npm i mysql2)
//     2. 默认:本机 SQLite 文件 panel/cache.db(Node 22.5+ 自带,不用装任何东西)
//     3. 都用不了(Node 太旧等)→ 不缓存,照原来每次从链上 / 接口拉
//   可选 REDIS_URL(要 npm i ioredis):DexScreener / GeckoTerminal 的接口结果存 15 秒,多个面板共用一份,少被限流;没配就用进程内存。
//   任何读写出错都当没缓存处理(返回 null),不影响面板本身。/api/cache-status 看状态。
import { fileURLToPath } from "node:url";
import "../env.mjs";
import { dataFile } from "./datadir.mjs";

const st = { backend: "none", redis: null, hits: 0, misses: 0, writes: 0, errors: 0, lastError: null };
const err = (e) => { st.errors++; st.lastError = String(e?.message ?? e).slice(0, 200); return null; };
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS trades (src VARCHAR(16) NOT NULL, token CHAR(42) NOT NULL, uid VARCHAR(160) NOT NULL, ts BIGINT NOT NULL, j TEXT NOT NULL, PRIMARY KEY (src, token, uid))",
  "CREATE TABLE IF NOT EXISTS hist_cursor (src VARCHAR(16) NOT NULL, token CHAR(42) NOT NULL, cur BIGINT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY (src, token))",
  "CREATE TABLE IF NOT EXISTS ohlcv (pool CHAR(42) NOT NULL, t BIGINT NOT NULL, o DOUBLE, h DOUBLE, l DOUBLE, c DOUBLE, v DOUBLE, PRIMARY KEY (pool, t))",
  "CREATE TABLE IF NOT EXISTS bnb_px (m BIGINT NOT NULL PRIMARY KEY, px DOUBLE NOT NULL)",
];

// ---------- 存储后端:统一成 q(sql, params) → rows、batch(sql 前缀, 行数组, 每行列数, 冲突时更新子句) ----------
let db = null;   // { q, upsert }
let redis = null;
async function openMysql(url) {
  const mysql = await import("mysql2/promise").catch(() => null);
  if (!mysql) { err("配了 MYSQL_URL 但没装 mysql2(在项目目录运行 npm i mysql2)"); return null; }
  try {
    const pool = mysql.createPool({ uri: url, connectionLimit: 4, connectTimeout: 3000 });
    for (const s of SCHEMA) await pool.query(s.replace(/CHAR\(42\)/g, "CHAR(42) CHARACTER SET ascii"));
    st.backend = "mysql";
    return {
      q: async (sql, p = []) => (await pool.query(sql, p))[0],
      // INSERT … VALUES ? ON DUPLICATE KEY UPDATE:每批 500 行
      upsert: async (table, cols, rows, keyCols) => {
        const upd = cols.filter((c) => !keyCols.includes(c)).map((c) => `${c}=VALUES(${c})`).join(",");
        for (let i = 0; i < rows.length; i += 500) await pool.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ? ON DUPLICATE KEY UPDATE ${upd}`, [rows.slice(i, i + 500)]);
      },
    };
  } catch (e) { err(e); return null; }
}
async function openSqlite() {
  let mod;
  try {
    // node:sqlite 还是实验功能,会打印一句警告:只屏蔽这一条
    const emit = process.emitWarning;
    process.emitWarning = (w, ...r) => (/SQLite is an experimental/.test(String(w)) ? undefined : emit.call(process, w, ...r));
    try { mod = await import("node:sqlite"); } finally { process.emitWarning = emit; }
  } catch { return null; }   // Node 22.5 以前没有
  try {
    const d = new mod.DatabaseSync(dataFile("cache.db"));
    d.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    for (const s of SCHEMA) d.exec(s);
    st.backend = "sqlite";
    const stmts = new Map();
    const prep = (sql) => { if (!stmts.has(sql)) stmts.set(sql, d.prepare(sql)); return stmts.get(sql); };
    return {
      q: async (sql, p = []) => prep(sql).all(...p),
      upsert: async (table, cols, rows, keyCols) => {
        const upd = cols.filter((c) => !keyCols.includes(c)).map((c) => `${c}=excluded.${c}`).join(",");
        const s = prep(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")}) ON CONFLICT(${keyCols.join(",")}) DO UPDATE SET ${upd}`);
        d.exec("BEGIN");
        try { for (const r of rows) s.run(...r); d.exec("COMMIT"); } catch (e) { d.exec("ROLLBACK"); throw e; }
      },
    };
  } catch (e) { err(e); return null; }
}
const ready = (async () => {
  if (process.env.AGENTBUY_NO_CACHE === "1") return;
  db = (process.env.MYSQL_URL && (await openMysql(process.env.MYSQL_URL))) || (await openSqlite());
  if (process.env.REDIS_URL) {
    const R = await import("ioredis").then((m) => m.default ?? m.Redis).catch(() => null);
    if (!R) err("配了 REDIS_URL 但没装 ioredis(npm i ioredis)");
    else {
      try {
        redis = new R(process.env.REDIS_URL, { connectTimeout: 1000, commandTimeout: 500, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => 5000, lazyConnect: true });
        redis.on("error", () => {});
        await redis.connect();
        st.redis = "up";
      } catch (e) { st.redis = "down"; err(e); }
    }
  }
})().catch(err);

// ---------- 成交:按 src(four / gang / flap)+ token 存;cursor 是区块号或「已拉全」标记 ----------
// 返回 { rows, cursor } 或 null(没缓存 / 出错)
export async function loadTrades(src, token) {
  await ready;
  if (!db) return null;
  try {
    const k = token.toLowerCase();
    const [cur] = await db.q("SELECT cur FROM hist_cursor WHERE src=? AND token=?", [src, k]);
    if (!cur) { st.misses++; return null; }
    const rows = (await db.q("SELECT j FROM trades WHERE src=? AND token=? ORDER BY ts DESC", [src, k])).map((r) => JSON.parse(r.j));
    st.hits++;
    return { rows, cursor: Number(cur.cur) };
  } catch (e) { return err(e); }
}
// rows:要新增 / 更新的成交(uidOf 给唯一键);cursor:这次补到哪
export async function saveTrades(src, token, rows, cursor, uidOf) {
  await ready;
  if (!db) return;
  try {
    const k = token.toLowerCase();
    if (rows.length) await db.upsert("trades", ["src", "token", "uid", "ts", "j"], rows.map((r) => [src, k, uidOf(r), Number(r.ts) || 0, JSON.stringify(r)]), ["src", "token", "uid"]);
    await db.upsert("hist_cursor", ["src", "token", "cur", "at"], [[src, k, Number(cursor) || 0, Date.now()]], ["src", "token"]);
    st.writes++;
  } catch (e) { err(e); }
}

// ---------- 外盘分钟 K 线:按池子存 ----------
export async function loadBars(pool, since = 0) {
  await ready;
  if (!db) return [];
  try { return (await db.q("SELECT t,o,h,l,c,v FROM ohlcv WHERE pool=? AND t>=? ORDER BY t", [pool.toLowerCase(), Number(since) || 0])).map((b) => ({ t: Number(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })); }
  catch (e) { err(e); return []; }
}
export async function saveBars(pool, bars) {
  await ready;
  if (!db || !bars.length) return;
  try { await db.upsert("ohlcv", ["pool", "t", "o", "h", "l", "c", "v"], bars.map((b) => [pool.toLowerCase(), b.t, b.o, b.h, b.l, b.c, b.v]), ["pool", "t"]); st.writes++; }
  catch (e) { err(e); }
}

// ---------- BNB 历史价(按分钟,算买入时的美元成本用) ----------
export async function loadBnbPx(m) {
  await ready;
  if (!db) return null;
  try { const [r] = await db.q("SELECT px FROM bnb_px WHERE m=?", [m]); return r ? Number(r.px) : null; } catch (e) { return err(e); }
}
export async function saveBnbPx(m, px) {
  await ready;
  if (!db || !(px > 0)) return;
  try { await db.upsert("bnb_px", ["m", "px"], [[m, px]], ["m"]); } catch (e) { err(e); }
}

// ---------- 接口结果短时缓存(Redis 或进程内存) ----------
const mem = new Map();
export async function fetchJsonCached(url, ttlSec = 15, opts = {}) {
  await ready;
  const key = "agentbuy:http:" + url;
  if (redis && st.redis === "up") {
    try { const v = await redis.get(key); if (v) { st.hits++; return JSON.parse(v); } } catch { /* 当没缓存 */ }
  } else {
    const h = mem.get(key);
    if (h && Date.now() - h.at < ttlSec * 1000) return h.v;
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(opts.timeout ?? 12000), headers: opts.headers });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  const v = await r.json();
  if (redis && st.redis === "up") redis.set(key, JSON.stringify(v), "EX", ttlSec).catch(() => {});
  else { mem.set(key, { at: Date.now(), v }); if (mem.size > 500) mem.delete(mem.keys().next().value); }
  return v;
}

export async function cacheStatus() {
  await ready;
  let size = null;
  if (db) {
    try {
      const [[a], [b], [c]] = await Promise.all([db.q("SELECT COUNT(*) AS n FROM trades"), db.q("SELECT COUNT(*) AS n FROM ohlcv"), db.q("SELECT COUNT(*) AS n FROM hist_cursor")]);
      size = { trades: Number(a.n), bars: Number(b.n), tokens: Number(c.n) };
    } catch (e) { err(e); }
  }
  return { ...st, mysql: process.env.MYSQL_URL ? String(process.env.MYSQL_URL).replace(/:[^:@/]+@/, ":***@") : null, size };
}

// 网页 ⇄ 本地小助手:配对与令牌存储(panel/weblink.mjs 第一部分)
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "weblink-pair-"));
process.env.AGENTBUY_DATA_DIR = dir;
delete process.env.AGENTBUY_WEB_ORIGINS;
const w = await import("../panel/weblink.mjs");

const O = "https://tigerpower.online";
const OTHER = "http://localhost:8080";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const wrongOf = (code) => (code === "000000" ? "000001" : "000000");
const pairsFile = () => readFileSync(join(dir, "web-pairs.json"), "utf8");
// 配对有防爆破(两次开始至少隔 10 秒、10 分钟内失败太多锁 15 分钟):每个用例用自己的一段时间,隔 1 小时,互不影响
let base = 0;
const fresh = () => (base += 3_600_000);

test("来源白名单默认只认官方网址", () => {
  assert.deepEqual([...w.WEB_ORIGINS], [O]);
  assert.equal(w.isWebOrigin(O), true);
  assert.equal(w.isWebOrigin(OTHER), false);
  assert.equal(w.isWebOrigin(undefined), false);
});

test("startPair 开一轮配对,pendingPair 给出 6 位数字码", () => {
  const t = fresh();
  assert.deepEqual(w.startPair(O, t), { expiresIn: 120 });
  const p = w.pendingPair(t + 1000);
  assert.match(p.code, /^\d{6}$/);
  assert.equal(p.origin, O);
  assert.equal(p.expiresIn, 119);
});

test("错码 5 次都是配对码不对,第 6 次试太多次,之后配对作废", () => {
  const t = fresh();
  w.startPair(O, t);
  const bad = wrongOf(w.pendingPair(t).code);
  for (let i = 0; i < 5; i++) {
    assert.throws(() => w.finishPair(O, bad, "Chrome", t + 1000), { message: "配对码不对" });
  }
  assert.throws(() => w.finishPair(O, bad, "Chrome", t + 1000), { message: "试太多次,重新开始配对", status: 429 });
  assert.equal(w.pendingPair(t + 1000), null);
});

test("超过 120 秒配对码过期", () => {
  const t = fresh();
  w.startPair(O, t);
  const { code } = w.pendingPair(t);
  assert.equal(w.pendingPair(t + 121_000), null);
  assert.throws(() => w.finishPair(O, code, "Chrome", t + 121_000), { message: "没有进行中的配对或已过期" });
});

test("别的来源不能完成配对", () => {
  const t = fresh();
  w.startPair(O, t);
  const { code } = w.pendingPair(t);
  assert.throws(() => w.finishPair(OTHER, code, "Chrome", t + 1000), { message: "没有进行中的配对或已过期" });
  assert.ok(w.pendingPair(t + 1000), "别的来源的试探不应该毁掉进行中的配对");
});

test("配对成功 → 令牌只认配对时的来源,磁盘上只存哈希,撤销后失效", () => {
  const t = fresh();
  w.startPair(O, t);
  const { code } = w.pendingPair(t);
  const { token, id } = w.finishPair(O, code, "Chrome", t + 1000);
  assert.ok(token.length >= 43);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(w.pendingPair(t + 1000), null);

  assert.equal(w.verifyToken(O, token).label, "Chrome");
  assert.equal(w.verifyToken(OTHER, token), null);
  assert.equal(w.verifyToken(O, "x"), null);

  const raw = pairsFile();
  assert.ok(!raw.includes(token), "磁盘上不能有令牌原文");
  assert.ok(raw.includes(sha256(token)));
  assert.ok(!("hash" in w.listPairs().find((p) => p.id === id)), "listPairs 不能暴露哈希");

  assert.equal(w.revokePair(id), true);
  assert.equal(w.verifyToken(O, token), null);
  assert.ok(!w.listPairs().some((p) => p.id === id));
  assert.equal(w.revokePair(id), false);
});

test("lastUsed 内存里每次更新,写盘最多 60 秒一次", () => {
  const t = fresh();
  w.startPair(O, t);
  const { code } = w.pendingPair(t);
  const { token, id } = w.finishPair(O, code, "Edge", t + 1000);
  const onDisk = () => JSON.parse(pairsFile()).pairs.find((p) => p.id === id).lastUsed;
  const t0 = Date.now() + 120_000; // 比刚才的 finishPair 写盘晚 60 秒以上 → 这次会写盘
  assert.equal(w.verifyToken(O, token, t0).lastUsed, t0);
  assert.equal(onDisk(), t0);
  assert.equal(w.verifyToken(O, token, t0 + 5_000).lastUsed, t0 + 5_000);
  assert.equal(onDisk(), t0, "60 秒内不重复写盘");
  assert.equal(w.verifyToken(O, token, t0 + 61_000).lastUsed, t0 + 61_000);
  assert.equal(onDisk(), t0 + 61_000);
  w.revokePair(id);
});

test("非 ASCII 的 6 个字符(UTF-16 等长、字节不等长)也只是配对码不对,不会抛别的错", () => {
  let t = fresh();
  for (const bad of ["一二三四五六", "１２３４５６"]) {
    w.startPair(O, (t += 10_000));
    assert.throws(() => w.finishPair(O, bad, "Chrome", t + 1000), { message: "配对码不对" });
  }
});

// ── 防爆破:开始配对的间隔、失败太多锁 15 分钟 ──
const LOCK = "配对尝试太多,请 15 分钟后再试";
const GAP = "配对太频繁,稍等几秒";

test("两次开始配对至少隔 10 秒:太快 → 429 配对太频繁,进行中的那一轮不受影响", () => {
  const t = fresh();
  w.startPair(O, t);
  const { code } = w.pendingPair(t);
  assert.throws(() => w.startPair(O, t + 1), { message: GAP, status: 429 });
  assert.throws(() => w.startPair(O, t + 9_999), { message: GAP, status: 429 });
  assert.equal(w.pendingPair(t + 9_999).code, code, "被拒的这一下不能顶掉进行中的配对");
  assert.deepEqual(w.startPair(O, t + 10_000), { expiresIn: 120 }); // 被拒的那几下不顺延
});

test("10 分钟内 3 轮没配成(被顶掉 / 试太多次 / 过期)→ 下一次开始配对 429,锁 15 分钟,本机日志记一笔", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const t0 = fresh();
  w.startPair(O, t0);
  w.startPair(O, t0 + 10_000); // 顶掉第 1 轮:失败 1
  const bad = wrongOf(w.pendingPair(t0 + 10_000).code);
  for (let i = 0; i < 5; i++) assert.throws(() => w.finishPair(O, bad, "x", t0 + 11_000), { message: "配对码不对" });
  assert.throws(() => w.finishPair(O, bad, "x", t0 + 11_000), { message: "试太多次,重新开始配对", status: 429 }); // 失败 2
  w.startPair(O, t0 + 20_000); // 第 3 轮,放着让它过期:失败 3(按过期那一刻算)
  assert.equal(warn.mock.callCount(), 0);
  assert.throws(() => w.startPair(O, t0 + 200_000), { message: LOCK, status: 429 });
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /配对失败太多/);
  assert.equal(w.pendingPair(t0 + 200_000), null);
  // 15 分钟内一律 429(不再重复记日志),到点放开
  assert.throws(() => w.startPair(O, t0 + 200_000 + 899_999), { message: LOCK, status: 429 });
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(w.startPair(O, t0 + 200_000 + 900_000), { expiresIn: 120 });
});

test("10 分钟内错码 10 次 → 第 10 次就锁(429),进行中的配对作废,开始配对也 429", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const t0 = fresh();
  w.startPair(O, t0);
  let bad = wrongOf(w.pendingPair(t0).code);
  for (let i = 0; i < 5; i++) assert.throws(() => w.finishPair(O, bad, "x", t0 + 1000), { message: "配对码不对" });
  w.startPair(O, t0 + 10_000); // 换一轮接着试(这一下也算失败 1 轮)
  const { code } = w.pendingPair(t0 + 10_000);
  bad = wrongOf(code);
  for (let i = 0; i < 4; i++) assert.throws(() => w.finishPair(O, bad, "x", t0 + 11_000), { message: "配对码不对" });
  assert.throws(() => w.finishPair(O, bad, "x", t0 + 11_000), { message: LOCK, status: 429 });
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(w.pendingPair(t0 + 11_000), null, "锁的时候进行中的这一轮也作废");
  assert.throws(() => w.finishPair(O, code, "x", t0 + 12_000), { message: "没有进行中的配对或已过期" }, "对码也换不到令牌");
  assert.throws(() => w.startPair(O, t0 + 30_000), { message: LOCK, status: 429 });
  assert.deepEqual(w.startPair(O, t0 + 11_000 + 900_000), { expiresIn: 120 });
});

test("失败计数:配对成功一次就清零;10 分钟以前的失败不算", (t) => {
  t.mock.method(console, "warn", () => {});
  const t0 = fresh();
  w.startPair(O, t0); w.startPair(O, t0 + 10_000); w.startPair(O, t0 + 20_000); // 失败 2 轮,第 3 轮进行中
  const { id } = w.finishPair(O, w.pendingPair(t0 + 20_000).code, "x", t0 + 21_000); // 配成 → 清零
  w.startPair(O, t0 + 30_000); w.startPair(O, t0 + 40_000); w.startPair(O, t0 + 50_000); // 又失败 2 轮(t0+40s、t0+50s)
  assert.ok(w.pendingPair(t0 + 50_000), "清零后只失败 2 轮,不该锁");
  w.revokePair(id);
  // 第 3 轮放着过期(按 t0+170s 算);10 分钟后再开始:t0+40s、t0+50s 那两次已经滚出窗口,只算 1 轮,不锁
  assert.deepEqual(w.startPair(O, t0 + 650_001), { expiresIn: 120 });
});

// ── 写盘失败 ──

test("lastUsed 写盘失败:照常放行,只记本机日志,60 秒内不重试", (t) => {
  const err = t.mock.method(console, "error", () => {});
  const t0 = fresh();
  w.startPair(O, t0);
  const { token, id } = w.finishPair(O, w.pendingPair(t0).code, "坏盘", t0 + 1000);
  const tmp = join(dir, "web-pairs.json.tmp");
  mkdirSync(tmp); // 临时文件的位置被目录占了 → 写盘必然失败
  try {
    assert.equal(w.verifyToken(O, token, t0 + 120_000)?.id, id);
    assert.equal(err.mock.callCount(), 1);
    assert.match(String(err.mock.calls[0].arguments[0]), /写盘失败/);
    assert.equal(w.verifyToken(O, token, t0 + 150_000)?.id, id);
    assert.equal(err.mock.callCount(), 1, "60 秒内不重试");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  assert.equal(w.verifyToken(O, token, t0 + 200_000)?.id, id);
  assert.equal(JSON.parse(pairsFile()).pairs.find((p) => p.id === id).lastUsed, t0 + 200_000, "盘好了照常写");
  w.revokePair(id);
});

test("revokePair 先写盘再改内存:写不进去就抛错,配对还在(令牌照样能用),盘好了再撤销", () => {
  const t0 = fresh();
  w.startPair(O, t0);
  const { token, id } = w.finishPair(O, w.pendingPair(t0).code, "撤销", t0 + 1000);
  const tmp = join(dir, "web-pairs.json.tmp");
  mkdirSync(tmp);
  try {
    assert.throws(() => w.revokePair(id), (e) => typeof e?.code === "string"); // 系统错误原样抛出:server 会报回本机页面
    assert.ok(w.listPairs().some((p) => p.id === id), "内存里也没撤销");
    assert.equal(w.verifyToken(O, token, t0 + 2000)?.id, id);
    assert.ok(JSON.parse(pairsFile()).pairs.some((p) => p.id === id));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  assert.equal(w.revokePair(id), true);
  assert.equal(w.verifyToken(O, token, t0 + 3000), null);
  assert.ok(!JSON.parse(pairsFile()).pairs.some((p) => p.id === id));
});

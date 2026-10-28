// gang.fun 接口:同时最多 3 个请求排队发;遇到限流(429 / 返回网页而不是 JSON / 5xx)等一下重试两次
//   公开版很多人同时打开不同的币时,不排队会把接口打到限流,大家一起看不到成交
const MAX = 3;
let pauseUntil = 0;   // 被限流后所有请求一起歇一会儿
let active = 0;
const waiters = [];
// 排队超过 60 个就直接报错(调用方会先用旧数据),不让队伍无限变长、拖慢所有人
const slot = () => (active < MAX ? (active++, Promise.resolve()) : waiters.length >= 60 ? Promise.reject(new Error("gang.fun 请求排队太多,稍后再试")) : new Promise((r) => waiters.push(r)));
const release = () => { const w = waiters.shift(); if (w) w(); else active--; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function gangJson(url, timeoutMs = 15000) {
  let last;
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(1500 * i);
    await slot();
    try {
      const wait = pauseUntil - Date.now(); if (wait > 0) await sleep(wait);
      const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      const text = await r.text();
      if (r.status === 429 || r.status >= 500 || !/^\s*[[{]/.test(text)) { if (r.status === 429) pauseUntil = Date.now() + 3000; last = new Error(`gang.fun 接口暂时限流(${r.status}),稍后自动重试`); continue; }
      return JSON.parse(text);
    } catch (e) { last = e; }
    finally { release(); }
  }
  throw last;
}

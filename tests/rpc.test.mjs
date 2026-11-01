// 读链节点自动换:第一个节点 403 / 断开时换下一个(两个都是本机假节点,不连外网)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ethers } from "ethers";
import { RetryProvider } from "../rpc.mjs";

const listen = (fn) => new Promise((ok) => { const s = http.createServer(fn).listen(0, "127.0.0.1", () => ok(s)); });
const url = (s) => `http://127.0.0.1:${s.address().port}`;
const goodNode = () => listen((q, r) => {
  let b = ""; q.on("data", (c) => (b += c)).on("end", () => {
    const j = JSON.parse(b); const one = (x) => ({ jsonrpc: "2.0", id: x.id, result: "0x10" });
    r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
  });
});
const net = ethers.Network.from(56);

test("第一个节点 403:换到下一个,之后的请求也直接用它", async () => {
  let bad = 0, good = 0;
  const s1 = await listen((q, r) => { bad++; r.writeHead(403); r.end("<h1>403 Forbidden</h1>"); });
  const s2 = await goodNode(); s2.on("request", () => good++);
  const p = new RetryProvider([url(s1), url(s2)], net, { staticNetwork: net });
  assert.equal(await p.getBlockNumber(), 16);
  assert.equal(await p.getBalance("0x000000000000000000000000000000000000dEaD"), 16n);
  assert.equal(bad, 1);   // 第二次不再碰坏节点
  assert.ok(good >= 1);
  p.destroy(); s1.close(); s2.close();
});

test("连不上的节点也会换", async () => {
  const s2 = await goodNode();
  const p = new RetryProvider(["http://127.0.0.1:1", url(s2)], net, { staticNetwork: net });
  assert.equal(await p.getBlockNumber(), 16);
  p.destroy(); s2.close();
});

test("所有节点都坏:报最后一个错误", async () => {
  const s1 = await listen((q, r) => { r.writeHead(429); r.end("slow down"); });
  const p = new RetryProvider([url(s1), url(s1)], net, { staticNetwork: net });
  await assert.rejects(p.getBlockNumber(), (e) => e.code === "SERVER_ERROR");
  p.destroy(); s1.close();
});

test("节点回「要 API key」(像 ankr 那样回一个错误对象、不带 id):换下一个", async () => {
  let bad = 0;
  const s1 = await listen((q, r) => { bad++; r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Unauthorized: You must authenticate your request with an API key." } })); });
  const s2 = await goodNode();
  const p = new RetryProvider([url(s1), url(s2)], net, { staticNetwork: net });
  assert.equal(await p.getCode("0x000000000000000000000000000000000000dEaD"), "0x10");
  assert.equal(bad, 1);
  p.destroy(); s1.close(); s2.close();
});

test("合约 revert 不是节点问题:不换节点,照原样报错", async () => {
  let hits2 = 0;
  const s1 = await listen((q, r) => {
    let b = ""; q.on("data", (c) => (b += c)).on("end", () => {
      const j = JSON.parse(b); const one = (x) => ({ jsonrpc: "2.0", id: x.id, error: { code: 3, message: "execution reverted", data: "0x" } });
      r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  const s2 = await goodNode(); s2.on("request", () => hits2++);
  const p = new RetryProvider([url(s1), url(s2)], net, { staticNetwork: net });
  await assert.rejects(p.call({ to: "0x000000000000000000000000000000000000dEaD", data: "0x" }), (e) => e.code === "CALL_EXCEPTION");
  assert.equal(hits2, 0);
  p.destroy(); s1.close(); s2.close();
});

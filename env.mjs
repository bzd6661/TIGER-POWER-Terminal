// 读 agentbuy 根目录的 .env(KEY=VALUE,# 开头是注释),已经在环境变量里的不覆盖。
// .env 在 .gitignore 里:私有节点、Telegram 机器人这类只放这里,不写进代码。可以参照 .env.example。
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(new URL("./.env", import.meta.url), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
} catch { /* 没有 .env 就用默认值 */ }

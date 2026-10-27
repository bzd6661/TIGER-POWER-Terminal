// Windows 上 @gangfun/cli 用 execFileSync('baw') 找不到 npm 的 baw.cmd;把 baw 调用改成 node 直接跑 baw 的入口文件。
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
// BAW_ENTRY 指定时用那份 baw(账号 2),否则用全局 baw
const bawEntry = process.env.BAW_ENTRY || process.env.BAW1_ENTRY || join(cp.execSync("npm root -g", { encoding: "utf8" }).trim(), "@binance", "agentic-wallet", "dist", "index.js");
const orig = cp.execFileSync;
cp.execFileSync = (file, args = [], opts) =>
  file === "baw" ? orig(process.execPath, [bawEntry, ...args], opts) : orig(file, args, opts);
syncBuiltinESMExports();

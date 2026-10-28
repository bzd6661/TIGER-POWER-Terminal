// 账号 2 的 baw 子进程先加载这个文件:不让 baw 用 Windows 凭据管理器(@github/keytar)。
//   baw 1.11.0 把登录会话写死存在凭据管理器的同一个槽位(service "baw" / account "agentSessionId"),
//   两份 baw 都能用 keytar 时,账号 1、2 会互相覆盖登录。
//   baw 是 try { await import("@github/keytar") } catch 加载的:这里让这个 import 失败,
//   baw 就退回到 BINANCE_BAW_DIR 里的加密文件会话(baw2/.baw),和账号 1 完全分开,装没装 keytar 都一样。
//   用法:node --import <本文件的 file URL> <baw 入口> …(见 accounts.mjs 的 bawSpawn)
import { register } from "node:module";

const HOOKS = `export async function resolve(specifier, context, next) {
  if (/^(@github\\/)?keytar(\\/|$)/.test(specifier)) {
    const e = new Error("agentbuy: keytar disabled for this baw (session stays in BINANCE_BAW_DIR)");
    e.code = "ERR_MODULE_NOT_FOUND";
    throw e;
  }
  return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(HOOKS));

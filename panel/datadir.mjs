// 缓存 / 状态文件放哪:默认就在 panel 目录;服务器部署时用 AGENTBUY_DATA_DIR 指到单独的数据盘(Docker 卷)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = process.env.AGENTBUY_DATA_DIR || fileURLToPath(new URL(".", import.meta.url));
if (process.env.AGENTBUY_DATA_DIR) mkdirSync(DIR, { recursive: true });
export const dataFile = (name) => join(DIR, name);

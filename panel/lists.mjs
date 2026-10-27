// 收藏(分组)和屏蔽列表(代币 / 开发者),存在本机 panel/lists.json(不提交)。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const FILE = fileURLToPath(new URL("./lists.json", import.meta.url));
let L = { groups: [{ id: "default", name: "默认" }], favs: {}, blockTokens: {}, blockDevs: {} };
try { L = { ...L, ...JSON.parse(readFileSync(FILE, "utf8")) }; } catch {}
const save = () => { try { writeFileSync(FILE, JSON.stringify(L, null, 1)); } catch {} };
const addr = (a) => { if (!ethers.isAddress(a)) throw new Error("地址格式不对"); return a.toLowerCase(); };
const label = (s) => String(s ?? "").slice(0, 40);

export const lists = () => L;
export function op(b) {
  switch (b.op) {
    case "fav": {   // { ca, on, group?, symbol?, platform? }
      const ca = addr(b.ca);
      if (b.on) L.favs[ca] = { group: L.groups.some((g) => g.id === b.group) ? b.group : L.favs[ca]?.group ?? "default", symbol: label(b.symbol), platform: label(b.platform), at: L.favs[ca]?.at ?? Date.now() };
      else delete L.favs[ca];
      break;
    }
    case "addGroup": { const name = label(b.name).trim(); if (!name) throw new Error("分组名不能为空"); L.groups.push({ id: "g" + Date.now().toString(36), name }); break; }
    case "renameGroup": { const g = L.groups.find((x) => x.id === b.id); if (!g) throw new Error("没有这个分组"); g.name = label(b.name).trim() || g.name; break; }
    case "deleteGroup": {
      if (b.id === "default") throw new Error("默认分组不能删");
      L.groups = L.groups.filter((g) => g.id !== b.id);
      for (const f of Object.values(L.favs)) if (f.group === b.id) f.group = "default";
      break;
    }
    case "blockToken": { const ca = addr(b.ca); if (b.on) L.blockTokens[ca] = { label: label(b.label), at: Date.now() }; else delete L.blockTokens[ca]; break; }
    case "blockDev": { const a = addr(b.address); if (b.on) L.blockDevs[a] = { label: label(b.label), at: Date.now() }; else delete L.blockDevs[a]; break; }
    default: throw new Error("不认识的操作");
  }
  save();
  return L;
}

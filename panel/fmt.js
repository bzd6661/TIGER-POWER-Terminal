// 三个页面共用的数字 / 时间格式(各页面的 num / age / ago 都转到这里,写法一致)
//   数字:≥1000 用 K / M / B,最多 3 位有效小数、去掉尾零(8,384.26 → 8.38K,10.00M → 10M);
//         1–1000 最多 4 位有效数字(可用 d 限制小数位);<1 保留 3 位有效数字。
//   时间:12秒 / 5分 / 5时 / 2天,四舍五入、不带小数(英文界面由 i18n 换成 12s / 5m / 5h / 2d)。
(() => {
  const trim = (s) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
  function num(x, d = 4) {
    if (x === null || x === undefined || x === "" || !isFinite(x)) return "—";
    const v = Number(x), a = Math.abs(v);
    if (a >= 1e9) return trim((v / 1e9).toFixed(2)) + "B";
    if (a >= 1e6) return trim((v / 1e6).toFixed(2)) + "M";
    if (a >= 1e3) return trim((v / 1e3).toFixed(a >= 1e5 ? 1 : 2)) + "K";
    if (a >= 1) { const dec = Math.min(d, Math.max(0, 3 - Math.floor(Math.log10(a)))); return trim(v.toFixed(dec)); }
    if (a === 0) return "0";
    return trim(v.toPrecision(3));
  }
  // 带单位:「1.25 BNB」「8.38K GANG」(数字和单位之间一个空格)
  const amt = (x, unit, d) => (x === null || x === undefined || !isFinite(x) ? "—" : num(x, d) + (unit ? " " + unit : ""));
  function ago(ts) {
    if (!ts) return "";
    const s = Math.max(0, Date.now() / 1000 - ts);
    return s < 60 ? Math.round(s) + "秒" : s < 3600 ? Math.round(s / 60) + "分" : s < 86400 ? Math.round(s / 3600) + "时" : Math.round(s / 86400) + "天";
  }
  window.FMT = { num, amt, ago };
})();

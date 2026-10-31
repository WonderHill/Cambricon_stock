// 免费行情源的抓取与解析。只用标准 fetch/TextDecoder，Cloudflare Worker 和 Node 18+ 都能跑。
//
// 数据源（均为非官方公开接口，字段随时可能变化）：
//   东方财富 push2delay：实时报价、资金流向（海外 IP 访问 push2 会被 302 到这个域名）
//   东方财富 push2his  ：当日 1 分钟 K 线
//   腾讯 qt.gtimg.cn   ：报价 + 五档盘口（同时作为报价备用源）
//   腾讯 ifzq.gtimg.cn ：分时数据（作为分钟线备用源）

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 8000;

async function get(url, { referer, encoding } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { "User-Agent": UA };
    if (referer) headers.Referer = referer;
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
    const buf = await res.arrayBuffer();
    return decode(buf, encoding);
  } finally {
    clearTimeout(timer);
  }
}

function decode(buf, encoding = "utf-8") {
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    // 运行时不支持 GBK 时退回 latin1：只有中文名会乱码，数字字段不受影响
    return new TextDecoder("latin1").decode(buf);
  }
}

const num = (v) => {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const scale = (v, k) => {
  const n = num(v);
  return n === null ? null : n * k;
};

// 东方财富 / 腾讯在不同板块下成交量单位不一致（股 或 手）。
// 用 成交额 ÷ (量 × 价) 判断：≈1 说明是股，≈100 说明是手。
function toShares(vol, amount, price) {
  if (!vol || !amount || !price) return vol;
  return amount / (vol * price) > 50 ? vol * 100 : vol;
}

// ---------- 代码映射 ----------

export function marketOf(code) {
  return /^[569]/.test(code) ? "sh" : /^[48]/.test(code) ? "bj" : "sz";
}
const emSecid = (code, isIndex = false) =>
  `${isIndex || marketOf(code) === "sh" ? 1 : 0}.${code}`;

// 对比指数：科创板用科创50，其余用沪深300
export function benchmarkOf(code) {
  return code.startsWith("688")
    ? { code: "000688", name: "科创50" }
    : { code: "000300", name: "沪深300" };
}

// ---------- 东方财富 ----------

const EM_QUOTE_FIELDS =
  "f43,f44,f45,f46,f47,f48,f49,f50,f51,f52,f57,f58,f59,f60,f71,f86,f116,f117,f161,f162,f167,f168,f169,f170";

export async function emQuote(code) {
  const url = `https://push2delay.eastmoney.com/api/qt/stock/get?secid=${emSecid(code)}&fields=${EM_QUOTE_FIELDS}`;
  const d = JSON.parse(await get(url, { referer: "https://quote.eastmoney.com/" })).data;
  if (!d || d.f43 == null || d.f43 === "-") throw new Error("eastmoney quote empty");
  const p = 10 ** (d.f59 ?? 2);
  const px = (v) => (typeof v === "number" ? v / p : null);
  const pct = (v) => (typeof v === "number" ? v / 100 : null);
  return {
    name: d.f58,
    price: px(d.f43),
    high: px(d.f44),
    low: px(d.f45),
    open: px(d.f46),
    prevClose: px(d.f60),
    avgPrice: px(d.f71),
    limitUp: px(d.f51),
    limitDown: px(d.f52),
    change: px(d.f169),
    pct: pct(d.f170),
    volume: scale(d.f47, 100), // 手 → 股
    amount: num(d.f48),
    outerVol: scale(d.f49, 100),
    innerVol: scale(d.f161, 100),
    volumeRatio: pct(d.f50),
    turnover: pct(d.f168),
    pe: pct(d.f162),
    pb: pct(d.f167),
    totalCap: num(d.f116),
    floatCap: num(d.f117),
    time: d.f86 ? new Date(d.f86 * 1000).toISOString() : null,
  };
}

// 当日 1 分钟 K 线。返回 { date, prevClose, bars:[{t,o,h,l,c,v,a}] }
export async function emMinuteBars(code, isIndex = false) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${emSecid(code, isIndex)}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=1&fqt=0&end=20500101&lmt=300`;
  const d = JSON.parse(await get(url, { referer: "https://quote.eastmoney.com/" })).data;
  if (!d || !Array.isArray(d.klines) || d.klines.length === 0) throw new Error("eastmoney kline empty");
  const rows = d.klines.map((s) => s.split(","));
  const date = rows[rows.length - 1][0].slice(0, 10);
  const bars = rows
    // 只保留连续竞价时段；科创板 15:05–15:30 的盘后固定价格交易不算盘中数据
    .filter((r) => r[0].startsWith(date) && r[0].slice(11, 16) <= "15:00")
    .map(([dt, o, c, h, l, v, a]) => {
      const close = num(c);
      const amount = num(a);
      return {
        t: dt.slice(11, 16),
        o: num(o),
        h: num(h),
        l: num(l),
        c: close,
        v: isIndex ? num(v) : toShares(num(v), amount, close),
        a: amount,
      };
    });
  return { date, prevClose: num(d.preKPrice), bars };
}

// 最近约 8 个交易日的 15 分钟 K 线（交易建议的动量和均线用）。
// 时间标签是这根 K 线的结束时间，例如 "09:45" 表示 9:30–9:45。
export async function em15Bars(code, limit = 128) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${emSecid(code)}` +
    `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&klt=15&fqt=0&end=20500101&lmt=${limit}`;
  const d = JSON.parse(await get(url, { referer: "https://quote.eastmoney.com/" })).data;
  if (!d || !Array.isArray(d.klines) || d.klines.length === 0) throw new Error("eastmoney 15m kline empty");
  return d.klines.map((s) => {
    const [dt, o, c, h, l, v] = s.split(",");
    return { d: dt.slice(0, 10), t: dt.slice(11, 16), o: num(o), h: num(h), l: num(l), c: num(c), v: scale(v, 100) };
  });
}

// 15 分钟 K 线备用源（腾讯，成交量单位按板块不同，这里不使用成交量）
export async function tencent15Bars(symbol, limit = 128) {
  const json = JSON.parse(await get(`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${symbol},m15,,${limit}`));
  const rows = json?.data?.[symbol]?.m15;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("tencent 15m kline empty");
  return rows.map(([dt, o, c, h, l]) => ({
    d: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`,
    t: `${dt.slice(8, 10)}:${dt.slice(10, 12)}`,
    o: num(o),
    h: num(h),
    l: num(l),
    c: num(c),
    v: null,
  }));
}

// 当日资金流向（累计值，单位：元）
export async function emFundFlow(code) {
  const url =
    `https://push2delay.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=0&klt=1&secid=${emSecid(code)}` +
    `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57`;
  const d = JSON.parse(await get(url, { referer: "https://data.eastmoney.com/" })).data;
  if (!d || !Array.isArray(d.klines) || d.klines.length === 0) throw new Error("eastmoney fund flow empty");
  return d.klines.map((s) => {
    const [dt, main, small, medium, large, superLarge] = s.split(",");
    return {
      t: dt.slice(11, 16),
      date: dt.slice(0, 10),
      main: num(main),
      superLarge: num(superLarge),
      large: num(large),
      medium: num(medium),
      small: num(small),
    };
  });
}

// ---------- 腾讯 ----------

// 一次请求同时拿个股和指数报价。返回 { [code]: quote }
export async function tencentQuotes(codes) {
  const symbols = codes.map((c) => c.symbol).join(",");
  const text = await get(`https://qt.gtimg.cn/q=${symbols}`, { encoding: "gbk" });
  const out = {};
  for (const line of text.split(";")) {
    const m = line.match(/v_(\w+)="([^"]*)"/);
    if (!m || !m[2]) continue;
    const f = m[2].split("~");
    const price = num(f[3]);
    const amount = scale(f[37], 10000); // 万元 → 元
    const volume = toShares(num(f[6]), amount, price);
    const volUnit = volume !== num(f[6]) ? 100 : 1;
    const book = (start) =>
      [0, 1, 2, 3, 4].map((i) => [num(f[start + i * 2]), scale(f[start + i * 2 + 1], 100)]); // 盘口量为手
    const t = f[30] || "";
    out[m[1]] = {
      name: f[1],
      price,
      prevClose: num(f[4]),
      open: num(f[5]),
      volume,
      outerVol: scale(f[7], volUnit),
      innerVol: scale(f[8], volUnit),
      change: num(f[31]),
      pct: num(f[32]),
      high: num(f[33]),
      low: num(f[34]),
      amount,
      turnover: num(f[38]),
      pe: num(f[39]),
      amplitude: num(f[43]),
      floatCap: scale(f[44], 1e8),
      totalCap: scale(f[45], 1e8),
      pb: num(f[46]),
      limitUp: num(f[47]),
      limitDown: num(f[48]),
      volumeRatio: num(f[49]),
      avgPrice: volume ? amount / volume : null,
      time: t.length === 14 ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}+08:00` : null,
      book: { bids: book(9), asks: book(19) },
    };
  }
  return out;
}

// 分时数据备用源。腾讯给的是累计量/额，这里换算成每分钟增量，
// 并把 09:30（集合竞价）和 13:00 并入下一分钟，与东方财富的 K 线时间标签对齐。
export async function tencentMinuteBars(symbol, isIndex = false) {
  const json = JSON.parse(await get(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`));
  const node = json?.data?.[symbol]?.data;
  if (!node || !Array.isArray(node.data) || node.data.length === 0) throw new Error("tencent minute empty");
  const date = `${node.date.slice(0, 4)}-${node.date.slice(4, 6)}-${node.date.slice(6, 8)}`;
  const bars = [];
  let prevVol = 0;
  let prevAmt = 0;
  let prevPrice = null;
  for (const row of node.data) {
    const [hhmm, p, cumVol, cumAmt] = row.split(" ");
    if (hhmm > "1500") break; // 盘后固定价格交易
    const price = num(p);
    if (hhmm === "0930" || hhmm === "1300") {
      prevPrice = price;
      continue;
    }
    const vol = num(cumVol) - prevVol;
    const amt = num(cumAmt) - prevAmt;
    prevVol = num(cumVol);
    prevAmt = num(cumAmt);
    const o = prevPrice ?? price;
    bars.push({
      t: `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`,
      o,
      h: Math.max(o, price),
      l: Math.min(o, price),
      c: price,
      v: isIndex ? vol : toShares(vol, amt, price),
      a: amt,
    });
    prevPrice = price;
  }
  return { date, prevClose: null, bars };
}

export const tencentSymbol = (code, isIndex = false) =>
  `${isIndex ? "sh" : marketOf(code)}${code}`;

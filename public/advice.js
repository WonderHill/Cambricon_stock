// 交易建议：5 个维度各打 −2 到 +2 分，相加得到 −10 到 +10 的综合分，再按持仓情况给出建议。
// 纯函数，不依赖 DOM。按分钟回放当天的数据：每一分钟只使用那一刻已经能看到的数据，
// 所以结论的确认、变化记录都可复现，刷新页面不会改变历史结论。

import { macd, rsi } from "./analysis.js";

export const MODES = {
  flat: "空仓",
  hold: "持仓",
  t: "底仓做T",
};
export const DEFAULT_SETTINGS = { mode: "flat", cost: null, stopPct: 3 };

const TH = 4; // |综合分| ≥ 4 才给出方向
const TH_OPEN = 6; // 9:45 前开盘波动大，门槛提高到 6
const CONFIRM = 2; // 新结论连续 2 分钟成立才切换
const LATE = "14:50"; // 此后不再建议新开仓（T+1）

const clamp = (x) => Math.max(-2, Math.min(2, x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

// ---------- 15 分钟指标 ----------

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function prep15(bars15) {
  const closes = bars15.map((b) => b.c);
  return {
    bars: bars15,
    macd: macd(closes),
    rsi: rsi(closes),
    ma5: sma(closes, 5),
    ma20: sma(closes, 20),
  };
}

// 截至 date 日 t 时刻已经走完的最后一根 15 分钟 K 线的下标
function makeK15Locator(k15, date) {
  return (t) => {
    let k = -1;
    for (let j = 0; j < k15.bars.length; j++) {
      const b = k15.bars[j];
      if (b.d < date || (b.d === date && b.t <= t)) k = j;
      else break;
    }
    return k;
  };
}

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : null;
}

// ---------- 单分钟打分 ----------
// withReasons=false 时只算分数（回放用），=true 时附带每一项的理由（当前分钟用）

function scoreAt(i, ctx, withReasons) {
  const { bars, closes, vols, vwap, cumA, k15, k15At, mainAt, benchAt, benchPrev } = ctx;
  const t = bars[i].t;
  const R = withReasons ? (list, s, text) => list.push({ s, text }) : () => {};
  const dims = [];

  // 1. 趋势和位置：均价线 + 15 分钟均线
  {
    const r = [];
    let s = 0;
    const dev = closes[i] / vwap[i] - 1;
    if (dev > 0.003) (s += 1), R(r, +1, `价格高于均价线 ${pct(dev)}`);
    else if (dev < -0.003) (s -= 1), R(r, -1, `价格低于均价线 ${pct(dev)}`);
    else R(r, 0, `价格贴近均价线（${pct(dev)}）`);
    if (Math.abs(dev) > 0.003) {
      const side = Math.sign(closes[i] - vwap[i]);
      let run = 0;
      for (let j = i; j >= 0 && Math.sign(closes[j] - vwap[j]) === side; j--) run++;
      if (run >= 15) (s += side), R(r, side, `已在均价线${side > 0 ? "上" : "下"}方持续 ${run} 分钟`);
    }
    const k = k15At[i];
    const m5 = k15.ma5[k];
    const m20 = k15.ma20[k];
    const m20p = k15.ma20[k - 1];
    if (k >= 0 && m5 != null && m20 != null && m20p != null) {
      if (m5 > m20 && m20 > m20p) (s += 1), R(r, +1, "15 分钟 MA5 在 MA20 上方，MA20 向上");
      else if (m5 < m20 && m20 < m20p) (s -= 1), R(r, -1, "15 分钟 MA5 在 MA20 下方，MA20 向下");
      else R(r, 0, "15 分钟均线方向不一致");
    }
    dims.push({ key: "trend", name: "趋势和位置", score: clamp(s), reasons: r });
  }

  // 2. 动量：15 分钟 MACD 和 RSI
  {
    const r = [];
    let s = 0;
    const k = k15At[i];
    if (k >= 26) {
      const dif = k15.macd.dif[k];
      const hist = k15.macd.hist[k];
      const h = Math.sign(hist);
      if (h !== 0) {
        s += h;
        R(r, h, `15 分钟 MACD ${h > 0 ? "DIF 在 DEA 上方" : "DIF 在 DEA 下方"}`);
        if (Math.sign(dif) === h) (s += h), R(r, h, `DIF ${h > 0 ? "在零轴上方" : "在零轴下方"}`);
      }
      const rv = k15.rsi[k];
      if (rv != null) {
        if (rv >= 75) (s -= 1), R(r, -1, `15 分钟 RSI ${rv.toFixed(0)}，超买，追高风险大`);
        else if (rv <= 25) (s += 1), R(r, +1, `15 分钟 RSI ${rv.toFixed(0)}，超卖，有反弹可能`);
        else R(r, 0, `15 分钟 RSI ${rv.toFixed(0)}`);
      }
    } else R(r, 0, "15 分钟 K 线不足，动量不计分");
    dims.push({ key: "momentum", name: "动量（15分钟）", score: clamp(s), reasons: r });
  }

  // 3. 量能：近 30 分钟量价配合 + 近 5 分钟放量方向
  {
    const r = [];
    let s = 0;
    let up = 0;
    let down = 0;
    for (let j = Math.max(1, i - 29); j <= i; j++) {
      if (closes[j] > closes[j - 1]) up += vols[j];
      else if (closes[j] < closes[j - 1]) down += vols[j];
    }
    if (i >= 10 && up + down > 0) {
      const ratio = (up - down) / (up + down);
      if (ratio > 0.2) (s += 1), R(r, +1, `近 30 分钟上涨时的成交量明显多于下跌时（差 ${(ratio * 100).toFixed(0)}%）`);
      else if (ratio < -0.2) (s -= 1), R(r, -1, `近 30 分钟下跌时的成交量明显多于上涨时（差 ${(-ratio * 100).toFixed(0)}%）`);
      else R(r, 0, "近 30 分钟涨跌时的成交量相当");
    }
    if (i >= 10) {
      const base = mean(vols.slice(1, i + 1));
      const v5 = mean(vols.slice(Math.max(1, i - 4), i + 1));
      const ch5 = closes[i] / closes[Math.max(0, i - 5)] - 1;
      if (base > 0 && v5 >= 2 * base && ch5 !== 0) {
        const d = Math.sign(ch5);
        s += d;
        R(r, d, `近 5 分钟放量 ${(v5 / base).toFixed(1)} 倍并${d > 0 ? "上涨" : "下跌"} ${pct(ch5)}`);
      }
    }
    if (i < 10) R(r, 0, "开盘不足 10 分钟，不计分");
    dims.push({ key: "volume", name: "量能", score: clamp(s), reasons: r });
  }

  // 4. 资金：主力净流入占成交额的比例（当日累计 + 近 30 分钟）
  {
    const r = [];
    let s = 0;
    const main = mainAt(t);
    if (main != null && cumA[i] > 0) {
      const dayRatio = main / cumA[i];
      if (dayRatio > 0.03) (s += 1), R(r, +1, `主力当日净流入，占成交额 ${pct(dayRatio)}`);
      else if (dayRatio < -0.03) (s -= 1), R(r, -1, `主力当日净流出，占成交额 ${pct(dayRatio)}`);
      else R(r, 0, `主力当日净流入占成交额 ${pct(dayRatio)}，不明显`);
      const j = Math.max(0, i - 30);
      const main0 = mainAt(bars[j].t);
      const amt30 = cumA[i] - cumA[j];
      if (i >= 10 && main0 != null && amt30 > 0) {
        const r30 = (main - main0) / amt30;
        if (r30 > 0.05) (s += 1), R(r, +1, `近 30 分钟主力净流入，占同期成交额 ${pct(r30)}`);
        else if (r30 < -0.05) (s -= 1), R(r, -1, `近 30 分钟主力净流出，占同期成交额 ${pct(r30)}`);
        else R(r, 0, `近 30 分钟主力净流入占同期成交额 ${pct(r30)}，不明显`);
      }
    } else R(r, 0, "没有资金流向数据，不计分");
    dims.push({ key: "flow", name: "资金", score: clamp(s), reasons: r });
  }

  // 5. 相对强弱：近 30 分钟跑赢/跑输指数；与指数同步时，把指数方向也算进来
  {
    const r = [];
    let s = 0;
    const j = Math.max(0, i - 30);
    const b1 = benchAt(t);
    const b0 = benchAt(bars[j].t);
    if (i >= 10 && b1 != null && b0 != null) {
      const sCh = closes[i] / closes[j] - 1;
      const bCh = b1 / b0 - 1;
      const ex = sCh - bCh;
      const name = ctx.benchName;
      if (ex > 0.005) (s += 1), R(r, +1, `近 30 分钟跑赢${name} ${(ex * 100).toFixed(2)} 个百分点`);
      else if (ex < -0.005) (s -= 1), R(r, -1, `近 30 分钟跑输${name} ${(-ex * 100).toFixed(2)} 个百分点`);
      else R(r, 0, `近 30 分钟与${name}走势接近`);

      const ra = [];
      const rb = [];
      for (let m = Math.max(2, i - 59); m <= i; m++) {
        const x0 = benchAt(bars[m - 1].t);
        const x1 = benchAt(bars[m].t);
        if (x0 && x1) ra.push(closes[m] / closes[m - 1] - 1), rb.push(x1 / x0 - 1);
      }
      const corr = correlation(ra, rb);
      if (corr != null && corr > 0.6) {
        if (bCh > 0.003) (s += 1), R(r, +1, `与${name}高度同步（相关 ${corr.toFixed(2)}），指数近 30 分钟上涨 ${pct(bCh)}`);
        else if (bCh < -0.003) (s -= 1), R(r, -1, `与${name}高度同步（相关 ${corr.toFixed(2)}），指数近 30 分钟下跌 ${pct(bCh)}`);
        else R(r, 0, `与${name}高度同步（相关 ${corr.toFixed(2)}），指数近 30 分钟横盘`);
      }
    } else R(r, 0, "指数数据不足，不计分");
    dims.push({ key: "relative", name: "相对强弱", score: clamp(s), reasons: r });
  }

  const total = dims.reduce((x, d) => x + d.score, 0);
  const th = t < "09:45" ? TH_OPEN : TH;
  const zone = total >= th ? 1 : total <= -th ? -1 : 0;
  return { total, zone, th, dims };
}

// ---------- 按持仓情况给出建议 ----------

function roundStep(p) {
  return p >= 500 ? 10 : p >= 100 ? 5 : p >= 20 ? 1 : 0.5;
}

function situation(i, ctx) {
  const { bars, closes, vwap, k15, k15At, quote } = ctx;
  let hi = -Infinity;
  let lo = Infinity;
  for (let j = 0; j <= i; j++) (hi = Math.max(hi, bars[j].h)), (lo = Math.min(lo, bars[j].l));
  let priorLow = null; // 15 分钟以前的日内最低价，跌破视为破位
  if (i >= 15) {
    priorLow = Infinity;
    for (let j = 0; j <= i - 15; j++) priorLow = Math.min(priorLow, bars[j].l);
  }
  const price = closes[i];
  const prev = quote?.prevClose ?? null;
  const k = k15At[i];
  return {
    t: bars[i].t,
    price,
    vwap: vwap[i],
    dev: price / vwap[i] - 1,
    hi,
    lo,
    priorLow,
    rangePos: hi > lo ? (price - lo) / (hi - lo) : 0.5,
    amplitude: prev ? (hi - lo) / prev : 0,
    prev,
    rsi15: k >= 0 ? k15.rsi[k] : null,
    ma20: k >= 0 ? k15.ma20[k] : null,
    limitUp: quote?.limitUp ?? null,
    limitDown: quote?.limitDown ?? null,
  };
}

function stopFor(sit, settings) {
  const out = [];
  if (settings.cost > 0) {
    out.push({ price: settings.cost * (1 - settings.stopPct / 100), why: `成本价下方 ${settings.stopPct}%` });
  }
  if (sit.priorLow != null) out.push({ price: sit.priorLow * 0.998, why: "跌破 15 分钟前的日内低点" });
  if (!out.length) return null;
  return out.reduce((a, b) => (b.price > a.price ? b : a)); // 取离现价更近（更高）的那个
}

// 返回 { key, text, tone, notes[] }。key 用来判断结论是否变化。
function decide(zone, sit, settings) {
  const notes = [];
  const late = sit.t >= LATE;
  const nearUp = sit.limitUp && sit.price >= sit.limitUp * 0.98;
  const nearDown = sit.limitDown && sit.price <= sit.limitDown * 1.02;
  const wide = sit.amplitude > 0.08;
  if (nearUp) notes.push("价格接近涨停价");
  if (nearDown) notes.push("价格接近跌停价，挂单可能难以成交");
  if (wide) notes.push(`日内振幅已达 ${(sit.amplitude * 100).toFixed(1)}%，波动很大`);
  if (sit.t < "09:45") notes.push("9:45 前开盘波动大，方向门槛提高到 ±6 分");

  if (settings.mode === "hold") {
    const stop = stopFor(sit, settings);
    if (stop && sit.price <= stop.price) {
      return { key: "stop", text: `触发止损（${stop.why}）`, why: stop.why, tone: "down", notes };
    }
    if (zone < 0) return { key: "reduce", text: "建议减仓", tone: "down", notes };
    if (zone > 0) return { key: "keep", text: "继续持有", tone: "up", notes };
    return { key: "watch", text: "持有观察", tone: "", notes };
  }

  if (settings.mode === "t") {
    if (late) notes.push("临近收盘：今天如果做过 T，记得把仓位还原");
    notes.push("做 T 一买一卖的成本约 0.1%–0.15%，差价小于这个就不划算");
    const stretchedUp = sit.rsi15 != null && sit.rsi15 >= 70 && sit.dev >= 0.015;
    const stretchedDown = sit.rsi15 != null && sit.rsi15 <= 30 && sit.dev <= -0.015;
    if (zone < 0 || stretchedUp) {
      const why = zone < 0 ? "综合偏空" : "15 分钟超买且价格高出均价线较多";
      return { key: "t-sell", text: `可高抛：先卖一部分底仓，回落后买回（${why}）`, tone: "down", notes };
    }
    if ((zone > 0 && sit.dev <= 0.005) || stretchedDown) {
      const why = zone > 0 ? "综合偏多且价格不高于均价线太多" : "15 分钟超卖且价格低于均价线较多";
      return { key: "t-buy", text: `可低吸：先买一部分，冲高后卖出原有底仓（${why}）`, tone: "up", notes };
    }
    if (zone > 0) return { key: "t-wait", text: "偏多，但价格已高出均价线，等回踩再低吸", tone: "", notes };
    return { key: "watch", text: "观望", tone: "", notes };
  }

  // 空仓
  if (zone > 0) {
    if (late) return { key: "late", text: "偏多，但 14:50 后不建议新开仓（T+1，今天买入明天才能卖）", tone: "", notes };
    if (nearUp || (wide && sit.rangePos > 0.8)) {
      return { key: "nochase", text: "偏多，但涨幅或振幅已经很大，不追高", tone: "", notes };
    }
    return { key: "buy", text: "可考虑买入", tone: "up", notes };
  }
  if (zone < 0) return { key: "avoid", text: "不宜买入", tone: "down", notes };
  return { key: "watch", text: "观望", tone: "", notes };
}

// ---------- 支撑、压力 ----------

function levels(sit) {
  const step = roundStep(sit.price);
  const below = Math.floor(sit.price / step) * step;
  const cands = [
    { price: sit.vwap, why: "均价线" },
    { price: sit.hi, why: "日内高点" },
    { price: sit.lo, why: "日内低点" },
    { price: below === sit.price ? below - step : below, why: "整数关口" },
    { price: below + step, why: "整数关口" },
  ];
  if (sit.prev) cands.push({ price: sit.prev, why: "昨收" });
  if (sit.ma20) cands.push({ price: sit.ma20, why: "15 分钟 MA20" });
  const near = (list, asc) =>
    list
      .sort((a, b) => (asc ? a.price - b.price : b.price - a.price))
      .filter((x, idx, arr) => idx === 0 || Math.abs(x.price - arr[idx - 1].price) / sit.price > 0.001)
      .slice(0, 2);
  const eps = sit.price * 0.0005;
  return {
    support: near(cands.filter((c) => c.price < sit.price - eps), false),
    resistance: near(cands.filter((c) => c.price > sit.price + eps), true),
  };
}

// ---------- 主入口 ----------

export function advise(snap, analysis, settings = DEFAULT_SETTINGS) {
  const bars = snap.bars || [];
  // 交易中最后一根分钟 K 线还没走完，不参与
  const n = snap.session?.state === "open" ? bars.length - 1 : bars.length;
  if (n < 2) return { ready: false, message: "分钟数据太少，开盘几分钟后才会给出建议" };

  const closes = bars.map((b) => b.c);
  const vols = bars.map((b) => b.v || 0);
  const cumA = [];
  bars.reduce((s, b, i) => (cumA[i] = s + (b.a || 0)), 0);

  const date = snap.tradeDate;
  const k15 = prep15((snap.bars15 || []).filter((b) => b.c != null));
  const locate = makeK15Locator(k15, date);
  const k15At = bars.map((b) => locate(b.t));

  const flowMap = new Map((snap.flow || []).map((f) => [f.t, f.main]));
  const benchMap = new Map((snap.benchmark?.bars || []).map((b) => [b.t, b.c]));

  const ctx = {
    bars,
    closes,
    vols,
    vwap: analysis.series.vwap,
    cumA,
    k15,
    k15At,
    mainAt: (t) => flowMap.get(t) ?? null,
    benchAt: (t) => benchMap.get(t) ?? null,
    benchName: snap.benchmark?.name || "指数",
    quote: snap.quote,
  };

  // 逐分钟回放，确认结论变化
  let state = null; // 已确认的结论
  let since = 0;
  let cand = null;
  let candFrom = 0;
  let candCount = 0;
  const changes = [];
  for (let i = 1; i < n; i++) {
    const sc = scoreAt(i, ctx, false);
    const sit = situation(i, ctx);
    const d = decide(sc.zone, sit, settings);
    // 止损触发后当天锁定，不因价格反弹而撤销；不需要等待确认
    if (state?.key === "stop") continue;
    if (d.key === "stop") {
      state = { ...d, text: `已触发止损：${bars[i].t} 价格 ${sit.price.toFixed(2)}，${d.why}` };
      since = i;
      changes.push({ t: bars[i].t, text: state.text, tone: d.tone, score: sc.total });
      cand = null;
      continue;
    }
    if (state === null) {
      state = d;
      since = i;
      changes.push({ t: bars[i].t, text: d.text, tone: d.tone, score: sc.total });
      continue;
    }
    if (d.key === state.key) {
      cand = null;
      continue;
    }
    if (!cand || cand.key !== d.key) (cand = d), (candFrom = i), (candCount = 0);
    if (++candCount >= CONFIRM) {
      state = cand;
      since = candFrom;
      changes.push({ t: bars[candFrom].t, text: cand.text, tone: cand.tone, score: sc.total });
      cand = null;
    }
  }

  const last = n - 1;
  const now = scoreAt(last, ctx, true);
  const sit = situation(last, ctx);
  const current = decide(now.zone, sit, settings); // 用来展示最新的提示
  const lv = levels(sit);
  const stop = settings.mode === "hold" ? stopFor(sit, settings) : null;

  const notes = [...current.notes];
  if (state.key === "stop") notes.unshift("止损触发后今天不再撤销。如果没有卖出，请自行判断是否仍要持有");
  else if (cand && cand.key !== state.key) notes.unshift(`结论可能转为“${cand.text}”，等待下一分钟确认`);
  if (!snap.flow?.length) notes.push("缺少资金流向数据，“资金”一项按 0 分计");
  if (!k15.bars.length) notes.push("缺少 15 分钟 K 线，趋势和动量只用了分钟数据");
  if (settings.mode === "hold" && !(settings.cost > 0)) notes.push("填入成本价后，止损位会同时参考成本价");

  return {
    ready: true,
    time: bars[last].t,
    since: bars[since].t,
    decision: { key: state.key, text: state.text, tone: state.tone },
    score: now.total,
    threshold: now.th,
    dims: now.dims,
    price: sit.price,
    levels: lv,
    stop,
    notes,
    changes,
  };
}

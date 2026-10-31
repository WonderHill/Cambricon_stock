// 盘中指标与信号。纯函数，输入 /api/snapshot 的数据，不依赖 DOM。

export function vwapSeries(bars) {
  let cumV = 0;
  let cumA = 0;
  return bars.map((b) => {
    cumV += b.v || 0;
    cumA += b.a || 0;
    return cumV > 0 ? cumA / cumV : b.c;
  });
}

export function ema(values, n) {
  const k = 2 / (n + 1);
  const out = [];
  let prev = null;
  for (const v of values) {
    prev = prev === null ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// 国内软件惯例：柱 = 2 × (DIF − DEA)
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const dif = closes.map((_, i) => ef[i] - es[i]);
  const dea = ema(dif, signal);
  return { dif, dea, hist: dif.map((d, i) => 2 * (d - dea[i])) };
}

// Wilder RSI，前 n 根为 null
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

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

// ---------- 主分析 ----------

export function analyze(snap) {
  const bars = snap.bars || [];
  const q = snap.quote || {};
  const closes = bars.map((b) => b.c);
  const vols = bars.map((b) => b.v || 0);
  const vwap = vwapSeries(bars);
  const m = macd(closes);
  const r = rsi(closes);
  const last = bars.length - 1;

  const prevClose = q.prevClose ?? null;
  const price = q.price ?? closes[last] ?? null;
  const vwapNow = q.avgPrice ?? vwap[last] ?? null;

  // 对齐指数分钟线
  const bench = snap.benchmark || {};
  const benchMap = new Map((bench.bars || []).map((b) => [b.t, b.c]));
  const stockPct = bars.map((b) => (prevClose ? (b.c / prevClose - 1) * 100 : null));
  const benchPct = bars.map((b) => {
    const c = benchMap.get(b.t);
    return c != null && bench.prevClose ? (c / bench.prevClose - 1) * 100 : null;
  });

  // 分钟收益相关性（排除首根含集合竞价的 K 线）
  const ra = [];
  const rb = [];
  for (let i = 2; i < bars.length; i++) {
    const b0 = benchMap.get(bars[i - 1].t);
    const b1 = benchMap.get(bars[i].t);
    if (b0 && b1) {
      ra.push(closes[i] / closes[i - 1] - 1);
      rb.push(b1 / b0 - 1);
    }
  }

  // 资金流对齐
  const flow = snap.flow || [];
  const flowMap = new Map(flow.map((f) => [f.t, f]));
  const mainAt = (t) => flowMap.get(t)?.main ?? null;

  const baseVol = mean(vols.slice(1)); // 首根含集合竞价，排除
  const lastN = (n) => vols.slice(Math.max(1, bars.length - n));
  const back = (n) => bars[Math.max(0, last - n)];

  const metrics = {
    price,
    pct: q.pct ?? (prevClose && price ? (price / prevClose - 1) * 100 : null),
    vwap: vwapNow,
    devVwap: price && vwapNow ? (price / vwapNow - 1) * 100 : null,
    rsi: r[last] ?? null,
    dif: m.dif[last] ?? null,
    dea: m.dea[last] ?? null,
    hist: m.hist[last] ?? null,
    vol5x: baseVol && bars.length > 6 ? mean(lastN(5)) / baseVol : null,
    rangePos:
      q.high != null && q.low != null && q.high > q.low && price != null
        ? ((price - q.low) / (q.high - q.low)) * 100
        : null,
    trend30: bars.length > 1 ? (closes[last] / back(30).c - 1) * 100 : null,
    benchPct: bench.pct ?? benchPct[last] ?? null,
    excess: null,
    corr: correlation(ra, rb),
    mainFlow: flow.length ? flow[flow.length - 1].main : null,
    mainFlow30:
      flow.length > 1 ? flow[flow.length - 1].main - flow[Math.max(0, flow.length - 31)].main : null,
    activeBuy:
      q.outerVol != null && q.innerVol != null && q.outerVol + q.innerVol > 0
        ? (q.outerVol / (q.outerVol + q.innerVol)) * 100
        : null,
    volumeRatio: q.volumeRatio ?? null,
    amplitude:
      q.amplitude ?? (q.high != null && q.low != null && prevClose ? ((q.high - q.low) / prevClose) * 100 : null),
  };
  if (metrics.pct != null && metrics.benchPct != null) metrics.excess = metrics.pct - metrics.benchPct;

  // 交易中最后一根 K 线还没走完，不参与信号判断，避免信号出现后又消失
  const complete = snap.session?.state === "open" ? bars.length - 1 : bars.length;
  const signals = detectSignals({ n: complete, bars, closes, vols, vwap, m, r, stockPct, benchPct, mainAt, benchName: bench.name });

  return {
    series: { vwap, stockPct, benchPct, macd: m, rsi: r },
    metrics,
    signals,
    summary: summarize(metrics, bench.name || "大盘", snap.session?.state),
  };
}

// ---------- 信号 ----------

function detectSignals({ n, bars, closes, vols, vwap, m, r, stockPct, benchPct, mainAt, benchName }) {
  const out = [];
  const add = (i, type, text, tone) => out.push({ i, t: bars[i].t, type, text, tone });

  // 事件类信号（放量、新高新低、RSI）：同类至少间隔 10 分钟，避免刷屏
  const GAP = 10;
  const lastAt = {};
  const event = (i, type, text, tone) => {
    if (lastAt[type] != null && i - lastAt[type] < GAP) return;
    lastAt[type] = i;
    add(i, type, text, tone);
  };

  // 交叉类信号（均价线、MACD、主力资金、相对强弱）：新状态连续保持 CONFIRM 分钟才算数，
  // 过滤来回穿越的噪音；信号时间记在开始穿越的那一分钟。
  const CONFIRM = 2;
  const cs = {};
  const cross = (i, type, side, onUp, onDown) => {
    if (!side) return;
    const c = (cs[type] ??= { state: null, cand: null, from: 0, count: 0 });
    if (c.state === null) {
      c.state = side;
      return;
    }
    if (side === c.state) {
      c.cand = null;
      return;
    }
    if (c.cand !== side) {
      c.cand = side;
      c.from = i;
      c.count = 0;
    }
    if (++c.count >= CONFIRM) {
      c.state = side;
      c.cand = null;
      const [text, tone] = side > 0 ? onUp(c.from) : onDown(c.from);
      add(c.from, type, text, tone);
    }
  };
  const sgn = (x) => (x == null || Number.isNaN(x) || x === 0 ? 0 : x > 0 ? 1 : -1);

  let hi = bars[0]?.h ?? -Infinity;
  let lo = bars[0]?.l ?? Infinity;

  for (let i = 1; i < n; i++) {
    const b = bars[i];

    cross(i, "vwap", sgn(closes[i] - vwap[i]), () => ["上穿均价线", "up"], () => ["跌破均价线", "down"]);

    if (i >= 26) {
      cross(
        i,
        "macd",
        sgn(m.dif[i] - m.dea[i]),
        (j) => [`MACD 金叉${m.dif[j] > 0 ? "（零轴上）" : ""}`, "up"],
        (j) => [`MACD 死叉${m.dif[j] < 0 ? "（零轴下）" : ""}`, "down"],
      );
    }

    cross(i, "flow", sgn(mainAt(b.t)), () => ["主力资金转为净流入", "up"], () => ["主力资金转为净流出", "down"]);

    if (stockPct[i] != null && benchPct[i] != null) {
      cross(i, "rel", sgn(stockPct[i] - benchPct[i]), () => [`转为跑赢${benchName}`, "up"], () => [`转为跑输${benchName}`, "down"]);
    }

    if (i >= 10) {
      const base = mean(vols.slice(Math.max(1, i - 30), i));
      if (base > 0 && vols[i] >= 3 * base) {
        const up = closes[i] >= closes[i - 1];
        event(i, "vol", `放量${up ? "上涨" : "下跌"}（${(vols[i] / base).toFixed(1)} 倍）`, up ? "up" : "down");
      }
    }

    if (r[i - 1] != null && r[i] != null) {
      if (r[i - 1] < 70 && r[i] >= 70) event(i, "rsi", "RSI 进入超买区（≥70）", "neutral");
      else if (r[i - 1] > 30 && r[i] <= 30) event(i, "rsi", "RSI 进入超卖区（≤30）", "neutral");
    }

    if (i >= 15 && b.h > hi) event(i, "high", "创日内新高", "up");
    if (i >= 15 && b.l < lo) event(i, "low", "创日内新低", "down");
    hi = Math.max(hi, b.h);
    lo = Math.min(lo, b.l);
  }
  // 交叉信号按开始时间记录，可能比事件信号晚加入，这里统一按时间排序
  return out.sort((a, b) => a.i - b.i);
}

// ---------- 文字解读（规则生成） ----------

const f2 = (x) => Math.abs(x).toFixed(2);

function summarize(mt, benchName, state) {
  const s = [];
  if (mt.devVwap != null) {
    if (mt.devVwap > 0.3) s.push(`价格在均价线上方 ${f2(mt.devVwap)}%，今天买入的资金整体浮盈，日内多方占优。`);
    else if (mt.devVwap < -0.3) s.push(`价格在均价线下方 ${f2(mt.devVwap)}%，今天买入的资金整体浮亏，日内空方占优。`);
    else s.push("价格贴着均价线运行，多空暂时平衡。");
  }
  if (mt.trend30 != null) {
    if (mt.trend30 > 0.5) s.push(`近 30 分钟上涨 ${f2(mt.trend30)}%。`);
    else if (mt.trend30 < -0.5) s.push(`近 30 分钟下跌 ${f2(mt.trend30)}%。`);
    else s.push(`近 30 分钟基本横盘（${mt.trend30 >= 0 ? "+" : "-"}${f2(mt.trend30)}%）。`);
  }
  if (mt.excess != null) {
    let t =
      mt.excess > 1
        ? `强于${benchName} ${f2(mt.excess)} 个百分点`
        : mt.excess < -1
          ? `弱于${benchName} ${f2(mt.excess)} 个百分点`
          : `与${benchName}涨跌幅接近（差 ${mt.excess >= 0 ? "+" : "-"}${f2(mt.excess)} 个百分点）`;
    if (mt.corr != null && mt.corr > 0.6) t += `，分钟级走势与指数高度同步（相关系数 ${mt.corr.toFixed(2)}），主要受板块/大盘带动`;
    else if (mt.corr != null && mt.corr < 0.3) t += `，分钟级走势与指数关联弱（相关系数 ${mt.corr.toFixed(2)}），个股因素为主`;
    s.push(t + "。");
  }
  if (mt.mainFlow != null) {
    let t = `主力资金累计净${mt.mainFlow >= 0 ? "流入" : "流出"} ${money(Math.abs(mt.mainFlow))}`;
    if (mt.mainFlow30 != null) t += `，近 30 分钟净${mt.mainFlow30 >= 0 ? "流入" : "流出"} ${money(Math.abs(mt.mainFlow30))}`;
    s.push(t + "。");
  }
  if (mt.volumeRatio != null) {
    const v =
      mt.volumeRatio >= 1.5 ? "明显放量" : mt.volumeRatio <= 0.8 ? "缩量" : "量能正常";
    let t = `量比 ${mt.volumeRatio.toFixed(2)}，${v}`;
    if (mt.activeBuy != null) t += `；主动买入占 ${mt.activeBuy.toFixed(1)}%`;
    s.push(t + "。");
  }
  if (mt.rsi != null) {
    if (mt.rsi >= 70) s.push(`1 分钟 RSI ${mt.rsi.toFixed(0)}，短线超买。`);
    else if (mt.rsi <= 30) s.push(`1 分钟 RSI ${mt.rsi.toFixed(0)}，短线超卖。`);
  }
  if (state === "closed") s.push("当前已收盘，以上为当日最终数据。");
  return s;
}

export function money(v) {
  if (v == null || Number.isNaN(v)) return "--";
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(0)} 万`;
  return v.toFixed(0);
}

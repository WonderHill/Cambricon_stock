import { advise, DEFAULT_SETTINGS, MODES } from "./advice.js";
import { analyze, money } from "./analysis.js";

const { createChart, LineSeries, HistogramSeries, createSeriesMarkers, LineStyle, CrosshairMode } =
  window.LightweightCharts;

const params = new URLSearchParams(location.search);
const CODE = /^\d{6}$/.test(params.get("code") || "") ? params.get("code") : "688256";
const REFRESH_SEC = { open: 60, pre: 60, lunch: 300, closed: 600 };
const SESSION_TEXT = { open: "交易中", pre: "集合竞价", lunch: "午间休市", closed: "已收盘 / 休市" };
const C = {
  up: "#f04848",
  down: "#22b35e",
  upA: "rgba(240,72,72,0.65)",
  downA: "rgba(34,179,94,0.65)",
  vwap: "#f5c542",
  price: "#e6e8ee",
  accent: "#4c8dff",
  grid: "#1c212b",
  text: "#8a93a6",
  border: "#262b36",
};

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");

// ---------- 格式化 ----------

const fp = (v, d = 2) => (v == null || Number.isNaN(v) ? "--" : Number(v).toFixed(d));
const sign = (v) => (v > 0 ? "+" : "");
const fpct = (v, d = 2) => (v == null || Number.isNaN(v) ? "--" : `${sign(v)}${v.toFixed(d)}%`);
const tone = (v, base = 0) => (v == null || base == null ? "" : v > base ? "up" : v < base ? "down" : "");
function fvol(v) {
  if (v == null || Number.isNaN(v)) return "--";
  const a = Math.abs(v);
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)} 亿股`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(1)} 万股`;
  return `${v.toFixed(0)} 股`;
}
const bjTime = (iso) => {
  if (!iso) return "--";
  const d = new Date(new Date(iso).getTime() + 8 * 3600e3);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c ?? "");
  return node;
}

// ---------- 时间轴 ----------
// 把北京时间的“墙上时间”当作 UTC 时间戳交给图表，图表按 UTC 显示即为北京时间。

const toTs = (date, hm) => {
  const [y, m, d] = date.split("-").map(Number);
  const [H, M] = hm.split(":").map(Number);
  return Date.UTC(y, m - 1, d, H, M) / 1000;
};
const GRID = (() => {
  const out = [];
  const add = (from, to) => {
    for (let x = from; x <= to; x++) out.push(`${pad(Math.floor(x / 60))}:${pad(x % 60)}`);
  };
  add(9 * 60 + 31, 11 * 60 + 30);
  add(13 * 60 + 1, 15 * 60);
  return out;
})();
const fmtTs = (t) => {
  const d = new Date(t * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

// ---------- 图表 ----------

function chartOptions() {
  return {
    autoSize: true,
    layout: {
      background: { color: "transparent" },
      textColor: C.text,
      fontSize: 11,
      attributionLogo: true,
      panes: { separatorColor: C.border },
    },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.border },
    timeScale: {
      borderColor: C.border,
      timeVisible: true,
      secondsVisible: false,
      fixLeftEdge: true,
      tickMarkFormatter: fmtTs,
    },
    crosshair: { mode: CrosshairMode.Normal },
    localization: { locale: "zh-CN", timeFormatter: fmtTs },
  };
}

let symRange = null; // 纵轴范围：覆盖当日高低点和昨收
const mainChart = createChart($("chart-main"), chartOptions());
const priceS = mainChart.addSeries(LineSeries, {
  color: C.price,
  lineWidth: 2,
  priceLineVisible: false,
  autoscaleInfoProvider: (orig) => symRange ?? orig(),
});
const vwapS = mainChart.addSeries(LineSeries, {
  color: C.vwap,
  lineWidth: 1,
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
  autoscaleInfoProvider: (orig) => symRange ?? orig(),
});
const volS = mainChart.addSeries(
  HistogramSeries,
  { priceFormat: { type: "custom", formatter: fvol }, priceLineVisible: false, lastValueVisible: false },
  1,
);
mainChart.panes()[0].setStretchFactor(3);
mainChart.panes()[1].setStretchFactor(1);
const markers = createSeriesMarkers(priceS, []);
let prevCloseLine = null;

const pctFormat = { type: "custom", formatter: (v) => `${v.toFixed(2)}%` };
const relChart = createChart($("chart-rel"), chartOptions());
const relStock = relChart.addSeries(LineSeries, { color: C.price, lineWidth: 2, priceFormat: pctFormat, priceLineVisible: false });
const relBench = relChart.addSeries(LineSeries, { color: C.accent, lineWidth: 1, priceFormat: pctFormat, priceLineVisible: false });
relStock.createPriceLine({ price: 0, color: C.text, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });

const moneyFormat = { type: "custom", formatter: (v) => money(v) };
const flowChart = createChart($("chart-flow"), chartOptions());
const FLOW_LINES = [
  ["main", "主力", "#ff9f43", 2],
  ["superLarge", "超大单", "#c56cf0", 1],
  ["large", "大单", "#4c8dff", 1],
  ["medium", "中单", "#8a93a6", 1],
  ["small", "小单", "#5eead4", 1],
];
const flowSeries = FLOW_LINES.map(([key, title, color, lineWidth]) => [
  key,
  flowChart.addSeries(LineSeries, { color, lineWidth, title, priceFormat: moneyFormat, priceLineVisible: false, lastValueVisible: key === "main" }),
]);
flowSeries[0][1].createPriceLine({ price: 0, color: C.text, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });

// 三张图的横轴联动
const charts = [mainChart, relChart, flowChart];
let syncing = false;
for (const c of charts) {
  c.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (syncing || !range) return;
    syncing = true;
    for (const o of charts) if (o !== c) o.timeScale().setVisibleLogicalRange(range);
    syncing = false;
  });
}

// ---------- 渲染 ----------

let state = { snap: null, analysis: null, renderedDate: null };

function renderCharts(snap, a) {
  const bars = snap.bars;
  const date = snap.tradeDate || new Date().toISOString().slice(0, 10);
  const prev = snap.quote?.prevClose ?? null;
  const flow = snap.flow || [];

  const tset = new Set(GRID);
  bars.forEach((b) => tset.add(b.t));
  flow.forEach((f) => tset.add(f.t));
  const times = [...tset].sort();
  const fill = (map) => times.map((t) => (map.has(t) ? { time: toTs(date, t), value: map.get(t) } : { time: toTs(date, t) }));
  const idx = new Map(bars.map((b, i) => [b.t, i]));
  const byBar = (arr) => new Map(bars.map((b, i) => [b.t, arr[i]]).filter(([, v]) => v != null));

  // 纵轴始终包含昨收，便于看清相对昨收的位置
  if (prev && bars.length) {
    const hi = Math.max(prev, ...bars.map((b) => b.c), ...a.series.vwap);
    const lo = Math.min(prev, ...bars.map((b) => b.c), ...a.series.vwap);
    const padding = Math.max(hi - lo, prev * 0.005) * 0.06;
    symRange = { priceRange: { minValue: lo - padding, maxValue: hi + padding } };
  } else symRange = null;

  priceS.setData(fill(byBar(bars.map((b) => b.c))));
  vwapS.setData(fill(byBar(a.series.vwap)));
  volS.setData(
    times.map((t) => {
      const time = toTs(date, t);
      const i = idx.get(t);
      if (i == null) return { time };
      const ref = i > 0 ? bars[i - 1].c : (prev ?? bars[i].o);
      return { time, value: bars[i].v, color: bars[i].c >= ref ? C.upA : C.downA };
    }),
  );

  if (prevCloseLine) priceS.removePriceLine(prevCloseLine);
  prevCloseLine = prev
    ? priceS.createPriceLine({ price: prev, color: C.text, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "昨收" })
    : null;

  // 图上只标关键信号，完整列表在右侧“信号”卡片
  const SHORT = { vwap: "均", vol: "量", flow: "资" };
  markers.setMarkers(
    a.signals.filter((s) => SHORT[s.type]).slice(-20).map((s) => ({
      time: toTs(date, s.t),
      position: s.tone === "down" ? "aboveBar" : "belowBar",
      color: s.tone === "up" ? C.up : s.tone === "down" ? C.down : C.vwap,
      shape: s.tone === "up" ? "arrowUp" : s.tone === "down" ? "arrowDown" : "circle",
      text: SHORT[s.type] || "",
      size: 0.8,
    })),
  );

  relStock.applyOptions({ title: snap.name });
  relBench.applyOptions({ title: snap.benchmark?.name || "指数" });
  relStock.setData(fill(byBar(a.series.stockPct)));
  relBench.setData(fill(byBar(a.series.benchPct)));

  for (const [key, series] of flowSeries) {
    series.setData(fill(new Map(flow.filter((f) => f[key] != null).map((f) => [f.t, f[key]]))));
  }

  // 横轴固定显示全天 9:30–15:00（未来时段为空白），换日时重置
  if (state.renderedDate !== date) {
    const range = { from: 0, to: times.length - 1 };
    requestAnimationFrame(() => charts.forEach((c) => c.timeScale().setVisibleLogicalRange(range)));
    state.renderedDate = date;
  }
}

// 十字光标图例
mainChart.subscribeCrosshairMove((param) => updateLegend(param));
function updateLegend(param) {
  const snap = state.snap;
  if (!snap || !snap.bars.length) return;
  let i = snap.bars.length - 1;
  if (param?.time) {
    const t = fmtTs(param.time);
    const j = snap.bars.findIndex((b) => b.t === t);
    if (j < 0) return;
    i = j;
  }
  const b = snap.bars[i];
  const prev = snap.quote?.prevClose;
  const v = state.analysis.series.vwap[i];
  const pct = prev ? (b.c / prev - 1) * 100 : null;
  const legend = $("legend");
  legend.replaceChildren(
    `${b.t}　价 `,
    el("span", { class: tone(b.c, prev) }, fp(b.c)),
    "　",
    el("span", { class: tone(pct) }, fpct(pct)),
    `　均价 ${fp(v)}　量 ${fvol(b.v)}　额 ${money(b.a)}`,
  );
}

function renderHeader(snap) {
  const q = snap.quote || {};
  const market = snap.code.startsWith("688") ? "科创板" : snap.code.startsWith("6") ? "沪市" : "深市";
  $("name").textContent = snap.name;
  $("code").textContent = `${snap.code} · ${market}`;
  $("price").textContent = fp(q.price);
  $("price").className = `price ${tone(q.price, q.prevClose)}`;
  $("change").textContent = `${sign(q.change)}${fp(q.change)}　${fpct(q.pct)}`;
  $("change").className = `change ${tone(q.pct)}`;
  const st = snap.session?.state || "closed";
  $("session").textContent = SESSION_TEXT[st];
  $("session").className = `pill ${st}`;
  const today = snap.session?.beijingTime?.slice(0, 10);
  $("data-time").textContent =
    `行情时间 ${snap.tradeDate && snap.tradeDate !== today ? snap.tradeDate + " " : ""}${bjTime(q.time)}`;
  document.title = `${snap.name} ${fp(q.price)} ${fpct(q.pct)}`;
}

function dl(target, rows) {
  $(target).replaceChildren(
    ...rows.map(([label, value, cls = "", title]) => {
      const div = el("div", title ? { title } : {}, el("dt", {}, label), el("dd", { class: cls }, value));
      return div;
    }),
  );
}

function renderStats(snap) {
  const q = snap.quote || {};
  const p = q.prevClose;
  dl("stats", [
    ["今开", fp(q.open), tone(q.open, p)],
    ["昨收", fp(p)],
    ["最高", fp(q.high), tone(q.high, p)],
    ["最低", fp(q.low), tone(q.low, p)],
    ["均价", fp(q.avgPrice), tone(q.avgPrice, p)],
    ["振幅", q.amplitude != null ? `${fp(q.amplitude)}%` : "--"],
    ["成交量", fvol(q.volume)],
    ["成交额", money(q.amount)],
    ["换手率", q.turnover != null ? `${fp(q.turnover)}%` : "--"],
    ["量比", fp(q.volumeRatio)],
    ["外盘", fvol(q.outerVol), "up", "主动买入成交量"],
    ["内盘", fvol(q.innerVol), "down", "主动卖出成交量"],
    ["涨停", fp(q.limitUp), "up"],
    ["跌停", fp(q.limitDown), "down"],
    ["总市值", money(q.totalCap)],
    ["流通市值", money(q.floatCap)],
    ["市盈率(动)", fp(q.pe)],
    ["市净率", fp(q.pb)],
  ]);
}

function renderMetrics(snap, a) {
  const m = a.metrics;
  const bn = snap.benchmark?.name || "指数";
  const macdState = m.dif == null ? "--" : `${m.dif > m.dea ? "多" : "空"} ${fp(m.dif)}/${fp(m.dea)}`;
  dl("metrics", [
    ["偏离均价", fpct(m.devVwap), tone(m.devVwap), "现价相对当日成交均价(VWAP)"],
    ["日内位置", m.rangePos != null ? `${fp(m.rangePos, 0)}%` : "--", "", "0% = 日内最低，100% = 日内最高"],
    ["近30分钟", fpct(m.trend30), tone(m.trend30)],
    ["近5分钟量能", m.vol5x != null ? `${fp(m.vol5x, 1)} 倍` : "--", m.vol5x >= 2 ? "up" : "", "近 5 分钟均量 ÷ 当日每分钟均量"],
    ["RSI(14)", fp(m.rsi, 0), m.rsi >= 70 ? "up" : m.rsi <= 30 ? "down" : "", "1 分钟 K 线"],
    ["MACD", macdState, m.dif == null ? "" : m.dif > m.dea ? "up" : "down", "1 分钟 K 线，DIF/DEA"],
    [bn, fpct(m.benchPct), tone(m.benchPct)],
    [`相对${bn}`, m.excess != null ? `${sign(m.excess)}${fp(m.excess)} pp` : "--", tone(m.excess), "个股涨跌幅 − 指数涨跌幅（百分点）"],
    ["与指数相关", fp(m.corr), "", "当日 1 分钟收益率的相关系数"],
    ["主力净流入", money(m.mainFlow), tone(m.mainFlow)],
    ["近30分钟主力", money(m.mainFlow30), tone(m.mainFlow30)],
    ["主动买入占比", m.activeBuy != null ? `${fp(m.activeBuy, 1)}%` : "--", tone(m.activeBuy, 50), "外盘 ÷ (外盘 + 内盘)"],
  ]);
}

function renderBook(book, prev) {
  const table = $("book");
  if (!book) {
    table.replaceChildren(el("tr", {}, el("td", { class: "muted" }, "盘口数据不可用")));
    return;
  }
  const row = (label, [p, v]) => el("tr", {}, el("td", { class: "muted" }, label), el("td", { class: tone(p, prev) }, fp(p)), el("td", {}, v != null ? v.toLocaleString("zh-CN") : "--"));
  const asks = book.asks.map((x, i) => row(`卖${i + 1}`, x)).reverse();
  const bids = book.bids.map((x, i) => row(`买${i + 1}`, x));
  table.replaceChildren(...asks, el("tr", { class: "sep" }, el("td", { colspan: "3" })), ...bids);
}

let seenSignals = null; // 首次加载的信号不提醒
function renderSignals(snap, a) {
  const keyOf = (s) => `${snap.code}|${snap.tradeDate}|${s.t}|${s.type}`;
  const fresh = [];
  if (seenSignals) for (const s of a.signals) if (!seenSignals.has(keyOf(s))) fresh.push(s);
  seenSignals = new Set(a.signals.map(keyOf));
  const freshKeys = new Set(fresh.map(keyOf));

  const list = $("signals");
  if (!a.signals.length) {
    list.replaceChildren(el("li", { class: "muted" }, "暂无信号"));
  } else {
    list.replaceChildren(
      ...a.signals
        .slice()
        .reverse()
        .map((s) =>
          el("li", freshKeys.has(keyOf(s)) ? { class: "fresh" } : {}, el("span", { class: "t" }, s.t), el("span", { class: s.tone === "neutral" ? "" : s.tone }, s.text)),
        ),
    );
  }

  if (fresh.length && "Notification" in window && Notification.permission === "granted") {
    const q = snap.quote || {};
    new Notification(`${snap.name} ${fp(q.price)} ${fpct(q.pct)}`, {
      body: fresh.map((s) => `${s.t} ${s.text}`).join("\n"),
      tag: `signal-${snap.code}`,
    });
  }
}

// ---------- 交易建议 ----------

const SETTINGS_KEY = `advice-settings-${CODE}`;
function loadSettings() {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      mode: MODES[v.mode] ? v.mode : DEFAULT_SETTINGS.mode,
      cost: v.cost > 0 ? Number(v.cost) : null,
      stopPct: v.stopPct > 0 && v.stopPct <= 20 ? Number(v.stopPct) : DEFAULT_SETTINGS.stopPct,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
let settings = loadSettings();
let lastAdvice = null; // { id, key }：用于判断结论是否变化，变化时提醒

function syncSettingsUI() {
  for (const b of $("mode-group").querySelectorAll("button")) b.classList.toggle("active", b.dataset.mode === settings.mode);
  $("cost-field").hidden = settings.mode !== "hold";
  $("stop-field").hidden = settings.mode !== "hold";
  $("cost-input").value = settings.cost ?? "";
  $("stop-input").value = settings.stopPct;
}

function updateSettings(patch) {
  settings = { ...settings, ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  syncSettingsUI();
  lastAdvice = null; // 换了设置，结论变化不算“新信号”
  if (state.snap) renderAdvice(state.snap, state.analysis);
}

$("mode-group").addEventListener("click", (e) => {
  const mode = e.target.closest("button")?.dataset.mode;
  if (mode && mode !== settings.mode) updateSettings({ mode });
});
$("cost-input").addEventListener("change", (e) => {
  const v = Number(e.target.value);
  updateSettings({ cost: v > 0 ? v : null });
});
$("stop-input").addEventListener("change", (e) => {
  const v = Number(e.target.value);
  updateSettings({ stopPct: v > 0 && v <= 20 ? v : DEFAULT_SETTINGS.stopPct });
});
syncSettingsUI();

const scoreText = (v) => `${v > 0 ? "+" : ""}${v}`;
const lvText = (list) => (list.length ? list.map((x) => `${fp(x.price)}（${x.why}）`).join("、") : "--");

function renderAdvice(snap, a) {
  const box = $("advice");
  const r = advise(snap, a, settings);
  if (!r.ready) {
    box.replaceChildren(el("p", { class: "muted" }, r.message));
    return;
  }

  // 分数条：−10 到 +10 映射到 0–100%
  const pos = (v) => `${((v + 10) / 20) * 100}%`;
  const bar = el("div", { class: "score-bar", title: `综合分 ${scoreText(r.score)}，|分数| ≥ ${r.threshold} 才给出方向` });
  bar.append(el("span", { class: "th", style: `left:${pos(-r.threshold)}` }), el("span", { class: "th", style: `left:${pos(r.threshold)}` }));
  bar.append(el("span", { class: "mark", style: `left:${pos(r.score)}` }));

  const dims = el(
    "table",
    { class: "dims" },
    ...r.dims.map((d) =>
      el(
        "tr",
        {},
        el("td", {}, d.name),
        el("td", { class: tone(d.score) }, scoreText(d.score)),
        el("td", {}, ...d.reasons.map((x) => el("span", { class: `reason ${tone(x.s)}` }, x.text))),
      ),
    ),
  );

  const levels = el(
    "div",
    { class: "levels" },
    el("span", {}, el("span", { class: "muted" }, "支撑 "), lvText(r.levels.support)),
    el("span", {}, el("span", { class: "muted" }, "压力 "), lvText(r.levels.resistance)),
  );
  if (r.stop) levels.append(el("span", {}, el("span", { class: "muted" }, "止损 "), el("span", { class: "down" }, `${fp(r.stop.price)}（${r.stop.why}）`)));

  const changes = el(
    "div",
    { class: "changes muted" },
    "今日结论变化：",
    ...r.changes.map((c) => el("span", { class: "chg" }, `${c.t} `, el("span", { class: c.tone }, c.text))),
  );

  box.replaceChildren(
    el(
      "div",
      { class: "advice-main" },
      el("span", { class: `advice-decision ${r.decision.tone}` }, r.decision.text),
      el("span", { class: "muted" }, `${MODES[settings.mode]} · 自 ${r.since} 起 · 数据截至 ${r.time}`),
    ),
    el("div", { class: "advice-score" }, el("span", {}, "综合分 ", el("b", { class: tone(r.score) }, scoreText(r.score))), bar, el("span", { class: "muted" }, `门槛 ±${r.threshold}`)),
    dims,
    levels,
    r.notes.length ? el("ul", { class: "notes" }, ...r.notes.map((n) => el("li", {}, n))) : "",
    changes,
  );

  const id = `${snap.code}|${snap.tradeDate}|${settings.mode}`;
  if (lastAdvice && lastAdvice.id === id && lastAdvice.key !== r.decision.key && "Notification" in window && Notification.permission === "granted") {
    new Notification(`${snap.name} 交易建议：${r.decision.text}`, {
      body: `${MODES[settings.mode]}，${r.since} 起，综合分 ${scoreText(r.score)}，现价 ${fp(r.price)}`,
      tag: `advice-${snap.code}`,
    });
  }
  lastAdvice = { id, key: r.decision.key };
}

function render(snap) {
  const a = analyze(snap);
  state.snap = snap;
  state.analysis = a;
  renderHeader(snap);
  $("summary").replaceChildren(...(a.summary.length ? a.summary : ["暂无数据"]).map((s) => el("li", {}, s)));
  renderStats(snap);
  renderMetrics(snap, a);
  renderBook(snap.book, snap.quote?.prevClose);
  renderSignals(snap, a);
  renderAdvice(snap, a);
  renderCharts(snap, a);
  updateLegend(null);
  const src = snap.sources || {};
  $("sources").textContent =
    `本次数据源：报价 ${src.quote || "无"} · 分钟线 ${src.bars || "无"} · 15分钟线 ${src.bars15 || "无"} · 资金流 ${src.flow || "无"} · 盘口 ${src.book || "无"}　服务器时间 ${snap.session?.beijingTime || "--"}` +
    (snap.fallbacks?.length ? `　已切换备用源：${snap.fallbacks.join("；")}` : "");
}

function banner(text) {
  const b = $("banner");
  b.hidden = !text;
  b.textContent = text || "";
}

// ---------- 刷新调度 ----------

let timer = null;
let nextAt = 0;
let inflight = false;

async function load() {
  if (inflight) return;
  inflight = true;
  try {
    const res = await fetch(`/api/snapshot?code=${CODE}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error([data.error, ...(data.details || [])].filter(Boolean).join("；"));
    render(data);
    banner(
      data.stale
        ? `上游行情源暂时不可用，显示的是缓存数据（${data.errors?.join("；")}）`
        : data.errors?.length
          ? `部分数据暂缺：${data.errors.join("；")}`
          : null,
    );
  } catch (e) {
    banner(`刷新失败：${e.message}${state.snap ? "。页面显示的是上一次成功获取的数据。" : ""}`);
  } finally {
    inflight = false;
    schedule();
  }
}

function schedule() {
  const sec = state.snap ? REFRESH_SEC[state.snap.session?.state] ?? 60 : 30;
  nextAt = Date.now() + sec * 1000;
  clearTimeout(timer);
  if (!document.hidden) timer = setTimeout(load, sec * 1000);
}

// 标签页不可见时暂停轮询，回来时如已过期立即刷新
document.addEventListener("visibilitychange", () => {
  clearTimeout(timer);
  if (document.hidden) return;
  const wait = nextAt - Date.now();
  if (wait <= 0) load();
  else timer = setTimeout(load, wait);
});

setInterval(() => {
  const s = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  $("countdown").textContent = inflight ? "刷新中…" : document.hidden ? "已暂停" : `${s} 秒后刷新`;
}, 1000);

$("refresh-btn").addEventListener("click", () => load());

const notifyBtn = $("notify-btn");
const syncNotifyBtn = () => {
  if (!("Notification" in window)) {
    notifyBtn.disabled = true;
    notifyBtn.textContent = "浏览器不支持提醒";
  } else if (Notification.permission === "granted") {
    notifyBtn.disabled = true;
    notifyBtn.textContent = "信号提醒已开启";
  } else if (Notification.permission === "denied") {
    notifyBtn.disabled = true;
    notifyBtn.textContent = "提醒已被浏览器禁止";
  }
};
notifyBtn.addEventListener("click", async () => {
  await Notification.requestPermission();
  syncNotifyBtn();
});
syncNotifyBtn();

$("code-input").value = CODE;
$("code-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("code-input").value.trim();
  if (/^\d{6}$/.test(v)) location.search = `?code=${v}`;
});

load();

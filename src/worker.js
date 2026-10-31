// Cloudflare Worker 入口。/api/snapshot 返回一只股票当日的完整盘中数据，静态页面由 Workers Assets 提供。
// 同一份 handleApi 也被 server.mjs 复用，方便在本机 / 任意 Node 环境运行。

import {
  benchmarkOf,
  emFundFlow,
  emMinuteBars,
  emQuote,
  tencentMinuteBars,
  tencentQuotes,
  tencentSymbol,
} from "./sources.js";

const DEFAULT_CODE = "688256"; // 寒武纪

// ---------- 交易时段（北京时间） ----------

function beijingNow(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const iso = bj.toISOString();
  return {
    date: iso.slice(0, 10),
    hm: bj.getUTCHours() * 100 + bj.getUTCMinutes(),
    weekday: bj.getUTCDay(),
    text: `${iso.slice(0, 10)} ${iso.slice(11, 19)}`,
  };
}

// pre: 9:15-9:30 集合竞价；open: 连续竞价；lunch: 午休；closed: 收盘/休市
// 节假日无法从时间判断，所以再用“最新 K 线日期是否为今天”兜底。
function sessionState(bj, tradeDate) {
  if (bj.weekday === 0 || bj.weekday === 6) return "closed";
  if (tradeDate && tradeDate !== bj.date && bj.hm >= 931) return "closed";
  if (bj.hm >= 915 && bj.hm < 930) return "pre";
  if ((bj.hm >= 930 && bj.hm < 1130) || (bj.hm >= 1300 && bj.hm < 1500)) return "open";
  if (bj.hm >= 1130 && bj.hm < 1300) return "lunch";
  return "closed";
}

// ---------- 内存缓存 ----------
// 同一个 Worker 实例内共享，避免多个标签页/访客把请求放大到上游。
// （*.workers.dev 上 caches.default 不生效，所以用内存缓存。）

const memo = new Map();
const TTL_MS = { open: 50_000, pre: 50_000, lunch: 240_000, closed: 600_000 };

// ---------- 组装快照 ----------

async function buildSnapshot(code) {
  const bench = benchmarkOf(code);
  const stockSym = tencentSymbol(code);
  const benchSym = tencentSymbol(bench.code, true);

  const [emQ, txQ, emBars, emIdx, flow] = await Promise.allSettled([
    emQuote(code),
    tencentQuotes([{ symbol: stockSym }, { symbol: benchSym }]),
    emMinuteBars(code),
    emMinuteBars(bench.code, true),
    emFundFlow(code),
  ]);

  const errors = []; // 没有拿到数据的项
  const fallbacks = []; // 主源失败但备用源成功的项
  const sources = {};
  const recovered = () => fallbacks.push(errors.pop());
  const val = (r, label) => {
    if (r.status === "fulfilled") return r.value;
    errors.push(`${label}: ${r.reason?.message || r.reason}`);
    return null;
  };

  // 报价：东方财富为主，腾讯补字段 / 兜底；盘口只有腾讯有
  const em = val(emQ, "东方财富报价");
  const tx = val(txQ, "腾讯报价") || {};
  const txStock = tx[stockSym];
  const txBench = tx[benchSym];
  let quote = null;
  if (em || txStock) {
    quote = { ...(txStock || {}), ...dropNulls(em || {}) };
    delete quote.book;
    sources.quote = em ? "东方财富" : "腾讯";
    if (!em) recovered();
  }
  const book = txStock?.book || null;
  if (book) sources.book = "腾讯";

  // 分钟线：东方财富为主，失败用腾讯分时
  let bars = val(emBars, "东方财富分钟线");
  sources.bars = "东方财富";
  if (!bars) {
    bars = await tencentMinuteBars(stockSym).catch((e) => (errors.push(`腾讯分时: ${e.message}`), null));
    sources.bars = bars ? "腾讯" : null;
    if (bars) recovered();
  }

  let idx = val(emIdx, `东方财富${bench.name}分钟线`);
  if (!idx) {
    idx = await tencentMinuteBars(benchSym, true).catch((e) => (errors.push(`腾讯${bench.name}分时: ${e.message}`), null));
    if (idx) recovered();
  }

  let flowRows = val(flow, "东方财富资金流向");
  if (flowRows && bars) flowRows = flowRows.filter((r) => r.date === bars.date);
  if (flowRows) sources.flow = "东方财富";

  if (!quote && !bars) {
    const err = new Error("所有行情源都请求失败");
    err.details = errors;
    throw err;
  }

  if (quote && !quote.name) quote.name = code;
  const bj = beijingNow();
  const tradeDate = bars?.date || null;

  return {
    code,
    name: quote?.name || code,
    tradeDate,
    session: { state: sessionState(bj, tradeDate), beijingTime: bj.text },
    updatedAt: new Date().toISOString(),
    quote,
    book,
    bars: bars?.bars || [],
    benchmark: {
      ...bench,
      prevClose: txBench?.prevClose ?? idx?.prevClose ?? null,
      price: txBench?.price ?? null,
      pct: txBench?.pct ?? null,
      bars: (idx?.bars || []).map((b) => ({ t: b.t, c: b.c })),
    },
    flow: flowRows,
    sources,
    errors,
    fallbacks,
  };
}

function dropNulls(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && !Number.isNaN(v)));
}

// ---------- HTTP ----------

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

export async function handleApi(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/snapshot") return json({ error: "not found" }, 404);

  const code = url.searchParams.get("code") || DEFAULT_CODE;
  if (!/^\d{6}$/.test(code)) return json({ error: "code 必须是 6 位 A 股代码" }, 400);

  const hit = memo.get(code);
  if (hit && hit.expires > Date.now()) {
    return json(hit.data, 200, { "Cache-Control": "no-store", "X-Cache": "HIT" });
  }

  try {
    const data = await buildSnapshot(code);
    memo.set(code, { data, expires: Date.now() + TTL_MS[data.session.state] });
    if (memo.size > 50) memo.delete(memo.keys().next().value);
    return json(data, 200, { "Cache-Control": "no-store", "X-Cache": "MISS" });
  } catch (e) {
    // 上游全挂时，有旧数据就返回旧数据并标记
    if (hit) return json({ ...hit.data, stale: true, errors: e.details || [e.message] }, 200, { "X-Cache": "STALE" });
    return json({ error: e.message, details: e.details || [] }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request);
    // 静态文件由 Workers Assets 处理（wrangler.toml 的 [assets]），这里只兜底
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },
};

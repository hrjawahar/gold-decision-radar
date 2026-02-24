// functions/api/market.js
// Phase 1 backend: DXY + USD/INR (spot + 30d % + trend) + US 10Y Real Yield (FRED)
// Safe-by-default: returns JSON with nulls instead of crashing.

export async function onRequestGet() {
  const cacheSeconds = 120;

  const errors = [];

  const safe = async (name, fn) => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${name}: ${String(e?.message || e)}`);
      return { value: null, asOf: null, source: { provider: "error", name } };
    }
  };

  const [dxyObj, inrObj, realYieldObj] = await Promise.all([
    safe("dxy", getDxy),
    safe("usdInr", getUsdInr),
    safe("realYield", getRealYield),
  ]);

  const result = {
    dxy: dxyObj?.value ?? null,

    usdInr: inrObj?.value ?? null,
    usdInrChangePct30d: inrObj?.pct30d ?? null,
    usdInrTrend: inrObj?.trend ?? null,

    realYield: realYieldObj?.value ?? null,

    // Keep these for your frontend expectations (Phase 2 later)
    rsi14Setfgold: null,
    rsi14SetfgoldAsOf: null,
    setfGoldPrice: null,

    sbiGoldEtfInav: null,
    sbiGoldEtfInavAsOf: null,

    asOf: new Date().toISOString(),

    freshness: {
      dxy: dxyObj?.source ?? null,
      usdInr: inrObj?.source ?? null,
      realYield: realYieldObj?.source ?? null,
    },

    errors,
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${cacheSeconds}`,
    },
  });
}

/* -------------------- DXY -------------------- */

async function getDxy() {
  // Primary: Yahoo
  try {
    const y = await fetchYahooChart("DX-Y.NYB", "1mo", "1d");
    if (Number.isFinite(y.latestPrice)) {
      return { value: y.latestPrice, asOf: y.asOf, source: { provider: "yahoo", symbol: "DX-Y.NYB" } };
    }
  } catch (_) {}

  // Fallback: Stooq
  const s = await fetchStooqClose("dx.f");
  return { value: s.last, asOf: s.asOf, source: { provider: "stooq", symbol: "dx.f" } };
}

/* -------------------- USD/INR -------------------- */

async function getUsdInr() {
  // helper to convert pct to trend buckets
  const pctToTrend = (pct) => {
    if (!Number.isFinite(pct)) return "stable";
    if (pct > 0.5) return "weakening";          // USD/INR rising (INR weakening)
    if (pct < -0.5) return "strengthening";     // USD/INR falling (INR strengthening)
    return "stable";
  };

  // Primary: Yahoo (INR=X)
  try {
    const y = await fetchYahooChart("INR=X", "1mo", "1d");
    const pct30d = y.pctChangeFromFirstPoint;
    const spot = Number.isFinite(y.latestPrice) ? y.latestPrice : null;

    return {
      value: spot,
      pct30d: Number.isFinite(pct30d) ? pct30d : null,
      trend: pctToTrend(pct30d),
      asOf: y.asOf,
      source: { provider: "yahoo", symbol: "INR=X", window: "1mo" },
    };
  } catch (_) {}

  // Fallback: Stooq (usdinr)
  const s = await fetchStooqClose("usdinr", true);
  return {
    value: Number.isFinite(s.last) ? s.last : null,
    pct30d: Number.isFinite(s.pct30d) ? s.pct30d : null,
    trend: pctToTrend(s.pct30d),
    asOf: s.asOf,
    source: { provider: "stooq", symbol: "usdinr", window: "30d" },
  };
}

/* -------------------- US 10Y Real Yield (FRED) -------------------- */

async function getRealYield() {
  // DFII10 = 10-Year Treasury Inflation-Indexed Security, Constant Maturity (Real Yield)
  const v = await fetchFredLastValue("DFII10");
  return { value: v, asOf: new Date().toISOString(), source: { provider: "fred", series: "DFII10" } };
}

/* -------------------- Helpers -------------------- */

async function fetchYahooChart(symbol, range = "1mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept": "application/json,text/plain,*/*",
    },
  });
  if (!res.ok) throw new Error(`Yahoo fetch failed for ${symbol}: HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo parse failed for ${symbol}`);

  const meta = result.meta || {};
  const latestPrice =
    (typeof meta.regularMarketPrice === "number" && Number.isFinite(meta.regularMarketPrice) && meta.regularMarketPrice) ||
    (typeof meta.previousClose === "number" && Number.isFinite(meta.previousClose) && meta.previousClose) ||
    null;

  const closes = result?.indicators?.quote?.[0]?.close || [];
  const first = closes.find((x) => typeof x === "number" && Number.isFinite(x));
  const last = [...closes].reverse().find((x) => typeof x === "number" && Number.isFinite(x));

  let pctChangeFromFirstPoint = null;
  if (typeof first === "number" && typeof last === "number" && first !== 0) {
    pctChangeFromFirstPoint = ((last - first) / first) * 100;
  }

  const asOf = meta?.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : new Date().toISOString();

  return { latestPrice, pctChangeFromFirstPoint, asOf };
}

async function fetchStooqClose(symbol, computePct = false) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const res = await fetch(url, { headers: { "accept": "text/csv" } });
  if (!res.ok) throw new Error(`Stooq fetch failed for ${symbol}: HTTP ${res.status}`);
  const text = await res.text();

  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error(`Stooq CSV empty for ${symbol}`);

  // Stooq returns latest row first in this endpoint
  const rows = lines.slice(1, 32).map(line => line.split(",")).filter(p => p.length >= 5);
  const closes = rows.map(r => parseFloat(r[4])).filter(n => Number.isFinite(n));
  const last = closes[0];
  const oldest = closes[closes.length - 1];

  let pct30d = null;
  if (computePct && Number.isFinite(last) && Number.isFinite(oldest) && oldest !== 0) {
    pct30d = ((last - oldest) / oldest) * 100;
  }

  const asOf = rows?.[0]?.[0] ? new Date(rows[0][0]).toISOString() : new Date().toISOString();
  return { last, pct30d, asOf };
}

async function fetchFredLastValue(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const res = await fetch(url, { headers: { "accept": "text/csv" } });
  if (!res.ok) throw new Error(`FRED fetch failed for ${seriesId}: HTTP ${res.status}`);
  const text = await res.text();

  const lines = text.trim().split(/\r?\n/);
  // last numeric from bottom
  for (let i = lines.length - 1; i >= 1; i--) {
    const parts = lines[i].split(",");
    if (parts.length >= 2) {
      const v = parseFloat(parts[1]);
      if (Number.isFinite(v)) return v;
    }
  }
  throw new Error(`No numeric value found in FRED CSV for ${seriesId}`);
}

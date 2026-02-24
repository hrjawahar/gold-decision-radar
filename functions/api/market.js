// functions/api/market.js
// Phase 1 backend: DXY + USD/INR (spot + 30d % + trend) + US 10Y Real Yield (FRED)
// Safe-by-default: returns JSON with nulls instead of crashing.

export async function onRequestGet({ request }) {
  const cacheSeconds = 120;

  const url = new URL(request.url);
  const inavMode = (url.searchParams.get("inav") || "auto").toLowerCase(); // auto | off

  const errors = [];

  const safe = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${label}: ${String(e?.message || e)}`);
      return null;
    }
  };

  try {
    const dxyObj = await safe("dxy", getDxy);
    const inrObj = await safe("usd_inr", getUsdInr);
    const realYieldObj = await safe("real_yield", getRealYield);

    // SETFGOLD price + RSI (auto)
    const setfPriceObj = await safe("setfgold_price", () => getSetfGoldPriceSafe("SETFGOLD.NS"));
    const rsiObj = await safe("rsi14_setfgold", () => getRsi14Safe("SETFGOLD.NS"));

    // SBI iNAV (auto unless turned off)
    const sbiInavObj =
      (inavMode === "off")
        ? { value: null, asOf: null, source: { provider: "sbimf", note: "disabled_by_query" } }
        : await safe("sbi_inav", getSbiGoldEtfInavSafe);

    const result = {
      dxy: dxyObj?.value ?? null,
      usdInr: inrObj?.value ?? null,
      usdInrChangePct30d: inrObj?.pct30d ?? null,
      usdInrTrend: inrObj?.trend ?? null,

      realYield: realYieldObj?.value ?? null,

      // Auto signals (optional — UI may still use manual input if you prefer)
      setfGoldPrice: setfPriceObj?.value ?? null,
      setfGoldPriceAsOf: setfPriceObj?.asOf ?? null,

      rsi14Setfgold: rsiObj?.value ?? null,
      rsi14SetfgoldAsOf: rsiObj?.asOf ?? null,

      sbiGoldEtfInav: sbiInavObj?.value ?? null,
      sbiGoldEtfInavAsOf: sbiInavObj?.asOf ?? null,

      asOf: new Date().toISOString(),

      freshness: {
        dxy: dxyObj?.source ?? null,
        usdInr: inrObj?.source ?? null,
        realYield: realYieldObj?.source ?? null,
        setfGoldPrice: setfPriceObj?.source ?? null,
        rsi: rsiObj?.source ?? null,
        sbiInav: sbiInavObj?.source ?? null
      },

      errors
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${cacheSeconds}`
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: "market_api_failed",
      message: String(err?.message || err),
      asOf: new Date().toISOString()
    }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
}

/* ======================= DXY ======================= */

async function getDxy() {
  try {
    const y = await fetchYahooChart("DX-Y.NYB");
    if (Number.isFinite(y.latestPrice)) return { value: y.latestPrice, source: { provider: "yahoo", symbol: "DX-Y.NYB" } };
  } catch (e) {}
  const s = await fetchStooqClose("dx.f");
  return { value: s.last, source: { provider: "stooq", symbol: "dx.f" } };
}

/* ======================= USD/INR ======================= */

async function getUsdInr() {
  const pctToTrend = (pct) => {
    let trend = "stable";
    if (typeof pct === "number" && Number.isFinite(pct)) {
      if (pct > 0.5) trend = "weakening";           // USD/INR rising
      else if (pct < -0.5) trend = "strengthening"; // USD/INR falling
    }
    return trend;
  };

  try {
    const y = await fetchYahooChart("INR=X");
    const pct30d = y.pctChangeFromFirstPoint;
    return {
      value: Number.isFinite(y.latestPrice) ? y.latestPrice : null,
      pct30d: (typeof pct30d === "number" && Number.isFinite(pct30d)) ? pct30d : null,
      trend: pctToTrend(pct30d),
      source: { provider: "yahoo", symbol: "INR=X", window: "1mo" }
    };
  } catch (e) {}

  const s = await fetchStooqClose("usdinr", true);
  return {
    value: Number.isFinite(s.last) ? s.last : null,
    pct30d: (typeof s.pct30d === "number" && Number.isFinite(s.pct30d)) ? s.pct30d : null,
    trend: pctToTrend(s.pct30d),
    source: { provider: "stooq", symbol: "usdinr", window: "30d" }
  };
}

/* ======================= REAL YIELD ======================= */

async function getRealYield() {
  // DFII10 = 10-Year Treasury Inflation-Indexed Security, Constant Maturity (Real Yield)
  const v = await fetchFredLastValue("DFII10");
  return { value: v, source: { provider: "fred", series: "DFII10" } };
}

/* ======================= SETFGOLD PRICE (AUTO) ======================= */

async function getSetfGoldPriceSafe(symbol) {
  try {
    const y = await fetchYahooChart(symbol);
    if (!Number.isFinite(y.latestPrice)) throw new Error("no latestPrice");
    return {
      value: y.latestPrice,
      asOf: new Date().toISOString(),
      source: { provider: "yahoo", symbol }
    };
 } catch (e) {
  return {
    value: null,
    asOf: null,
    source: {
      provider: "sbimf",
      endpoint: "/home/GetETFNAVDetailsAsync",
      note: `inav_fetch_failed:${String(e?.message || e)}`
    }
  };
}

/* ======================= RSI(14) (AUTO) ======================= */

async function getRsi14Safe(symbol) {
  try {
    const source = { provider: "yahoo", symbol, window: "3mo", interval: "1d" };
    const data = await fetchYahooCloses(symbol, "3mo", "1d");
    const rsi = computeRsi14(data.closes);
    return { value: rsi, asOf: data.asOf, source };
  } catch (e) {
    return {
      value: null,
      asOf: null,
      source: { provider: "yahoo", symbol, window: "3mo", interval: "1d", note: "rsi_fetch_failed" }
    };
  }
}

async function fetchYahooCloses(symbol, range = "3mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", "accept": "application/json,text/plain,*/*" } });
if (!res1.ok) {
  const ct = res1.headers.get("content-type") || "";
  const body = await res1.text().catch(()=> "");
  throw new Error(`GET HTTP ${res1.status} ct=${ct} body=${body.slice(0,120)}`);
}  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo closes parse failed for ${symbol}`);

  const closesRaw = result?.indicators?.quote?.[0]?.close || [];
  const closes = closesRaw.filter(x => typeof x === "number" && Number.isFinite(x));
  if (closes.length < 20) throw new Error(`Not enough closes for RSI(14): ${symbol}`);

  const meta = result.meta || {};
  const asOf = meta?.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString();
  return { closes, asOf };
}

// Wilder RSI(14)
function computeRsi14(closes) {
  const period = 14;
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return Math.round(rsi * 10) / 10;
}

/* ======================= SBI iNAV (AUTO) ======================= */

async function getSbiGoldEtfInavSafe() {
  try {
    const url = "https://etf.sbimf.com/home/GetETFNAVDetailsAsync";

    const res = await fetch(url, {
      headers: {
        "accept": "application/json,text/plain,*/*",
        "user-agent": "Mozilla/5.0",
        "referer": "https://etf.sbimf.com/",
        "origin": "https://etf.sbimf.com"
      }
    });

    if (!res.ok) throw new Error(`SBI iNAV fetch failed: HTTP ${res.status}`);

    // sometimes servers return HTML even with 200
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();
    if (!ct.includes("application/json")) {
      throw new Error(`SBI iNAV not JSON (content-type=${ct})`);
    }

    const j = JSON.parse(text);
    const rows = Array.isArray(j?.Data) ? j.Data : [];
    if (!rows.length) throw new Error("SBI iNAV: empty Data");

    const row =
      rows.find(r => String(r.FundName || "").trim().toLowerCase() === "sbi gold etf") ||
      rows.find(r => /sbi\s+gold\s+etf/i.test(String(r.FundName || "")));

    if (!row) throw new Error("SBI Gold ETF not found in Data");

    const inav = parseFloat(row.LatestNAV);
    if (!Number.isFinite(inav)) throw new Error("SBI Gold ETF LatestNAV not numeric");

    return {
      value: inav,
      asOf: row.LatestNAVDate || null,
      source: { provider: "sbimf", endpoint: "/home/GetETFNAVDetailsAsync", fundName: row.FundName }
    };
  } catch (e) {
    return {
      value: null,
      asOf: null,
      source: { provider: "sbimf", endpoint: "/home/GetETFNAVDetailsAsync", note: "inav_fetch_failed" }
    };
  }
}

/* ======================= HELPERS ======================= */

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", "accept": "application/json,text/plain,*/*" } });
  if (!res.ok) throw new Error(`Yahoo fetch failed for ${symbol}: HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo parse failed for ${symbol}`);

  const meta = result.meta || {};
  const latestPrice =
    (typeof meta.regularMarketPrice === "number" && meta.regularMarketPrice) ||
    (typeof meta.previousClose === "number" && meta.previousClose) ||
    null;

  const closes = result?.indicators?.quote?.[0]?.close || [];
  const first = closes.find((x) => typeof x === "number");
  const last = [...closes].reverse().find((x) => typeof x === "number");

  let pctChangeFromFirstPoint = null;
  if (typeof first === "number" && typeof last === "number" && first !== 0) {
    pctChangeFromFirstPoint = ((last - first) / first) * 100;
  }

  return { latestPrice, pctChangeFromFirstPoint };
}

async function fetchStooqClose(symbol, computePct = false) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const res = await fetch(url, { headers: { "accept": "text/csv" } });
  if (!res.ok) throw new Error(`Stooq fetch failed for ${symbol}: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error(`Stooq CSV empty for ${symbol}`);

  const rows = lines.slice(1, 31).map(line => line.split(",")).filter(p => p.length >= 5);
  const closes = rows.map(r => parseFloat(r[4])).filter(n => Number.isFinite(n));

  const last = closes[0];
  const oldest = closes[closes.length - 1];

  let pct30d = null;
  if (computePct && Number.isFinite(last) && Number.isFinite(oldest) && oldest !== 0) {
    pct30d = ((last - oldest) / oldest) * 100;
  }

  return { last, pct30d };
}

async function fetchFredLastValue(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const res = await fetch(url, { headers: { "accept": "text/csv" } });
  if (!res.ok) throw new Error(`FRED fetch failed for ${seriesId}: HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 1; i--) {
    const parts = lines[i].split(",");
    if (parts.length >= 2) {
      const v = parseFloat(parts[1]);
      if (Number.isFinite(v)) return v;
    }
  }
  throw new Error(`No numeric value found in FRED CSV for ${seriesId}`);
}

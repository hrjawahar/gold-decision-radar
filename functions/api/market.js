export async function onRequestGet({ request, env, ctx }) {
  const url = new URL(request.url);

  // --- Controls ---
  const cacheSeconds = 120;            // overall API cache
  const rsiRange = "3mo";              // enough to compute RSI(14)
  const rsiInterval = "1d";
  const rsiSymbol = "SETFGOLD.NS";
  const priceSymbol = "SETFGOLD.NS";

  // Manual overrides (optional)
  const inavManual = toNum(url.searchParams.get("inav_manual"));
  const priceManual = toNum(url.searchParams.get("price_manual"));
  const rsiManual = toNum(url.searchParams.get("rsi_manual"));

  // --- Cache wrapper (Cloudflare edge cache) ---
  const cacheKey = new Request(url.toString(), request);
  const cache = caches.default;

  // If not forcing manual values, allow cached response
  const hasManual =
    Number.isFinite(inavManual) || Number.isFinite(priceManual) || Number.isFinite(rsiManual);

  if (!hasManual) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  try {
    // Fetch in parallel (fast + resilient)
    const [
      dxyObj,
      inrObj,
      realYieldObj,
      priceObj,
      rsiObj,
      sbiInavObj
    ] = await Promise.all([
      getDxy(),
      getUsdInr(),
      getRealYield(),
      getSetfGoldPriceSafe(priceSymbol),
      getRsi14Safe(rsiSymbol, rsiRange, rsiInterval),
      getSbiGoldEtfInavSafe()
    ]);

    // Apply manual overrides (without losing auto values)
    const chosen = {
      inav: Number.isFinite(inavManual) ? inavManual : (sbiInavObj?.value ?? null),
      price: Number.isFinite(priceManual) ? priceManual : (priceObj?.value ?? null),
      rsi14: Number.isFinite(rsiManual) ? rsiManual : (rsiObj?.value ?? null)
    };

    const result = {
      asOf: new Date().toISOString(),

      // Core macro (auto)
      dxy: dxyObj?.value ?? null,
      realYield: realYieldObj?.value ?? null,
      usdInr: inrObj?.value ?? null,
      usdInrChangePct30d: inrObj?.pct30d ?? null,
      usdInrTrend: inrObj?.trend ?? null,

      // Gold ETF inputs (auto + chosen)
      setfGold: {
        symbol: priceSymbol,
        autoPrice: priceObj?.value ?? null,
        autoPriceAsOf: priceObj?.asOf ?? null,
        priceChosen: chosen.price,
        priceChosenMode: Number.isFinite(priceManual) ? "manual" : "auto"
      },

      rsi: {
        symbol: rsiSymbol,
        autoRsi14: rsiObj?.value ?? null,
        autoRsiAsOf: rsiObj?.asOf ?? null,
        rsiChosen: chosen.rsi14,
        rsiChosenMode: Number.isFinite(rsiManual) ? "manual" : "auto",
        method: "Wilder RSI(14) computed from daily closes"
      },

      inav: {
        autoInav: sbiInavObj?.value ?? null,
        autoInavAsOf: sbiInavObj?.asOf ?? null,
        inavChosen: chosen.inav,
        inavChosenMode: Number.isFinite(inavManual) ? "manual" : "auto",
        provider: "SBIMF endpoint parse"
      },

      // Freshness + traceability
      freshness: {
        dxy: dxyObj?.source ?? null,
        usdInr: inrObj?.source ?? null,
        realYield: realYieldObj?.source ?? null,
        setfPrice: priceObj?.source ?? null,
        rsi: rsiObj?.source ?? null,
        sbiInav: sbiInavObj?.source ?? null
      },

      notes: {
        manualOverrides: {
          inav_manual: Number.isFinite(inavManual) ? inavManual : null,
          price_manual: Number.isFinite(priceManual) ? priceManual : null,
          rsi_manual: Number.isFinite(rsiManual) ? rsiManual : null
        }
      }
    };

    const res = new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${cacheSeconds}`
      }
    });

    // Cache only when no manual overrides
    if (!hasManual) ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;

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

/* -------------------- helpers -------------------- */

function toNum(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/* -------------------- DXY -------------------- */

async function getDxy() {
  try {
    const y = await fetchYahooChart("DX-Y.NYB", "1mo", "1d");
    if (Number.isFinite(y.latestPrice)) {
      return { value: y.latestPrice, source: { provider: "yahoo", symbol: "DX-Y.NYB" } };
    }
  } catch (e) {}
  const s = await fetchStooqClose("dx.f");
  return { value: s.last ?? null, source: { provider: "stooq", symbol: "dx.f" } };
}

/* -------------------- USD/INR + 30d trend -------------------- */

async function getUsdInr() {
  const pctToTrend = (pct) => {
    let trend = "stable";
    if (typeof pct === "number" && Number.isFinite(pct)) {
      if (pct > 0.5) trend = "weakening";          // USD/INR rising
      else if (pct < -0.5) trend = "strengthening"; // USD/INR falling
    }
    return trend;
  };

  try {
    const y = await fetchYahooChart("INR=X", "1mo", "1d");
    const pct30d = y.pctChangeFromFirstPoint;
    return {
      value: Number.isFinite(y.latestPrice) ? y.latestPrice : null,
      pct30d: Number.isFinite(pct30d) ? pct30d : null,
      trend: pctToTrend(pct30d),
      source: { provider: "yahoo", symbol: "INR=X", window: "1mo" }
    };
  } catch (e) {}

  // fallback: stooq
  const s = await fetchStooqClose("usdinr", true);
  return {
    value: Number.isFinite(s.last) ? s.last : null,
    pct30d: Number.isFinite(s.pct30d) ? s.pct30d : null,
    trend: pctToTrend(s.pct30d),
    source: { provider: "stooq", symbol: "usdinr", window: "30d" }
  };
}

/* -------------------- Real Yield (FRED) -------------------- */
/* Using FRED CSV (free, no key). Series commonly used: DFII10 (10Y TIPS yield).
   If you already use another series, replace it here. */
async function getRealYield() {
  const seriesId = "DFII10";
  const v = await fetchFredLastValue(seriesId);
  return { value: v, source: { provider: "fred", series: seriesId } };
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

/* -------------------- SETFGOLD Price (auto) -------------------- */

async function getSetfGoldPriceSafe(symbol) {
  try {
    const y = await fetchYahooChart(symbol, "5d", "1d");
    return {
      value: Number.isFinite(y.latestPrice) ? y.latestPrice : null,
      asOf: y.asOf ?? null,
      source: { provider: "yahoo", symbol }
    };
  } catch (e) {
    return {
      value: null,
      asOf: null,
      source: { provider: "yahoo", symbol, note: "price_fetch_failed" }
    };
  }
}

/* -------------------- RSI(14) computed backend -------------------- */

async function getRsi14Safe(symbol, range, interval) {
  try {
    const data = await fetchYahooCloses(symbol, range, interval);
    const rsi = computeRsi14(data.closes);
    return {
      value: Number.isFinite(rsi) ? rsi : null,
      asOf: data.asOf ?? null,
      source: { provider: "yahoo", symbol, range, interval, note: "computed_rsi14" }
    };
  } catch (e) {
    return {
      value: null,
      asOf: null,
      source: { provider: "yahoo", symbol, range, interval, note: "rsi_fetch_failed" }
    };
  }
}

async function fetchYahooCloses(symbol, range = "3mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", "accept": "application/json,text/plain,*/*" }
  });
  if (!res.ok) throw new Error(`Yahoo fetch failed for ${symbol}: HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo parse failed for ${symbol}`);

  const closesRaw = result?.indicators?.quote?.[0]?.close || [];
  const closes = closesRaw.filter(x => typeof x === "number" && Number.isFinite(x));

  if (closes.length < 20) throw new Error(`Not enough closes for RSI(14): ${symbol}`);

  const meta = result.meta || {};
  const asOf = meta?.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : new Date().toISOString();

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

/* -------------------- SBI iNAV (auto) -------------------- */

async function getSbiGoldEtfInavSafe() {
  try {
    const url = "https://etf.sbimf.com/home/GetETFNAVDetailsAsync";
    const res = await fetch(url, { headers: { "accept": "application/json" }});
    if (!res.ok) throw new Error(`SBI iNAV fetch failed: HTTP ${res.status}`);

    const j = await res.json();
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

/* -------------------- shared fetch helpers -------------------- */

async function fetchYahooChart(symbol, range = "1mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", "accept": "application/json,text/plain,*/*" }
  });
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

  const rows = lines.slice(1, 31).map(line => line.split(",")).filter(p => p.length >= 5);
  const closes = rows.map(r => parseFloat(r[4])).filter(n => Number.isFinite(n));

  // Stooq usually returns latest row first
  const last = closes[0];
  const oldest = closes[closes.length - 1];

  let pct30d = null;
  if (computePct && Number.isFinite(last) && Number.isFinite(oldest) && oldest !== 0) {
    pct30d = ((last - oldest) / oldest) * 100;
  }
  return { last, pct30d };
}

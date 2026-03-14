export async function onRequestGet() {
  const cacheSeconds = 120;

  try {
    const [dxyObj, inrObj, realYieldObj, goldObj, rsiObj, sbiInavObj] = await Promise.all([
      getDxySafe(),
      getUsdInrSafe(),
      getRealYieldSafe(),
      getSetfGoldPriceSafe(),
      getRsi14Safe("SETFGOLD.NS"),
      getSbiGoldEtfInavSafe()
    ]);

    const result = {
      dxy: numberOrNull(dxyObj?.value),

      usdInr: numberOrNull(inrObj?.value),
      usdInrChangePct30d: numberOrNull(inrObj?.pct30d),
      usdInrTrend: inrObj?.trend ?? null,

      realYield: numberOrNull(realYieldObj?.value),

      setfGoldPrice: numberOrNull(goldObj?.value),
      setfGoldPriceAsOf: goldObj?.asOf ?? null,

      rsi14Setfgold: numberOrNull(rsiObj?.value),
      rsi14SetfgoldAsOf: rsiObj?.asOf ?? null,

      sbiGoldEtfInav: numberOrNull(sbiInavObj?.value),
      sbiGoldEtfInavAsOf: sbiInavObj?.asOf ?? null,

      asOf: new Date().toISOString(),
      contractVersion: 4,

      quality: {
        dxy: numberOrNull(dxyObj?.value) !== null ? "ok" : "missing",
        usdInr: numberOrNull(inrObj?.value) !== null ? "ok" : "missing",
        realYield: numberOrNull(realYieldObj?.value) !== null ? "ok" : "missing",
        setfGoldPrice: numberOrNull(goldObj?.value) !== null ? "ok" : "missing",
        rsi14Setfgold: numberOrNull(rsiObj?.value) !== null ? "ok" : "missing",
        sbiGoldEtfInav: numberOrNull(sbiInavObj?.value) !== null ? "ok" : "missing"
      },

      freshness: {
        dxy: dxyObj?.source ?? null,
        usdInr: inrObj?.source ?? null,
        realYield: realYieldObj?.source ?? null,
        setfGoldPrice: goldObj?.source ?? null,
        rsi14Setfgold: rsiObj?.source ?? null,
        sbiGoldEtfInav: sbiInavObj?.source ?? null
      },

      errors: compactErrors([
        dxyObj?.error,
        inrObj?.error,
        realYieldObj?.error,
        goldObj?.error,
        rsiObj?.error,
        sbiInavObj?.error
      ])
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

/* -------------------- small utils -------------------- */

function numberOrNull(v) {
  return (typeof v === "number" && Number.isFinite(v)) ? v : null;
}

function compactErrors(arr) {
  return arr.filter(Boolean);
}

/* -------------------- factor fetchers -------------------- */

async function getDxySafe() {
  try {
    return await getDxy();
  } catch (e) {
    return {
      value: null,
      source: { provider: "yahoo/stooq", symbol: "DX-Y.NYB", note: "dxy_fetch_failed" },
      error: "dxy_fetch_failed"
    };
  }
}

async function getUsdInrSafe() {
  try {
    return await getUsdInr();
  } catch (e) {
    return {
      value: null,
      pct30d: null,
      trend: "stable",
      source: { provider: "yahoo/stooq", symbol: "INR=X", note: "usdinr_fetch_failed" },
      error: "usdinr_fetch_failed"
    };
  }
}

async function getRealYieldSafe() {
  try {
    const value = await fetchFredLastValue("DFII10");
    return {
      value,
      source: { provider: "fred", series: "DFII10" }
    };
  } catch (e1) {
    try {
      const value = await fetchFredLastValueAlt("DFII10");
      return {
        value,
        source: { provider: "fred_alt", series: "DFII10" }
      };
    } catch (e2) {
      return {
        value: null,
        source: { provider: "fred", series: "DFII10", note: "real_yield_fetch_failed" },
        error: "real_yield_fetch_failed"
      };
    }
  }
}

async function getSetfGoldPriceSafe() {
  try {
    const y = await fetchYahooQuote("SETFGOLD.NS");
    if (Number.isFinite(y.latestPrice)) {
      return {
        value: y.latestPrice,
        asOf: y.asOf,
        source: { provider: "yahoo", symbol: "SETFGOLD.NS" }
      };
    }
    throw new Error("SETFGOLD latest price missing");
  } catch (e) {
    return {
      value: null,
      asOf: null,
      source: { provider: "yahoo", symbol: "SETFGOLD.NS", note: "setfgold_fetch_failed" },
      error: "setfgold_fetch_failed"
    };
  }
}

async function getDxy() {
  try {
    const y = await fetchYahooChart("DX-Y.NYB");
    if (Number.isFinite(y.latestPrice)) {
      return {
        value: y.latestPrice,
        source: { provider: "yahoo", symbol: "DX-Y.NYB" }
      };
    }
  } catch (e) {}

  const s = await fetchStooqClose("dx.f");
  return {
    value: s.last,
    source: { provider: "stooq", symbol: "dx.f" }
  };
}

async function getUsdInr() {
  const pctToTrend = (pct) => {
    if (typeof pct !== "number" || !Number.isFinite(pct)) return "stable";
    if (pct > 0.5) return "weakening";
    if (pct < -0.5) return "strengthening";
    return "stable";
  };

  try {
    const y = await fetchYahooChart("INR=X");
    const pct30d = y.pctChangeFromFirstPoint;

    return {
      value: numberOrNull(y.latestPrice),
      pct30d: numberOrNull(pct30d),
      trend: pctToTrend(pct30d),
      source: { provider: "yahoo", symbol: "INR=X", window: "1mo" }
    };
  } catch (e) {}

  const s = await fetchStooqClose("usdinr", true);
  return {
    value: numberOrNull(s.last),
    pct30d: numberOrNull(s.pct30d),
    trend: pctToTrend(s.pct30d),
    source: { provider: "stooq", symbol: "usdinr", window: "30d" }
  };
}

/* -------------------- RSI(14) -------------------- */

async function getRsi14(symbol) {
  const source = { provider: "yahoo", symbol, window: "3mo", interval: "1d" };
  const data = await fetchYahooCloses(symbol, "3mo", "1d");
  const rsi = computeRsi14(data.closes);
  return { value: rsi, asOf: data.asOf, source };
}

async function getRsi14Safe(symbol) {
  try {
    return await getRsi14(symbol);
  } catch (e) {
    return {
      value: null,
      asOf: null,
      source: { provider: "yahoo", symbol, window: "3mo", interval: "1d", note: "rsi_fetch_failed" },
      error: "rsi_fetch_failed"
    };
  }
}

function computeRsi14(closes) {
  const period = 14;
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

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
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return Math.round(rsi * 10) / 10;
}

/* -------------------- SBI iNAV -------------------- */

async function getSbiGoldEtfInavSafe() {
  try {
    const url = "https://etf.sbimf.com/home/GetETFNAVDetailsAsync";
    const res = await fetch(url, {
      headers: {
        "accept": "application/json",
        "user-agent": "Mozilla/5.0"
      }
    });

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
      source: {
        provider: "sbimf",
        endpoint: "/home/GetETFNAVDetailsAsync",
        fundName: row.FundName
      }
    };
  } catch (e) {
    return {
      value: null,
      asOf: null,
      source: {
        provider: "sbimf",
        endpoint: "/home/GetETFNAVDetailsAsync",
        note: "inav_fetch_failed"
      },
      error: "inav_fetch_failed"
    };
  }
}

/* -------------------- yahoo helpers -------------------- */

async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept": "application/json,text/plain,*/*"
    }
  });

  if (!res.ok) throw new Error(`Yahoo fetch failed for ${symbol}: HTTP ${res.status}`);

  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo parse failed for ${symbol}`);

  const meta = result.meta || {};
  const latestPrice =
    (typeof meta.regularMarketPrice === "number" && Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : null) ??
    (typeof meta.previousClose === "number" && Number.isFinite(meta.previousClose) ? meta.previousClose : null);

  const asOf = meta?.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : new Date().toISOString();

  return { latestPrice, asOf };
}

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept": "application/json,text/plain,*/*"
    }
  });

  if (!res.ok) throw new Error(`Yahoo fetch failed for ${symbol}: HTTP ${res.status}`);

  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo parse failed for ${symbol}`);

  const meta = result.meta || {};
  const latestPrice =
    (typeof meta.regularMarketPrice === "number" && Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : null) ??
    (typeof meta.previousClose === "number" && Number.isFinite(meta.previousClose) ? meta.previousClose : null);

  const closes = result?.indicators?.quote?.[0]?.close || [];
  const first = closes.find((x) => typeof x === "number" && Number.isFinite(x));
  const last = [...closes].reverse().find((x) => typeof x === "number" && Number.isFinite(x));

  let pctChangeFromFirstPoint = null;
  if (typeof first === "number" && typeof last === "number" && first !== 0) {
    pctChangeFromFirstPoint = ((last - first) / first) * 100;
  }

  return { latestPrice, pctChangeFromFirstPoint };
}

async function fetchYahooCloses(symbol, range = "3mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept": "application/json,text/plain,*/*"
    }
  });

  if (!res.ok) throw new Error(`Yahoo fetch failed for ${symbol}: HTTP ${res.status}`);

  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo parse failed for ${symbol}`);

  const closesRaw = result?.indicators?.quote?.[0]?.close || [];
  const closes = closesRaw.filter(x => typeof x === "number" && Number.isFinite(x));
  if (closes.length < 20) throw new Error(`Not enough close data for RSI(14): ${symbol}`);

  const meta = result.meta || {};
  const asOf = meta?.regularMarketTime
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : new Date().toISOString();

  return { closes, asOf };
}

/* -------------------- stooq / fred helpers -------------------- */

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
  const res = await fetch(url, {
    headers: {
      "accept": "text/csv,*/*",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) throw new Error(`FRED fetch failed for ${seriesId}: HTTP ${res.status}`);

  const text = await res.text();
  return parseFredCsvLastValue(text, seriesId);
}

async function fetchFredLastValueAlt(seriesId) {
  const url = `https://fred.stlouisfed.org/series/${encodeURIComponent(seriesId)}/downloaddata/${encodeURIComponent(seriesId)}.csv`;
  const res = await fetch(url, {
    headers: {
      "accept": "text/csv,*/*",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) throw new Error(`FRED alt fetch failed for ${seriesId}: HTTP ${res.status}`);

  const text = await res.text();
  return parseFredCsvLastValue(text, seriesId);
}

function parseFredCsvLastValue(text, seriesId) {
  const lines = text.trim().split(/\r?\n/);

  for (let i = lines.length - 1; i >= 1; i--) {
    const parts = lines[i].split(",");
    if (parts.length >= 2) {
      const raw = String(parts[1]).replace(/"/g, "").trim();
      const v = parseFloat(raw);
      if (Number.isFinite(v)) return v;
    }
  }

  throw new Error(`No numeric value found in FRED CSV for ${seriesId}`);
}

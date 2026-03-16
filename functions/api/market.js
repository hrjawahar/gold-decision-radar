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

    const fedObj = buildFedSignal(realYieldObj?.value);

    const result = {
      dxy: numberOrNull(dxyObj?.value),

      usdInr: numberOrNull(inrObj?.value),
      usdInrChangePct30d: numberOrNull(inrObj?.pct30d),
      usdInrTrend: inrObj?.trend ?? "stable",

      realYield: numberOrNull(realYieldObj?.value),
      realYieldAsOf: realYieldObj?.asOf ?? null,

      fedSignal: fedObj.signal,
      fedSignalScore: fedObj.score,
      fedSignalReason: fedObj.reason,

      setfGoldPrice: numberOrNull(goldObj?.value),
      setfGoldPriceAsOf: goldObj?.asOf ?? null,

      rsi14Setfgold: numberOrNull(rsiObj?.value),
      rsi14SetfgoldAsOf: rsiObj?.asOf ?? null,

      sbiGoldEtfInav: numberOrNull(sbiInavObj?.value),
      sbiGoldEtfInavAsOf: sbiInavObj?.asOf ?? null,

      asOf: new Date().toISOString(),
      contractVersion: 6,

      quality: {
        dxy: numberOrNull(dxyObj?.value) !== null ? "ok" : "missing",
        usdInr: numberOrNull(inrObj?.value) !== null ? "ok" : "missing",
        realYield: numberOrNull(realYieldObj?.value) !== null ? "ok" : "missing",
        fedSignal: fedObj.signal !== "unknown" ? "ok" : "missing",
        setfGoldPrice: numberOrNull(goldObj?.value) !== null ? "ok" : "missing",
        rsi14Setfgold: numberOrNull(rsiObj?.value) !== null ? "ok" : "missing",
        sbiGoldEtfInav: numberOrNull(sbiInavObj?.value) !== null ? "ok" : "missing"
      },

      freshness: {
        dxy: dxyObj?.source ?? null,
        usdInr: inrObj?.source ?? null,
        realYield: realYieldObj?.source ?? null,
        fedSignal: {
          provider: "derived",
          basis: "realYield",
          thresholds: {
            dovish_max: 1.2,
            neutral_max: 1.8
          }
        },
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

function monthPadded(n) {
  return String(n).padStart(2, "0");
}

function buildFedSignal(realYield) {
  if (!Number.isFinite(realYield)) {
    return {
      signal: "unknown",
      score: 0,
      reason: "Real yield unavailable"
    };
  }

  if (realYield <= 1.2) {
    return {
      signal: "dovish",
      score: 1,
      reason: "Low real yield usually supports easier financial conditions and gold"
    };
  }

  if (realYield <= 1.8) {
    return {
      signal: "neutral",
      score: 0,
      reason: "Mid-range real yield suggests mixed Fed pressure"
    };
  }

  return {
    signal: "hawkish",
    score: -1,
    reason: "Higher real yield usually reflects tighter Fed/financial conditions and is less supportive for gold"
    };
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

/* -------------------- REAL YIELD: Treasury primary, FRED backup -------------------- */

/* -------------------- REAL YIELD: Treasury CSV primary, Treasury HTML backup, FRED last -------------------- */

async function getRealYieldSafe() {
  const errors = [];

  try {
    return await getRealYieldFromTreasuryCsv();
  } catch (e) {
    errors.push(`treasury_csv -> ${String(e?.message || e)}`);
  }

  try {
    return await getRealYieldFromTreasuryTextView();
  } catch (e) {
    errors.push(`treasury_html -> ${String(e?.message || e)}`);
  }

  try {
    return await getRealYieldFromFredCsv("DFII10");
  } catch (e) {
    errors.push(`fred -> ${String(e?.message || e)}`);
  }

  return {
    value: null,
    asOf: null,
    source: {
      provider: "treasury/fred",
      series: "DFII10",
      note: "real_yield_fetch_failed",
      detail: errors.join(" | ").slice(0, 700)
    },
    error: "real_yield_fetch_failed"
  };
}

async function getRealYieldFromTreasuryCsv() {
  const year = new Date().getUTCFullYear();

  // Treasury nominal rates already expose a CSV endpoint with this shape.
  // For real yields, the same family works with type=daily_treasury_real_yield_curve.
  const url =
    `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/` +
    `daily-treasury-rates.csv/${year}/all?_format=csv&field_tdr_date_value=${year}` +
    `&page=&type=daily_treasury_real_yield_curve&_=${Date.now()}`;

  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "accept": "text/csv,text/plain;q=0.9,*/*;q=0.8",
      "cache-control": "no-cache",
      "pragma": "no-cache",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) {
    throw new Error(`Treasury CSV HTTP ${res.status}`);
  }

  const text = await res.text();
  const parsed = parseTreasuryRealYieldCsv(text);

  if (!parsed || !Number.isFinite(parsed.value)) {
    throw new Error("Treasury CSV parse failed");
  }

  return {
    value: parsed.value,
    asOf: parsed.asOf,
    source: {
      provider: "treasury",
      type: "daily_treasury_real_yield_curve",
      format: "csv",
      url
    }
  };
}

function parseTreasuryRealYieldCsv(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Treasury CSV empty");
  }

  const cleaned = text.replace(/^\uFEFF/, "").trim();
  const lines = cleaned.split(/\r?\n/).filter(Boolean);

  if (lines.length < 2) {
    throw new Error("Treasury CSV too few lines");
  }

  const header = splitCsvLine(lines[0]).map(s => s.trim().replace(/^"|"$/g, ""));
  const tenIdx = header.findIndex(h => /^10\s*yr$/i.test(h) || /^10\s*year$/i.test(h));
  const dateIdx = header.findIndex(h => /^date$/i.test(h));

  if (dateIdx === -1 || tenIdx === -1) {
    throw new Error(`Treasury CSV header missing Date/10 Yr: ${header.join(" | ")}`);
  }

  for (let i = lines.length - 1; i >= 1; i--) {
    const row = splitCsvLine(lines[i]).map(s => s.trim().replace(/^"|"$/g, ""));
    if (row.length <= Math.max(dateIdx, tenIdx)) continue;

    const rawDate = row[dateIdx];
    const rawValue = row[tenIdx];

    if (!rawValue || rawValue === "N/A") continue;

    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;

    return {
      value,
      asOf: normalizeUsDate(rawDate)
    };
  }

  throw new Error("No numeric 10Y real yield found in Treasury CSV");
}

async function getRealYieldFromTreasuryTextView() {
  const year = new Date().getUTCFullYear();
  const url =
    `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/` +
    `TextView?field_tdr_date_value=${year}&type=daily_treasury_real_yield_curve&_=${Date.now()}`;

  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "accept": "text/html,text/plain;q=0.9,*/*;q=0.8",
      "cache-control": "no-cache",
      "pragma": "no-cache",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) {
    throw new Error(`Treasury TextView HTTP ${res.status}`);
  }

  const html = await res.text();
  const parsed = parseTreasuryRealYieldHtml(html);

  if (!parsed || !Number.isFinite(parsed.value)) {
    throw new Error("Treasury HTML parse failed");
  }

  return {
    value: parsed.value,
    asOf: parsed.asOf,
    source: {
      provider: "treasury",
      type: "daily_treasury_real_yield_curve",
      format: "html",
      url
    }
  };
}

function parseTreasuryRealYieldHtml(html) {
  if (!html || typeof html !== "string") {
    throw new Error("Treasury HTML empty");
  }

  // Grab table rows, then table cells.
  const rowMatches = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (!rowMatches.length) {
    throw new Error("No <tr> rows found");
  }

  for (let i = rowMatches.length - 1; i >= 0; i--) {
    const rowHtml = rowMatches[i][1];
    const cells = [...rowHtml.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => stripHtml(m[1]).trim())
      .filter(Boolean);

    // Expected row shape: Date, 5 YR, 7 YR, 10 YR, 20 YR, 30 YR
    if (cells.length < 4) continue;
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(cells[0])) continue;

    const rawDate = cells[0];
    const raw10yr = cells[3];

    if (!raw10yr || /^n\/a$/i.test(raw10yr)) continue;

    const value = Number(raw10yr.replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(value)) continue;

    return {
      value,
      asOf: normalizeUsDate(rawDate)
    };
  }

  throw new Error("No valid Treasury 10Y real yield row found");
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }

    cur += ch;
  }

  out.push(cur);
  return out;
}

function normalizeUsDate(rawDate) {
  if (!rawDate || !/^\d{2}\/\d{2}\/\d{4}$/.test(rawDate)) return rawDate || null;
  const [mm, dd, yyyy] = rawDate.split("/");
  return `${yyyy}-${mm}-${dd}`;
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
  const yahooSymbols = ["DX-Y.NYB", "DX=F"];

  for (const symbol of yahooSymbols) {
    try {
      const y = await fetchYahooChart(symbol);
      if (Number.isFinite(y.latestPrice)) {
        return {
          value: y.latestPrice,
          source: { provider: "yahoo", symbol }
        };
      }
    } catch (e) {}
  }

  const stooqSymbols = ["dx.f", "usdidx"];
  for (const symbol of stooqSymbols) {
    try {
      const s = await fetchStooqClose(symbol);
      if (Number.isFinite(s.last)) {
        return {
          value: s.last,
          source: { provider: "stooq", symbol }
        };
      }
    } catch (e) {}
  }

  throw new Error("DXY unavailable from yahoo and stooq");
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

    const inav =
      Number(row.LatestNAV) ||
      Number(row.iNAV) ||
      Number(row.NAV);

    if (!Number.isFinite(inav)) throw new Error("SBI Gold ETF LatestNAV not numeric");

    return {
      value: inav,
      asOf: row.LatestNAVDate || row.NavDate || null,
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d&_=${Date.now()}`;
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d&_=${Date.now()}`;
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
  const first = closes.find(x => typeof x === "number" && Number.isFinite(x));
  const last = [...closes].reverse().find(x => typeof x === "number" && Number.isFinite(x));

  let pctChangeFromFirstPoint = null;
  if (typeof first === "number" && typeof last === "number" && first !== 0) {
    pctChangeFromFirstPoint = ((last - first) / first) * 100;
  }

  return { latestPrice, pctChangeFromFirstPoint };
}

async function fetchYahooCloses(symbol, range = "3mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&_=${Date.now()}`;
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

/* -------------------- stooq helpers -------------------- */

async function fetchStooqClose(symbol, computePct = false) {
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&i=d&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      "accept": "text/csv",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!res.ok) throw new Error(`Stooq fetch failed for ${symbol}: HTTP ${res.status}`);

  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error(`Stooq CSV empty for ${symbol}`);

  const rows = lines.slice(1, 31).map(line => line.split(",")).filter(p => p.length >= 5);
  const closes = rows.map(r => parseFloat(r[4])).filter(n => Number.isFinite(n));

  if (!closes.length) throw new Error(`Stooq close parse failed for ${symbol}`);

  const last = closes[0];
  const oldest = closes[closes.length - 1];

  let pct30d = null;
  if (computePct && Number.isFinite(last) && Number.isFinite(oldest) && oldest !== 0) {
    pct30d = ((last - oldest) / oldest) * 100;
  }

  return { last, pct30d };
}

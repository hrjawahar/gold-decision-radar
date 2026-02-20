export async function onRequestGet() {
  const cacheSeconds = 120;

  try {
    const [dxyObj, inrObj, realYieldObj, rsiObj, sbiInavObj] = await Promise.all([
      getDxy(),
      getUsdInr(),
      getRealYield(),
      getRsi14Safe("SETFGOLD.NS"),
      getSbiGoldEtfInavSafe()
    ]);

    const result = {
      dxy: dxyObj?.value ?? null,
      realYield: realYieldObj?.value ?? null,
      usdInr: inrObj?.value ?? null,
      usdInrChangePct30d: inrObj?.pct30d ?? null,
      usdInrTrend: inrObj?.trend ?? null,

      rsi14Setfgold: rsiObj?.value ?? null,
      rsi14SetfgoldAsOf: rsiObj?.asOf ?? null,

      sbiGoldEtfInav: sbiInavObj?.value ?? null,
      sbiGoldEtfInavAsOf: sbiInavObj?.asOf ?? null,

      asOf: new Date().toISOString(),

      freshness: {
        dxy: dxyObj?.source ?? null,
        usdInr: inrObj?.source ?? null,
        realYield: realYieldObj?.source ?? null,
        rsi: rsiObj?.source ?? null,
        sbiInav: sbiInavObj?.source ?? null
      },

      sources: {
        yahoo: "https://query1.finance.yahoo.com/v8/finance/chart/",
        stooq: "https://stooq.com/q/l/",
        fred: "https://fred.stlouisfed.org/graph/fredgraph.csv",
        sbimf: "https://etf.sbimf.com/home/GetETFNAVDetailsAsync"
      }
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

/* -------------------- existing factors -------------------- */

async function getDxy() {
  try {
    const y = await fetchYahooChart("DX-Y.NYB");
    if (Number.isFinite(y.latestPrice)) return { value: y.latestPrice, source: { provider: "yahoo", symbol: "DX-Y.NYB" } };
  } catch (e) {}
  const s = await fetchStooqClose("dx.f");
  return { value: s.last, source: { provider: "stooq", symbol: "dx.f" } };
}

async function getUsdInr() {
  try {
    const y = await fetchYahooChart("INR=X");
    if (Number.isFinite(y.latestPrice)) return { value: y.latestPrice, pct30d: y.pctChangeFromFirstPoint, source: { provider: "yahoo", symbol: "INR=X", window: "1mo" } };
  } catch (e) {}
  const s = await fetchStooqClose("usdinr", true);
  return { value: s.last, pct30d: s.pct30d, source: { provider: "stooq", symbol: "usdinr", window: "30d" } };
}

async function getRealYield() {
  const v = await fetchFredLastValue("DFII10");
  return { value: v, source: { provider: "fred", series: "DFII10" } };
}

/* -------------------- RSI(14) for SETFGOLD -------------------- */

async function getRsi14(symbol) {
  const source = { provider: "yahoo", symbol, window: "3mo", interval: "1d" };
  const data = await fetchYahooCloses(symbol, "3mo", "1d");
  const rsi = computeRsi14(data.closes);
  return { value: rsi, asOf: data.asOf, source };
}

async function fetchYahooCloses(symbol, range = "3mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0", "accept": "application/json,text/plain,*/*" } });
  if (!res.ok) throw new Error(`Yahoo fetch failed for ${symbol}: HTTP ${res.status}`);
  const j = await res.json();
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo parse failed for ${symbol}`);

  const closesRaw = result?.indicators?.quote?.[0]?.close || [];
  const closes = closesRaw.filter(x => typeof x === "number" && Number.isFinite(x));
  if (closes.length < 20) throw new Error(`Not enough close data for RSI(14): ${symbol}`);

  const meta = result.meta || {};
  const asOf = meta?.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString();
  return { closes, asOf };
}
async function getSbiGoldEtfInavSafe() {
  try {
    const url = "https://etf.sbimf.com/home/GetETFNAVDetailsAsync";
    const res = await fetch(url, { headers: { "accept": "application/json" }});
    if (!res.ok) throw new Error(`SBI iNAV fetch failed: HTTP ${res.status}`);

    const j = await res.json();
    const rows = Array.isArray(j?.Data) ? j.Data : [];
    if (!rows.length) throw new Error("SBI iNAV: empty Data");

    // Find SBI Gold ETF row
    const row =
      rows.find(r => /sbi\s*gold\s*etf/i.test(String(r.FundName || ""))) ||
      rows.find(r => /gold/i.test(String(r.FundName || "")) && /etf/i.test(String(r.FundName || "")));

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
  return Math.round(rsi * 10) / 10; // 1 decimal
}

/* -------------------- existing helpers -------------------- */

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

async function fetchStooqClose(symbol, computePct=false) {
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
async function getRsi14Safe(symbol) {
  try {
    return await getRsi14(symbol);
  } catch (e) {
    // Don't fail the whole API if RSI fetch fails
    return {
      value: null,
      asOf: null,
      source: { provider: "yahoo", symbol, window: "3mo", interval: "1d", note: "rsi_fetch_failed" }
    };
  }
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

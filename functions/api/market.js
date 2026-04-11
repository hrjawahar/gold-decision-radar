export async function onRequestGet() {
  const cacheSeconds = 120;

  const errors = [];

  async function tryFetch(name, fn, fallback = {}) {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${name}: ${String(e?.message || e)}`);
      return fallback;
    }
  }

  const dxyObj = await tryFetch("dxy", getDxy, { value: null });
  const inrObj = await tryFetch("usdInr", getUsdInr, { value: null, pct30d: null, trend: "stable" });
  const realYieldObj = await tryFetch("realYield", getRealYield, { value: null, asOf: null });
  const goldTrendObj = await tryFetch("setfGold", () => getSetfGoldTrend("SETFGOLD.NS"), {
    value: null,
    asOf: null,
    prevClose: null,
    changePct1d: null,
    changePct5d: null,
    trend: "flat"
  });
  const rsiObj = await tryFetch("rsi14Setfgold", () => getRsi14("SETFGOLD.NS"), { value: null, asOf: null });
  const sbiInavObj = await tryFetch("sbiInav", getSbiGoldEtfInav, { value: null, asOf: null });

  const domesticPremiumPct =
    Number.isFinite(goldTrendObj?.value) &&
    Number.isFinite(sbiInavObj?.value) &&
    sbiInavObj.value !== 0
      ? round2(((goldTrendObj.value - sbiInavObj.value) / sbiInavObj.value) * 100)
      : null;

  const result = {
    dxy: num(dxyObj?.value),

    usdInr: num(inrObj?.value),
    usdInrChangePct30d: num(inrObj?.pct30d),
    usdInrTrend: inrObj?.trend ?? "stable",

    realYield: num(realYieldObj?.value),
    realYieldAsOf: realYieldObj?.asOf ?? null,

    setfGoldPrice: num(goldTrendObj?.value),
    setfGoldPriceAsOf: goldTrendObj?.asOf ?? null,
    setfGoldPrevClose: num(goldTrendObj?.prevClose),
    setfGoldChangePct1d: num(goldTrendObj?.changePct1d),
    setfGoldChangePct5d: num(goldTrendObj?.changePct5d),
    setfGoldTrend: goldTrendObj?.trend ?? "flat",

    rsi14Setfgold: num(rsiObj?.value),
    rsi14SetfgoldAsOf: rsiObj?.asOf ?? null,

    sbiGoldEtfInav: num(sbiInavObj?.value),
    sbiGoldEtfInavAsOf: sbiInavObj?.asOf ?? null,

    domesticPremiumPct,

    asOf: new Date().toISOString(),
    contractVersion: 7,
    errors
  };

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${cacheSeconds}`
    }
  });
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round2(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

async function getSetfGoldTrend(symbol) {
  const data = await fetchYahooCloses(symbol, "1mo", "1d");
  const closes = data.closes;

  const latest = closes[closes.length - 1];
  const prev = closes.length >= 2 ? closes[closes.length - 2] : null;
  const ref5 = closes.length >= 6 ? closes[closes.length - 6] : closes[0];

  const changePct1d =
    Number.isFinite(latest) && Number.isFinite(prev) && prev !== 0
      ? ((latest - prev) / prev) * 100
      : null;

  const changePct5d =
    Number.isFinite(latest) && Number.isFinite(ref5) && ref5 !== 0
      ? ((latest - ref5) / ref5) * 100
      : null;

  let trend = "flat";
  if (Number.isFinite(changePct5d)) {
    if (changePct5d > 0.4) trend = "rising";
    else if (changePct5d < -0.4) trend = "falling";
  }

  return {
    value: latest,
    asOf: data.asOf,
    prevClose: prev,
    changePct1d: round2(changePct1d),
    changePct5d: round2(changePct5d),
    trend
  };
}

async function getDxy() {
  const j = await fetchJson("https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=1mo&interval=1d");
  const result = j?.chart?.result?.[0];
  const val = result?.meta?.regularMarketPrice;
  if (!Number.isFinite(val)) throw new Error("Yahoo DXY missing price");
  return { value: val };
}

async function getUsdInr() {
  const j = await fetchJson("https://query1.finance.yahoo.com/v8/finance/chart/INR=X?range=1mo&interval=1d");
  const result = j?.chart?.result?.[0];
  const closes = (result?.indicators?.quote?.[0]?.close || []).filter(x => typeof x === "number" && Number.isFinite(x));
  if (closes.length < 2) throw new Error("Yahoo INR=X insufficient closes");

  const first = closes[0];
  const last = closes[closes.length - 1];
  const pct = ((last - first) / first) * 100;

  return {
    value: last,
    pct30d: round2(pct),
    trend: pct > 0.5 ? "weakening" : pct < -0.5 ? "strengthening" : "stable"
  };
}

async function getRealYield() {
  const res = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10", {
    method: "GET",
    headers: { "accept": "text/csv,text/plain,*/*" }
  });

  if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);

  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("FRED too few rows");

  for (let i = lines.length - 1; i >= 1; i--) {
    const [date, raw] = lines[i].split(",");
    if (raw && raw !== ".") {
      const value = Number(raw);
      if (Number.isFinite(value)) return { value, asOf: date };
    }
  }

  throw new Error("FRED no numeric value");
}

async function getRsi14(symbol) {
  const data = await fetchYahooCloses(symbol, "3mo", "1d");
  const rsi = computeRsi14(data.closes);
  return { value: rsi, asOf: data.asOf };
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
  return Math.round((100 - (100 / (1 + rs))) * 10) / 10;
}

async function getSbiGoldEtfInav() {
  const j = await fetchJson("https://etf.sbimf.com/home/GetETFNAVDetailsAsync");
  const rows = Array.isArray(j?.Data) ? j.Data : [];
  const row = rows.find(r => /sbi\s+gold\s+etf/i.test(String(r.FundName || "")));
  if (!row) throw new Error("SBI Gold ETF row not found");

  const value = Number(row.LatestNAV || row.iNAV || row.NAV);
  if (!Number.isFinite(value)) throw new Error("SBI NAV not numeric");

  return {
    value,
    asOf: row.LatestNAVDate || row.NavDate || null
  };
}

async function fetchYahooCloses(symbol, range = "1mo", interval = "1d") {
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`);
  const result = j?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo parse failed for ${symbol}`);

  const closes = (result?.indicators?.quote?.[0]?.close || []).filter(x => typeof x === "number" && Number.isFinite(x));
  if (closes.length < 2) throw new Error(`Yahoo insufficient closes for ${symbol}`);

  const asOf = result?.meta?.regularMarketTime
    ? new Date(result.meta.regularMarketTime * 1000).toISOString()
    : new Date().toISOString();

  return { closes, asOf };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "accept": "application/json,text/plain,*/*"
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

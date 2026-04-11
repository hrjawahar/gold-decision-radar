export async function onRequestGet() {
  const cacheSeconds = 120;
  const errors = [];

  const dxyObj = await tryFetch("dxy", getDxy, { value: null }, errors);
  const inrObj = await tryFetch("usdInr", getUsdInr, { value: null, pct30d: null, trend: "stable" }, errors);
  const realYieldObj = await tryFetch("realYield", getRealYield, { value: null, asOf: null }, errors);
  const goldTrendObj = await tryFetch("setfGold", () => getSetfGoldTrend("setfgold.ns"), {
    value: null, asOf: null, prevClose: null, changePct1d: null, changePct5d: null, trend: "flat"
  }, errors);
  const rsiObj = await tryFetch("rsi14Setfgold", () => getRsi14("setfgold.ns"), { value: null, asOf: null }, errors);
  const sbiInavObj = await tryFetch("sbiInav", getSbiGoldEtfInav, { value: null, asOf: null }, errors);

  const domesticPremiumPct =
    num(goldTrendObj?.value) !== null &&
    num(sbiInavObj?.value) !== null &&
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
    contractVersion: 8,
    errors
  };

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${cacheSeconds}`
    }
  });
}

/* ---------------- utilities ---------------- */

async function tryFetch(name, fn, fallback, errors) {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${name}: ${String(e.message || e)}`);
    return fallback;
  }
}

function num(v) {
  return (typeof v === "number" && Number.isFinite(v)) ? v : null;
}

function round2(v) {
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

/* ---------------- DXY ---------------- */

async function getDxy() {
  // Stooq first
  const s = await fetchCsv("https://stooq.com/q/d/l/?s=dx.f&i=d");
  const last = Number(s.at(-1)?.close);
  if (Number.isFinite(last)) return { value: last };

  // fallback yahoo
  const j = await fetchJson("https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB");
  const val = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!Number.isFinite(val)) throw new Error("DXY unavailable");
  return { value: val };
}

/* ---------------- USDINR ---------------- */

async function getUsdInr() {
  const rows = await fetchCsv("https://stooq.com/q/d/l/?s=usdinr&i=d");
  const closes = rows.map(r => Number(r.close)).filter(Number.isFinite);
  const last = closes.at(-1);
  const first = closes.at(-22);

  const pct = ((last - first) / first) * 100;

  return {
    value: last,
    pct30d: round2(pct),
    trend: pct > 0.5 ? "weakening" : pct < -0.5 ? "strengthening" : "stable"
  };
}

/* ---------------- REAL YIELD ---------------- */

async function getRealYield() {
  const year = new Date().getUTCFullYear();
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_real_yield_curve`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("Treasury fetch failed");

  const text = await res.text();
  const lines = text.trim().split("\n");
  const header = lines[0].split(",");

  const idx = header.findIndex(h => /10\s*Yr/i.test(h));
  const last = lines.at(-1).split(",");

  return {
    value: Number(last[idx]),
    asOf: last[0]
  };
}

/* ---------------- SETFGOLD ---------------- */

async function getSetfGoldTrend(symbol) {
  const rows = await fetchCsv(`https://stooq.com/q/d/l/?s=${symbol}&i=d`);
  const closes = rows.map(r => Number(r.close)).filter(Number.isFinite);

  const latest = closes.at(-1);
  const prev = closes.at(-2);
  const ref5 = closes.at(-6);

  const c1 = ((latest - prev) / prev) * 100;
  const c5 = ((latest - ref5) / ref5) * 100;

  let trend = "flat";
  if (c5 > 0.4) trend = "rising";
  else if (c5 < -0.4) trend = "falling";

  return {
    value: latest,
    prevClose: prev,
    changePct1d: round2(c1),
    changePct5d: round2(c5),
    trend,
    asOf: rows.at(-1).date
  };
}

/* ---------------- RSI ---------------- */

async function getRsi14(symbol) {
  return { value: null }; // keep lightweight
}

/* ---------------- SBI iNAV (optional) ---------------- */

async function getSbiGoldEtfInav() {
  const res = await fetch("https://etf.sbimf.com/home/GetETFNAVDetailsAsync");
  const text = await res.text();
  if (text.startsWith("<")) throw new Error("SBI blocked");
  const j = JSON.parse(text);

  const row = j.Data.find(x => /SBI Gold ETF/i.test(x.FundName));
  return {
    value: Number(row.LatestNAV),
    asOf: row.LatestNAVDate
  };
}

/* ---------------- helpers ---------------- */

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*",
      "Cache-Control": "no-cache"
    }
  });

  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function fetchCsv(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/csv,text/plain,*/*",
      "Cache-Control": "no-cache"
    }
  });

  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  const text = await r.text();
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",");

  return lines.slice(1).map(line => {
    const parts = line.split(",");
    const obj = {};
    headers.forEach((h,i)=>obj[h.trim().toLowerCase()]=parts[i]);
    return obj;
  });
}

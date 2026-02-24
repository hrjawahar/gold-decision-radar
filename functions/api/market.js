// functions/api/market.js
// Backend: DXY + USD/INR (spot + 30d % + trend) + US 10Y Real Yield (FRED)
// + SETFGOLD price + RSI(14)
// Safe-by-default: returns JSON with nulls instead of crashing.

export async function onRequestGet({ request }) {
  const url = new URL(request.url);

  // ?inav=off -> kept for compatibility, but not required for core fields
  const inavParam = (url.searchParams.get("inav") || "").toLowerCase();
  const inavOff = (inavParam === "off" || inavParam === "0" || inavParam === "false");

  const errors = [];

  const safe = async (fn, label) => {
    try {
      return await fn();
    } catch (e) {
      errors.push(`${label}: ${String(e?.message || e)}`);
      return null;
    }
  };

  // --- Core market components ---
  const dxyObj = await safe(() => getDxy(), "dxy");
  const inrObj = await safe(() => getUsdInr(), "usdInr");
  const realYieldVal = await safe(() => fetchFredLastValue("DFII10"), "realYield");

  // --- SETFGOLD ---
  const setfPriceObj = await safe(() => fetchYahooChart("SETFGOLD.NS"), "setfGoldPrice");
  const rsiObj = await safe(() => getRsi14Safe("SETFGOLD.NS"), "rsi");

  // Optional iNAV fetch removed from core build to keep it stable
  // If you still want it later, add back safely (guarded) in a separate step.

  const result = {
    dxy: dxyObj?.value ?? null,

    usdInr: inrObj?.value ?? null,
    usdInrChangePct30d: inrObj?.pct30d ?? null,
    usdInrTrend: inrObj?.trend ?? null,

    realYield: (typeof realYieldVal === "number" && Number.isFinite(realYieldVal)) ? realYieldVal : null,

    setfGoldPrice:
      (typeof setfPriceObj?.latestPrice === "number" && Number.isFinite(setfPriceObj.latestPrice))
        ? setfPriceObj.latestPrice
        : null,
    setfGoldPriceAsOf: new Date().toISOString(),

    rsi14Setfgold: rsiObj?.value ?? null,
    rsi14SetfgoldAsOf: rsiObj?.asOf ?? null,

    asOf: new Date().toISOString(),

    // Keep your freshness structure (minimal but valid)
    freshness: {
      dxy: dxyObj?.source ?? null,
      usdInr: inrObj?.source ?? null,
      realYield: { provider: "fred", series: "DFII10" },
      setfGoldPrice: { provider: "yahoo", symbol: "SETFGOLD.NS", window: "1mo" },
      rsi: rsiObj?.source ?? null,
      inav: inavOff ? { note: "inav_off" } : { note: "inav_not_used_in_core" }
    },

    errors
  };

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    }
  });
}

/* ------------------------------------------------------------------
   IMPORTANT:
   The functions below must already exist in your codebase (same file
   or imported in this file). If they are currently defined elsewhere,
   keep them there and import them, OR paste their definitions below.

   Required functions used above:
   - getDxy()
   - getUsdInr()
   - fetchFredLastValue(seriesId)
   - fetchYahooChart(symbol)
   - getRsi14Safe(symbol)
------------------------------------------------------------------- */

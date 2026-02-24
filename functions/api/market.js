// functions/api/market.js
// Phase 1 backend: DXY + USD/INR (spot + 30d % + trend) + US 10Y Real Yield (FRED)
// Safe-by-default: returns JSON with nulls instead of crashing.

export async function onRequestGet({ request }) {
+  const url = new URL(request.url);
+
+  // ?inav=off  -> skip SBI iNAV fetch (lets you compare manual vs auto)
+  const inavParam = (url.searchParams.get("inav") || "").toLowerCase();
+  const inavOff = (inavParam === "off" || inavParam === "0" || inavParam === "false");
+
+  const errors = [];
+
+  const safe = async (fn, label) => {
+    try { return await fn(); }
+    catch (e) { errors.push(`${label}: ${String(e?.message || e)}`); return null; }
+  };
+
+  const dxyObj = await safe(() => getDxy(), "dxy");
+  const inrObj = await safe(() => getUsdInr(), "usdInr");
+  const realYieldVal = await safe(() => fetchFredLastValue("DFII10"), "realYield");
+
+  // SETFGOLD price + RSI (backend)
+  const setfPriceObj = await safe(() => fetchYahooChart("SETFGOLD.NS"), "setfGoldPrice");
+  const rsiObj = await safe(() => getRsi14Safe("SETFGOLD.NS"), "rsi");
+
+  // SBI iNAV (optional)
+  const sbiInavObj = inavOff ? null : await safe(() => getSbiGoldEtfInavSafe(), "sbiInav");
+
+  const result = {
+    dxy: dxyObj?.value ?? null,
+    usdInr: inrObj?.value ?? null,
+    usdInrChangePct30d: inrObj?.pct30d ?? null,
+    usdInrTrend: inrObj?.trend ?? null,
+
+    realYield: (typeof realYieldVal === "number" && Number.isFinite(realYieldVal)) ? realYieldVal : null,
+
+    setfGoldPrice: (typeof setfPriceObj?.latestPrice === "number" && Number.isFinite(setfPriceObj.latestPrice)) ? setfPriceObj.latestPrice : null,
+    setfGoldPriceAsOf: new Date().toISOString(),
+
+    rsi14Setfgold: rsiObj?.value ?? null,
+    rsi14SetfgoldAsOf: rsiObj?.asOf ?? null,
+
+    sbiGoldEtfInav: sbiInavObj?.value ?? null,
+    sbiGoldEtfInavAsOf: sbiInavObj?.asOf ?? null,
+
+    asOf: new Date().toISOString(),
+
+    freshness: {
+      dxy: dxyObj?.source ?? null,
+      usdInr: inrObj?.source ?? null,
+      realYield: { provider: "fred", series: "DFII10" },
+      setfGoldPrice: { provider: "yahoo", symbol: "SETFGOLD.NS", window: "1mo" },
+      rsi: rsiObj?.source ?? null,
+      sbiInav: inavOff
+        ? { provider: "sbimf", endpoint: "/home/GetETFNAVDetailsAsync", note: "inav_off" }
+        : (sbiInavObj?.source ?? { provider: "sbimf", endpoint: "/home/GetETFNAVDetailsAsync", note: "inav_fetch_failed" })
+    },
+
+    errors
+  };
+
+  return new Response(JSON.stringify(result), {
+    status: 200,
+    headers: {
+      "content-type": "application/json; charset=utf-8",
+      "cache-control": "no-store",
+      "access-control-allow-origin": "*"
+    }
+  });
+}

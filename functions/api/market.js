// functions/api/market.js
export async function onRequestGet() {

  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  };

  const response = {
    dxy: null,
    realYield: null,
    usdInr: null,
    usdInrChangePct30d: null,
    usdInrTrend: null,
    rsi14Setfgold: null,
    setfGoldPrice: null,
    sbiGoldEtfInav: null,
    sbiGoldEtfInavAsOf: null,
    freshness: {},
    asOf: new Date().toISOString(),
    errors: []
  };

  return new Response(JSON.stringify(response, null, 2), {
    status: 200,
    headers
  });
}

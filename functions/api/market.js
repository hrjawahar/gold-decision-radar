export async function onRequestGet() {
  const cacheSeconds = 120;

  try {
    const [dxyObj, inrObj, realYieldObj, goldTrendObj, rsiObj, sbiInavObj] = await Promise.all([
      getDxySafe(),
      getUsdInrSafe(),
      getRealYieldSafe(),
      getSetfGoldTrendSafe("SETFGOLD.NS"),
      getRsi14Safe("SETFGOLD.NS"),
      getSbiGoldEtfInavSafe()
    ]);

    const domesticPremiumPct =
      Number.isFinite(goldTrendObj?.value) &&
      Number.isFinite(sbiInavObj?.value) &&
      sbiInavObj.value !== 0
        ? ((goldTrendObj.value - sbiInavObj.value) / sbiInavObj.value) * 100
        : null;

    const result = {
      dxy: goldSafe(dxyObj?.value),

      usdInr: goldSafe(inrObj?.value),
      usdInrChangePct30d: goldSafe(inrObj?.pct30d),
      usdInrTrend: inrObj?.trend ?? "stable",

      realYield: goldSafe(realYieldObj?.value),
      realYieldAsOf: realYieldObj?.asOf ?? null,

      setfGoldPrice: goldSafe(goldTrendObj?.value),
      setfGoldPriceAsOf: goldTrendObj?.asOf ?? null,
      setfGoldPrevClose: goldSafe(goldTrendObj?.prevClose),
      setfGoldChangePct1d: goldSafe(goldTrendObj?.changePct1d),
      setfGoldChangePct5d: goldSafe(goldTrendObj?.changePct5d),
      setfGoldTrend: goldTrendObj?.trend ?? "flat",

      rsi14Setfgold: goldSafe(rsiObj?.value),
      rsi14SetfgoldAsOf: rsiObj?.asOf ?? null,

      sbiGoldEtfInav: goldSafe(sbiInavObj?.value),
      sbiGoldEtfInavAsOf: sbiInavObj?.asOf ?? null,

      domesticPremiumPct,

      asOf: new Date().toISOString(),
      contractVersion: 7
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${cacheSeconds}`
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      error: "market_api_failed",
      message: String(err),
      asOf: new Date().toISOString()
    }), { status: 500 });
  }
}

/* ---------- helpers ---------- */

function goldSafe(v){
  return (typeof v === "number" && Number.isFinite(v)) ? v : null;
}

/* ---------- safe wrappers ---------- */

async function getDxySafe(){
  try { return await getDxy(); }
  catch { return { value:null }; }
}

async function getUsdInrSafe(){
  try { return await getUsdInr(); }
  catch { return { value:null, trend:"stable" }; }
}

async function getRealYieldSafe(){
  try { return await getRealYield(); }
  catch { return { value:null }; }
}

async function getSetfGoldTrendSafe(symbol){
  try { return await getSetfGoldTrend(symbol); }
  catch { return { value:null, trend:"flat" }; }
}

async function getRsi14Safe(symbol){
  try { return await getRsi14(symbol); }
  catch { return { value:null }; }
}

/* ---------- core fetchers ---------- */

async function getSetfGoldTrend(symbol){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`;
  const res = await fetch(url);
  const j = await res.json();

  const closes = j.chart.result[0].indicators.quote[0].close
    .filter(x => typeof x === "number");

  const latest = closes.at(-1);
  const prev = closes.at(-2);
  const ref5 = closes.at(-6);

  const changePct1d = ((latest-prev)/prev)*100;
  const changePct5d = ((latest-ref5)/ref5)*100;

  let trend="flat";
  if(changePct5d>0.4) trend="rising";
  else if(changePct5d<-0.4) trend="falling";

  return {
    value:latest,
    prevClose:prev,
    changePct1d,
    changePct5d,
    trend,
    asOf:new Date().toISOString()
  };
}

/* ---------- simplified existing calls ---------- */

async function getDxy(){
  const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB");
  const j = await r.json();
  return { value:j.chart.result[0].meta.regularMarketPrice };
}

async function getUsdInr(){
  const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/INR=X?range=1mo&interval=1d");
  const j = await r.json();

  const closes = j.chart.result[0].indicators.quote[0].close
    .filter(x => typeof x === "number");

  const first = closes[0];
  const last = closes.at(-1);

  const pct = ((last-first)/first)*100;

  return {
    value:last,
    pct30d:pct,
    trend: pct>0.5?"weakening":pct<-0.5?"strengthening":"stable"
  };
}

async function getRealYield(){
  const r = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10");
  const text = await r.text();
  const lines = text.trim().split("\n");
  const last = lines.at(-1).split(",");
  return { value:Number(last[1]) };
}

async function getRsi14(symbol){
  return { value:null }; // keep lightweight
}

async function getSbiGoldEtfInavSafe(){
  try{
    const r = await fetch("https://etf.sbimf.com/home/GetETFNAVDetailsAsync");
    const j = await r.json();
    const row = j.Data.find(x=>/SBI Gold ETF/i.test(x.FundName));
    return { value:Number(row.LatestNAV) };
  }catch{
    return { value:null };
  }
}

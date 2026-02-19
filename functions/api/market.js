
export async function onRequestGet() {
const cacheSeconds = 300;

try {
const [dxyObj, inrObj, realYieldObj] = await Promise.all([
getDxy(),
getUsdInr(),
getRealYield()
]);

const pct30d = inrObj.pct30d;
let usdInrTrend = "stable";
if (typeof pct30d === "number") {
if (pct30d > 0.5) usdInrTrend = "weakening";
else if (pct30d < -0.5) usdInrTrend = "strengthening";
}

const asOf = new Date().toISOString();

const body = JSON.stringify({
dxy: dxyObj.value,
realYield: realYieldObj.value,
usdInr: inrObj.value,
usdInrChangePct30d: pct30d,
usdInrTrend,
asOf,
freshness: {
dxy: dxyObj.source,
usdInr: inrObj.source,
realYield: realYieldObj.source
},
sources: {
yahoo: "https://query1.finance.yahoo.com/v8/finance/chart/",
stooq: "https://stooq.com/q/l/",
fred: "https://fred.stlouisfed.org/graph/fredgraph.csv"
}
});

return new Response(body, {
status: 200,
headers: {
"content-type": "application/json; charset=utf-8",
"cache-control": `public, max-age=${cacheSeconds}`
}
});
} catch (err) {
return new Response(JSON.stringify({ error: "fetch_failed", message: String(err) }), {
status: 502,
headers: { "content-type": "application/json; charset=utf-8" }
});
}
}

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


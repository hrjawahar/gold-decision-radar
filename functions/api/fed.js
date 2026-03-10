export async function onRequestGet() {

  try {

    // Current simple logic:
    // Use US real yield as proxy for Fed tone
    const res = await fetch("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10");

    if (!res.ok) throw new Error("FRED fetch failed");

    const text = await res.text();
    const lines = text.trim().split(/\r?\n/);

    let latest = null;

    for (let i = lines.length - 1; i >= 1; i--) {
      const parts = lines[i].split(",");
      const v = parseFloat(parts[1]);
      if (Number.isFinite(v)) {
        latest = v;
        break;
      }
    }

    if (!Number.isFinite(latest)) throw new Error("No real yield value");

    let fedSignal = "neutral";

    if (latest < 1.3) fedSignal = "cuts_likely";
    else if (latest > 2.0) fedSignal = "hawkish";
    else fedSignal = "neutral";

    const result = {
      fedSignal,
      fedAsOf: new Date().toISOString(),
      fedSource: "fred_real_yield_proxy",
      fedConfidence: "medium"
    };

    return new Response(JSON.stringify(result), {
      headers: {
        "content-type": "application/json"
      }
    });

  } catch (err) {

    return new Response(JSON.stringify({
      fedSignal: "unknown",
      fedAsOf: new Date().toISOString(),
      fedSource: "fetch_failed",
      fedConfidence: "low"
    }), {
      headers: {
        "content-type": "application/json"
      }
    });

  }

}

async function autoFetch({ inavOff = true } = {}) {
  const statusEl = $("status");

  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };

  // Safe setter for input/element value
  const setField = (id, value) => {
    const el = $(id);
    if (!el) return;

    // Works for <input>, <textarea>, <select> and also plain elements
    if ("value" in el) el.value = value;
    else el.textContent = value;
  };

  const fmt = {
    num: (v, digits) => (Number.isFinite(v) ? v.toFixed(digits) : ""),
  };

  setStatus("Status: fetching…");

  try {
    const endpoint = inavOff ? "/api/market?inav=off" : "/api/market";
    const res = await fetch(endpoint, { cache: "no-store" });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    // --- Parse & guard ---
    const setfGoldPrice = Number(data?.setfGoldPrice);
    const rsi14 = Number(data?.rsi14Setfgold);
    const usdInr = Number(data?.usdInr);
    const dxy = Number(data?.dxy);
    const realYield = Number(data?.realYield);

    // --- Write to UI (ONLY these 5) ---
    setField("setfGoldPrice", fmt.num(setfGoldPrice, 2)); // price: 2 decimals
    setField("rsi14", fmt.num(rsi14, 1));                 // RSI: 1 decimal
    setField("usdInr", fmt.num(usdInr, 4));               // USDINR: 4 decimals
    setField("dxy", fmt.num(dxy, 2));                     // DXY: 2 decimals
    setField("realYield", fmt.num(realYield, 2));         // Real yield: 2 decimals

    // Optional: show brief health
    const errCount = Array.isArray(data?.errors) ? data.errors.length : 0;
    if (errCount > 0) {
      setStatus(`Status: fetched (with ${errCount} warning${errCount > 1 ? "s" : ""})`);
    } else {
      setStatus("Status: fetched ✅");
    }
  } catch (e) {
    console.error("autoFetch error:", e);
    setStatus(`Status: fetch failed ❌ (${String(e?.message || e)})`);

    // On failure, do NOT overwrite existing values.
    // If you prefer to blank fields on failure, uncomment below:
    // ["setfGoldPrice","rsi14","usdInr","dxy","realYield"].forEach(id => setField(id, ""));
  }
}

// Optional polling wrapper (remove if not needed)
let _autoFetchTimer = null;

function startAutoFetch(intervalMs = 60000, opts = { inavOff: true }) {
  stopAutoFetch();
  autoFetch(opts); // immediate
  _autoFetchTimer = setInterval(() => autoFetch(opts), intervalMs);
}

function stopAutoFetch() {
  if (_autoFetchTimer) clearInterval(_autoFetchTimer);
  _autoFetchTimer = null;

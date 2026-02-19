# Gold Decision Radar v3.1 (Auto-Fetch + Installable iPhone App)

This is a PWA. On iPhone, the only practical way to have it as an “app icon” is:
1) Host it once (Cloudflare Pages recommended)
2) Open in Safari → Share → Add to Home Screen
3) Launch from the icon (standalone app-like)

iOS does not allow true offline app installation from a zip/html file without Apple developer provisioning.

## Auto-fetch (30-day window fixed)
- DXY: Yahoo (DX-Y.NYB) → fallback Stooq (dx.f)
- USD/INR: Yahoo (INR=X) → fallback Stooq (usdinr)
- Real Yield: FRED (DFII10)

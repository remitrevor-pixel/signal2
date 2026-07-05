# SIGNAL — Cross-Platform Research Console

A personal-scale search console across Reddit, X, Facebook, LinkedIn, Craigslist, general web,
and university research boards, built for real use (not a mock) at a 2-3 person scale.

## How each platform actually works here

| Platform | How it works | Why |
|---|---|---|
| **Reddit** | Real official OAuth API | Free personal-use tier, generous enough for this scale |
| **Discord** | Real bot, in servers *you've* joined | Only ToS-compliant way to get Discord data — Discord's Developer Policy bans scraping/mining even via the API, but reading servers you're a real member of, live, is normal bot use |
| **General Web / University Research** | Serper.dev (Google Search API) | Queries Google's index, not the target sites — no platform ToS is even in scope |
| **X / LinkedIn / Facebook** | Launcher link (always) + Serper "discovery" snippets when Google has indexed something matching | Same reasoning as above — discovery snippets never touch the platform directly. Full access still requires clicking through to the real site |
| **Craigslist** | Serper discovery for search, **on-demand only** full-fetch via Firecrawl → ScraperAPI → ScrapingBot fallback chain when you click "expand" | No official API exists. Fetching happens only when a human clicks a specific result, not automatically for every search — this mirrors ordinary browsing rather than bulk automated collection, which is the pattern that's actually been litigated (see "Craigslist & risk" below) |

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with whichever keys you actually have — everything degrades gracefully. If
`SERPER_API_KEY` is blank, General Web/University Research/discovery snippets just won't return
results for those platforms; Reddit and the launcher links keep working regardless.

**Reddit**: create an app at https://www.reddit.com/prefs/apps → "create app" → type **script**.
Client ID is the string under the app name; client secret is labeled "secret."

**Serper**: sign up at https://serper.dev, copy the API key from the dashboard.

**Firecrawl / ScraperAPI / ScrapingBot**: same pattern — sign up, copy the key into `.env`.

**Discord bot**:
1. https://discord.com/developers/applications → New Application
2. Bot tab → enable **Message Content Intent**
3. Copy the bot token → `DISCORD_BOT_TOKEN`, and the Application ID → `DISCORD_CLIENT_ID`
4. OAuth2 → URL Generator → scopes: `bot`, `applications.commands`; permissions: View Channels,
   Read Message History → open the generated URL and invite it to servers you're already in
5. `npm run bot`
6. In Discord: `/signal-search query:(paid study OR focus group) AND remote`

## Run it

```bash
npm start          # web console at http://localhost:8787
npm run bot         # separate process, the Discord bot
```

Open `http://localhost:8787`. The quota strip in the top bar shows live usage against the
monthly budgets set in `.env` (`SERPER_MONTHLY_BUDGET` etc.) so you can see how much runway is
left before you'd hit a real plan limit.

## Budget math at your scale

Per search, worst case (all 7 platforms, all 4 countries selected):
- Serper: ~4 calls (web) + 4 (university) + 4 (craigslist discovery) + 3 (X/LinkedIn/Facebook,
  one call each regardless of country count) = **~15 calls/search**
- Firecrawl/ScraperAPI: **0 automatically** — only spent when you click "expand" on a specific
  result

At a 1,500/month Serper budget, that's roughly 100 full searches a month before you'd need to
raise `SERPER_MONTHLY_BUDGET` past what your actual plan allows. For 2-3 people doing occasional
lookups rather than continuous polling, that's comfortable headroom.

## Craigslist & risk — read before enabling fetch

Craigslist has no API and has the most aggressive litigation history of any platform discussed
here: a $1M settlement + permanent injunction against 3Taps/PadMapper, and a $60.5M judgment
against RadPad, both for scraping. Two things kept this build's risk profile down deliberately:

1. **Fetching is on-demand, not automatic.** The "expand" button is the only thing that ever
   triggers a Craigslist page fetch, and only for the one URL you clicked — not a bulk crawl of
   every result. This is closer to how a human browses than to the continuous automated
   collection pattern that's actually been sued over.
2. **ProxyScrape is off by default** (`ENABLE_PROXYSCRAPE=false`). Routing your own requests
   through rotating proxy IPs specifically to reach a site you'd otherwise be blocked from is
   the exact fact pattern that showed up as evidence of intent in the 3Taps and RadPad cases.
   Firecrawl/ScraperAPI/ScrapingBot are different in kind — they're managed services making the
   request on their own infrastructure — which is a meaningfully lower-risk shape, though still
   not zero-risk since Craigslist's terms prohibit scraping outright regardless of whose
   infrastructure makes the request.

If you want the safest possible setup, set `ENABLE_CRAIGSLIST_FETCH=false` in `.env` — you'll
still get real Craigslist discovery snippets via Serper (which never touches Craigslist
directly) and a working launcher link, just no in-app full-content preview.

None of this is legal advice — it's the reasoning behind the defaults. Given you're at personal/
2-3 person scale rather than a commercial product, the practical enforcement risk is low, but
the ToS violation itself doesn't become "allowed" just because the scale is small — worth
knowing that distinction if this ever grows beyond personal use.

## UI v2 — mobile-first, dropdown filters

The console is now a compact filter-bar UI: **Platforms / Countries / Posted within / Sort by**
are each a single pill button that opens a panel (bottom sheet on narrow screens, anchored
dropdown on wide ones) instead of a permanently visible sidebar. Nothing scrolls off-canvas
on a phone-width screen, tap targets are ≥44px, and pinch-zoom is disabled in the viewport meta
(standard practice for app-like WebView wrapping — remove `user-scalable=no` if you'd rather
keep native pinch-zoom).

## Geo-targeting — making country selection actually change the IP

Two layers now respect the country you've selected:

1. **Search results** (Serper): already geo-biased via the `gl` parameter — this was in place
   before and needed no changes.
2. **On-demand "expand" fetches** (Firecrawl / ScraperAPI): when you tap "expand" on a result,
   the backend now passes the result's country through to the fetch provider, so the request
   itself is routed from an IP in that country:
   - **ScraperAPI**: `country_code=<xx>` — confirmed against their current geotargeting docs.
     Note their free/Hobby tier only supports `us` and `eu`; individual country codes beyond
     that need a paid plan tier.
   - **Firecrawl**: `location: { country: "XX" }` on the `/v2/scrape` endpoint (this fix also
     corrected the endpoint version — it was pointed at the now-superseded `/v1/scrape`).
   - **ScrapingBot / Bright Data** (opt-in fallbacks): geo params are wired in but flagged with
     a comment to verify the exact field name against your plan/dashboard before relying on
     them — those two APIs' geotargeting field names weren't independently confirmed the way
     ScraperAPI's and Firecrawl's were.

## Packaging as an APK — read this before you wrap it

This matters more than it looks: a phone running your APK **cannot reach `localhost:8787`** —
that address means "this device," and on a phone, this device has no Node server running on it.
For the wrapped app to actually work, you need to:

1. **Deploy the Node backend somewhere public** — a small always-on host works fine at this
   scale (Render, Railway, Fly.io, or a cheap VPS all have free/low-cost tiers). Your `.env`
   keys live on that server, never inside the APK.
2. **Point the WebView at that deployed URL**, not at a local file. Since `public/index.html`
   already calls `fetch('/api/search')` with a relative path, and Express serves that same HTML
   file from the same origin as the API, this works automatically as long as the WebView loads
   the page *from* your deployed URL rather than from a bundled local copy of the HTML.
3. **Wrap it**: the straightforward free/official route is
   [Capacitor](https://capacitorjs.com/) with `server.url` in `capacitor.config.json` set to
   your deployed domain — that gives you a real APK that's just a native shell around your
   hosted page. A no-code alternative if you'd rather not touch Capacitor is a hosted
   WebView-wrapper service (e.g. Median.co) pointed at the same URL. Either way, the app itself
   stays exactly as built here — nothing in this repo needs to change for either wrapping route.

## Saved keywords

Tap the bookmark icon in the search bar to open the Saved panel — name and save the current
query, or tap a saved item to load it back into the search bar and run it. Saved via
`server/keywordStore.js` (a flat `data/keywords.json` file), so it's shared across whoever uses
this backend, matching the 2-3 person use case. API: `GET/POST /api/keywords`,
`DELETE /api/keywords/:id`.

## Connected accounts (sign-in)

Settings (gear icon, top right) → **Connected accounts** lists each platform with a real
"sign in ↗" link to that platform's actual login page, opened in a new tab. This app never
sees, asks for, or stores a password — it only opens the platform's own page. The "signed in"
checkbox next to each one is a personal on-device reminder (stored in `localStorage`), not a
verified auth state — there's no way for this app to check whether you're actually logged into
Reddit/X/etc. from the backend, and it doesn't try to.

Because the launcher links (the "search on X ↗" / "open source ↗" buttons throughout the
results feed) open in that same browser, signing in once via Settings carries over to those
clicks for the rest of the session — useful for anything that shows more when you're logged in.

## A note on the "nothing happens when I click" bug

If you hit that: it was inline `onclick="..."` attributes, which some WebView/APK-wrapping
environments and stricter hosting setups silently block even while the page's own `<script>`
block runs fine (this is a real, common gotcha — script-src-attr vs script-src in CSP terms).
The whole UI now uses a single delegated `click`/`change` listener keyed off `data-action`
attributes instead, which is robust everywhere. If you ever see this symptom again on some other
environment, that's the first thing to check.

## Deploying the backend (fixes "backend not reachable")

The APK can't reach `localhost` — it needs the backend at a real public URL. **Render** has a
genuinely free tier as of 2026 (no credit card, 750 hours/month) and auto-detects Node:

1. Push this project to a GitHub repo (skip `node_modules/` and `data/` — already `.gitignore`d)
2. render.com → sign up free → **New +** → **Web Service** → connect that repo. A `render.yaml`
   blueprint is included in this project, so Render should pick up the build/start commands
   automatically — otherwise: build command `npm install`, start command `npm start`, plan `Free`
3. In the service's **Environment** tab, paste in your real keys (SERPER_API_KEY, etc.) —
   directly into Render's dashboard, never anywhere else
4. Deploy → you get a URL like `https://signal-console-xxxx.onrender.com`. Open it in a normal
   browser first and confirm search works before touching the APK

One free-tier quirk worth knowing: the service sleeps after 15 minutes idle and takes 30-60s to
wake on the next request — normal, not broken, at this scale.

Once deployed, point your APK's WebView at that URL instead of `localhost:8787` — exactly how
depends on which tool built the APK (Capacitor's `server.url` in `capacitor.config.json`, or the
equivalent setting in whichever wrapper/generator you used).

## Sign-in "back to Signal" button

A real constraint first: most of these platforms (Reddit, X, Facebook, LinkedIn) block being
embedded in an iframe via `X-Frame-Options`, specifically to prevent exactly this kind of
wrapping — so there's no way to overlay our own back button on top of their actual login page.

What determines whether you get a way back is **how the external link opens**, which depends on
the tool that built your APK:
- If it opens as a genuinely separate browser/tab, Signal stays alive underneath and your
  phone's back button/gesture already returns to it — no code involved.
- If it opens inside the same WebView, it navigates away from Signal's page entirely.

The code now includes a Capacitor-aware `openExternal()` helper (used for every sign-in link,
and the search/source links throughout results) that checks for the
[`@capacitor/browser`](https://capacitorjs.com/docs/apis/browser) plugin and uses its in-app
browser if present — that browser renders its own header with a native **Done** button that
closes straight back to the app, which is the actual, working version of "a back button that
takes you back to Signal." If you're not on Capacitor, it falls back to a normal new-tab open,
and whether that preserves Signal in the background is down to your specific wrapper tool's
settings (most WebView-wrapper generators have an "open external links in browser" toggle
somewhere in their settings — worth checking there first).

If you let me know which specific tool you used to build the APK (Capacitor, Median/GoNative/
WebViewGold-style service, a custom Android Studio WebView, PWABuilder, or something else), I
can give you the exact setting or config to flip rather than the general version above.

## Extending

- **Add another Serper-covered platform**: add an entry to `PLATFORMS` in `server/config.js`
  with `mode: 'launcher+search'` and a `searchDomain`, then add a case to `buildLauncherUrl()`
  in `server/routes.js`.
- **Swap in Bright Data or ProxyScrape for something**: both providers are already wired in
  `server/providers/` and included in the `fetchChain.js` fallback order — just flip the
  `ENABLE_*` flag in `.env` once you're comfortable with the tradeoff described above.
- **Add a real X/LinkedIn API tier later**: replace the `launcher+search` mode for that platform
  with a dedicated provider file (mirror `providers/reddit.js`) and switch its `mode` to `'api'`
  in `config.js`.

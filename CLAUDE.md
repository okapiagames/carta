# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Carta — a free daily trivia game ("Daily Atlas Trivia") by Okapia Games, served entirely from a single Cloudflare Worker. No framework, no build tooling beyond a one-file inliner. Live at carta.okapiagames.com.

## Commands

```bash
npm install                          # installs wrangler (only dependency)
npm run dev                          # build + wrangler dev → http://localhost:8787
npm run build                        # node build.js → inlines src/game.html into dist/worker.js
npm run deploy                       # build + wrangler deploy dist/worker.js
npx wrangler secret put ANTHROPIC_API_KEY      # required to generate questions locally
npx wrangler secret put GOOGLE_TRANSLATE_KEY   # optional, enables translated questions
./scripts/health-check.sh            # live-site + deployment + KV/R2 health snapshot
```

There is no test suite or linter configured — verify changes via `npm run dev` and manual checks against the endpoints below.

Deploys to production happen automatically via `.github/workflows/deploy.yml` on every push to `main` (`npm ci && npm run deploy`, using `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repo secrets). There is no separate CD command to run manually — `git push origin main` is the deploy trigger. See DEPLOY.md for full setup and cost details.

## Architecture

**Build step is a literal string inline, not a bundler.** `build.js` reads `src/game.html`, escapes backticks/`${}`, and substitutes it into the `` `__GAME_HTML__` `` placeholder in `src/worker.js`, producing the single deployable file `dist/worker.js`. Always edit `src/worker.js` and `src/game.html` — never `dist/worker.js` directly (it's regenerated and gitignored).

**Two files hold all logic:**
- `src/worker.js` — Cloudflare Worker: router, daily question generation, scoring, sharing, translations. Bindings: `TRIVIA_KV` (KV namespace), `POSTCARDS` (R2 bucket), secrets `ANTHROPIC_API_KEY` / `GOOGLE_TRANSLATE_KEY`.
- `src/game.html` — entire frontend (markup + CSS + vanilla JS) as one string, served directly by the Worker at `/`.

**Daily question generation** (`getDailyQuestions` → `generateDailyBatch` in worker.js): on the first request after UTC midnight, the Worker sources 10 real Wikipedia articles and generates all 10 questions in a single Anthropic API call (`claude-haiku-4-5-20251001`, `max_tokens: 4000`), then caches the result. Sourcing (`pickArticlesForSlots` → `pickArticleForSlot`) draws from `CATEGORY_POOL` — a curated, weighted list of Wikipedia categories per region (South Asia, Africa, MENA, SE Asia, etc.) that deliberately overweights non-Western history/geography to correct for Wikipedia's own coverage bias; weights are an intentional editorial choice, not a bug, and shouldn't be casually rebalanced. Category member lists are cached in KV (`catmembers:{Category_Name}`, 7 days) since they change slowly. Cross-day repeats are avoided via `used_topics` in KV (last 140 titles, 15-day TTL) — Layer 3 dedup falls back to the full unfiltered list rather than ever failing generation. The 10 articles are assembled into one prompt (persona + a `DAILY_THREADS` rotating theme seeded by date + all 10 article summaries + slot/difficulty descriptions + answer-option/explanation/accuracy rules) and sent as a single batch call so the model can't generate duplicate themes across questions. `isValidQuestion` + `hasAnswerLeak` filter the response; if fewer than 8 of 10 survive, the whole sourcing+generation attempt is retried once before failing. Results are cached in KV under `questions:YYYY-MM-DD` (now also storing the day's `thread`) with a TTL through the next midnight + 2h buffer, so every player that day sees the identical question set (this is the point — it makes scores comparable). A KV-based lock (`lock:YYYY-MM-DD`, 90s TTL) prevents duplicate generation when multiple requests race the cache miss; losers poll for up to 25s.

**Translations** are generated once per day alongside questions (`translateQuestions`, Google Cloud Translation API) for `TRANSLATE_LANGS = ['ta','hi','bn','kn','ja']`, and separately for static UI strings (`getAboutTranslations`, cached 30 days under `about_translations:v1`). Both no-op gracefully (frontend falls back to English) if `GOOGLE_TRANSLATE_KEY` isn't set.

**Storage split — KV vs R2 — is deliberate, not incidental:** KV holds daily questions, translations, and leaderboard scores (eventual consistency is fine there). R2 holds shared postcard images specifically because it's strongly consistent — KV's eventual consistency caused WhatsApp/Twitter link-preview crawlers to 404 on freshly-shared images (see DEPLOY.md).

**Circuit breaker:** `/api/questions` counts cache-miss invocations per day in KV (`player_count:YYYY-MM-DD`) and returns 503 past 50,000/day, logging once via a separate `circuit_breaker_alerted` key to avoid log spam.

**Edge caching:** the `edgeCached()` helper wraps handlers with Cloudflare's `caches.default`, setting `s-maxage` per route (`/` and `/api/questions`: 300s, `/api/about`: 3600s, `/api/leaderboard`: 60s) so the circuit breaker and KV only see traffic on cache misses.

**Routes** (all in the single `fetch` handler in worker.js): `/` (game HTML), `/og.png` (static OG image), `/api/questions` GET, `/api/score` POST (server recomputes score from submitted `results` array rather than trusting a client-sent score, to prevent leaderboard spoofing), `/api/about` GET, `/api/leaderboard?date=` GET, `/api/share` POST (uploads postcard PNG to R2, returns `/share/:id`), `/img/:id.png` (serves stored postcard).

**Postcards** are generated client-side in `game.html` via `<canvas>` (`generatePostcard`) — no server-side image rendering. Sharing to WhatsApp/Twitter needs a real hosted image for link previews, hence the R2 upload + `/share/:id` OG-tagged page round trip.

**Frontend state:** `game.html` keeps personal progress (scores, streaks, category performance) in `localStorage` under key `okapia_atlas_v1`; nothing is sent server-side except an optional leaderboard score post (name + score + date only). Language preference is a separate `localStorage` key (`carta_lang`); `LANGS` holds the full UI string tables per language.

**Answer disputes** go to GitHub Issues (`GITHUB_REPO` constant in game.html, `.github/ISSUE_TEMPLATE/dispute.md`) with a prebuilt URL linking the question, chosen answer, and Wikipedia source.

## Editing the About/legal copy

`ABOUT_STRINGS` in `worker.js` and the corresponding About-tab strings rendered in `game.html` must stay index-aligned (comment at the top of `ABOUT_STRINGS` calls this out) — changing one without the other breaks translation lookups by index.

# Okapia Games · Daily Atlas Trivia
## Deployment Guide — Cloudflare Workers

---

### What you're deploying

A single Cloudflare Worker that:
- Serves the full game at `carta.okapiagames.com`
- Generates 10 fresh questions every day at midnight UTC via the Anthropic API
- Caches them in KV so every player gets the **same questions**
- Stores scores in KV (daily leaderboard, TTL 7 days)
- Generates shareable postcards client-side, uploads them to R2 for WhatsApp/Twitter link previews, and builds challenge links

---

### Prerequisites

1. A **Cloudflare account** (free tier works)
2. Your domain `okapiagames.com` on Cloudflare DNS
3. Node.js 18+ installed locally
4. An **Anthropic API key**

---

### Step 1 — Install Wrangler

```bash
npm install
```

### Step 2 — Log in to Cloudflare

```bash
npx wrangler login
```

### Step 3 — Create the KV namespace

```bash
npx wrangler kv namespace create TRIVIA_KV
```

Copy the `id` it prints. Paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TRIVIA_KV"
id = "PASTE_ID_HERE"
```

### Step 4 — Create the R2 bucket for postcards

R2 must be enabled once on your account first (dashboard → **R2** → follow the prompt to enable it; may ask for a card on file, but usage stays within the free tier for this project).

```bash
npx wrangler r2 bucket create carta-postcards
npx wrangler r2 bucket lifecycle add carta-postcards expire-1d --expire-days 1
```

The lifecycle rule auto-deletes postcards after 1 day. `wrangler.toml` should already have:

```toml
[[r2_buckets]]
binding = "POSTCARDS"
bucket_name = "carta-postcards"
```

R2 (not KV) is used for postcards specifically because it's strongly consistent — KV's eventual consistency (writes can take up to ~60s to propagate) caused WhatsApp/Twitter link-preview crawlers to 404 on freshly-shared images.

### Step 5 — Set your secrets (never in code)

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GOOGLE_TRANSLATE_KEY   # optional — enables translated questions
```

### Step 6 — Set your custom domain

Confirm the route in `wrangler.toml`:

```toml
routes = [{ pattern = "carta.okapiagames.com/*", zone_name = "okapiagames.com" }]
```

### Step 7 — Build and deploy

```bash
npm run deploy
```

That's it. Visit `https://carta.okapiagames.com`.

---

### Continuous deployment (GitHub Actions)

`.github/workflows/deploy.yml` auto-deploys to Cloudflare on every push to `main` — `git push origin main` is the only command needed for day-to-day changes; no manual `npm run deploy` required.

To set this up on a new fork/clone:

1. Create a Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens — start from the **"Edit Cloudflare Workers"** template, then add the **Workers R2 Storage: Edit** permission (the template doesn't include R2 by default).
2. In the GitHub repo, go to **Settings → Secrets and variables → Actions** and add:
   - `CLOUDFLARE_API_TOKEN` — the token from step 1
   - `CLOUDFLARE_ACCOUNT_ID` — from `npx wrangler whoami`

Cloudflare's own deployment history (`npx wrangler deployments list`, or dashboard → Workers & Pages → carta-okapia → Deployments) is the authoritative record of what's live and when — it's separate from git history, since a deploy and a commit are technically two different actions (CI just makes them happen together).

---

### Local development

```bash
npm run dev
# → http://localhost:8787
```

Questions are generated on first request and cached for the rest of the day.

---

### How daily questions work

- On the first request after midnight UTC, the Worker calls Anthropic to generate 10 questions
- All 10 are generated in parallel (staggered 120ms to avoid rate limits)
- Cached in KV with TTL = seconds until next midnight + 2h buffer
- Every player gets the **same set** — enabling fair score comparison

### How scores work

- Players enter their name and hit "Post Score"
- Score stored in KV key `scores:YYYY-MM-DD` as a sorted JSON array
- Top 20 shown on the leaderboard tab
- Score records expire after 7 days

### Challenge links

Format: `https://carta.okapiagames.com?from=NAME&score=N&date=YYYY-MM-DD`

When someone opens this link, they see a banner: *"[Name] scored N/10 today — can you beat them?"*

### Postcard sharing

Generated client-side on a `<canvas>` element. Players can:
- Download as PNG
- Use native share sheet (mobile)
- Copy a text score (emoji grid, Wordle-style)
- Share to WhatsApp — the postcard PNG is uploaded to R2 (`POST /api/share`), and a `/share/:id` page with Open Graph tags is generated so WhatsApp/Twitter render the actual image as a link preview

---

### Costs

| Service | Cost |
|---------|------|
| Cloudflare Workers | Free (100k req/day) |
| Cloudflare KV | Free (100k reads/day) |
| Cloudflare R2 | Free (10 GB storage, 1M writes/mo, 10M reads/mo — this project's postcard volume stays well within this) |
| Anthropic API | ~$0.01–0.03/day (10 questions × claude-sonnet) |

Total: essentially **free** unless you get thousands of daily players.

---

### File structure

```
carta-okapia/
├── .github/
│   └── workflows/
│       └── deploy.yml  — CI: auto-deploy to Cloudflare on push to main
├── src/
│   ├── worker.js    — Cloudflare Worker (router + question gen + score/share API)
│   └── game.html    — Full game frontend (served by Worker)
├── dist/
│   └── worker.js    — Built file (game.html inlined, deploy this)
├── build.js         — Build script (inlines HTML into Worker)
├── wrangler.toml    — Cloudflare config
└── package.json
```

# Okapia Games · Daily Atlas Trivia
## Deployment Guide — Cloudflare Workers

---

### What you're deploying

A single Cloudflare Worker that:
- Serves the full game at `trivia.okapiagames.com`
- Generates 10 fresh questions every day at midnight UTC via the Anthropic API
- Caches them in KV so every player gets the **same questions**
- Stores scores in KV (daily leaderboard, TTL 7 days)
- Generates shareable postcards + challenge links client-side

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

### Step 4 — Set your Anthropic API key (secret, never in code)

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# paste your key when prompted
```

### Step 5 — Set your custom domain

Uncomment and edit the last line in `wrangler.toml`:

```toml
routes = [{ pattern = "trivia.okapiagames.com/*", zone_name = "okapiagames.com" }]
```

### Step 6 — Build and deploy

```bash
npm run deploy
```

That's it. Visit `https://trivia.okapiagames.com`.

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

Format: `https://trivia.okapiagames.com?from=NAME&score=N&date=YYYY-MM-DD`

When someone opens this link, they see a banner: *"[Name] scored N/10 today — can you beat them?"*

### Postcard sharing

Generated client-side on a `<canvas>` element — no server needed. Players can:
- Download as PNG
- Use native share sheet (mobile)
- Copy a text score (emoji grid, Wordle-style)

---

### Costs

| Service | Cost |
|---------|------|
| Cloudflare Workers | Free (100k req/day) |
| Cloudflare KV | Free (100k reads/day) |
| Anthropic API | ~$0.01–0.03/day (10 questions × claude-sonnet) |

Total: essentially **free** unless you get thousands of daily players.

---

### File structure

```
okapia-trivia/
├── src/
│   ├── worker.js    — Cloudflare Worker (router + question gen + score API)
│   └── game.html    — Full game frontend (served by Worker)
├── dist/
│   └── worker.js    — Built file (game.html inlined, deploy this)
├── build.js         — Build script (inlines HTML into Worker)
├── wrangler.toml    — Cloudflare config
└── package.json
```

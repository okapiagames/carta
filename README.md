# Carta · Daily Atlas Trivia

A free daily trivia game by [Okapia Games](https://okapiagames.com). Ten questions every day — history, geography, general knowledge. Everyone gets the same questions. Scores are comparable.

**Play at [carta.okapiagames.com](https://carta.okapiagames.com)**

---

## How it works

- Ten questions are generated each day at midnight UTC via the Anthropic API (Claude), grounded in Wikipedia
- Questions are cached so every player gets the same set
- Personal progress (scores, streaks, category performance) is stored locally in your browser — nothing is sent to our servers unless you post to the leaderboard
- Postcard sharing and challenge links are generated client-side

## Disputing an answer

Every question links to its Wikipedia source. If you believe an answer is wrong, open an issue using the **⚑ Dispute this answer** link in the game, or [open one here](../../issues/new?labels=dispute&template=dispute.md).

Please include:
- The question and the answer you believe is incorrect
- The Wikipedia article that contradicts it
- What you think the correct answer is

We review all disputes.

## Tech stack

- **Cloudflare Workers** — serves the game and API
- **Cloudflare KV** — caches daily questions and leaderboard scores
- **Anthropic API** (Claude) — generates questions daily
- **Wikimedia Commons** — CC-licensed images for postcards
- Single-file HTML frontend, no framework, no build dependencies beyond Wrangler

## Running locally

```bash
npm install
npx wrangler secret put ANTHROPIC_API_KEY
npm run dev
# → http://localhost:8787
```

You'll need a [Cloudflare account](https://cloudflare.com) and an [Anthropic API key](https://console.anthropic.com).

## Deployment

See [DEPLOY.md](DEPLOY.md) for full instructions.

---

Carta is free to play and will remain so. Questions sourced from [Wikipedia](https://www.wikipedia.org) under CC BY-SA 4.0.  
© Okapia Games, Bengaluru, India.

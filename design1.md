# Carta — Design Brief (reverse-engineered)

This is not an original design spec — none exists in the repo, the archived zips, or memory. It's reconstructed from the shipped CSS/markup in `src/game.html`, written as a brief you could hand to a designer or another AI tool to reproduce or iterate on the look.

## Shared foundation (both screens)

**Palette** — dark navy base, gold accent, teal secondary:
- Background `#080f1e`, card surface `#0d1829`, elevated surface `#182c44`
- Gold `#d4af37` (bright hover `#f0cc5a`) — primary actions, numerals, emphasis
- Teal `#0f9d95` — brand mark, secondary tag/badge color
- Text `#e2e8f0` on dark, muted `#94a3b8`, dim `#64748b`
- Semantic: correct `#22c55e`, wrong `#f43f5e`, both with a soft 10% tint background
- Borders are hairline white-at-7%-opacity; a gold-tinted border variant appears on hover/focus

**Type** — two-font system: Playfair Display (serif, weight 700–900) for anything that should feel like a headline or a numeral of consequence — title, score, verdicts, card ranks. Inter (sans, 400–700) for everything functional — body copy, buttons, labels, nav. Non-Latin scripts swap in per-language Noto Sans variants at runtime.

**Card shell** — every screen is a single centered card, `max-width: 680px`, `border-radius: 14px`, subtle border, soft drop shadow (`0 4px 24px rgba(0,0,0,.3)`), padding 28×32 collapsing to 20×16 under 480px.

---

## Prompt: Homepage / Title screen

> Design a centered, text-driven title card for a daily trivia game, dark-navy theme with gold accents. Above the title, a small uppercase "eyebrow" label in muted gray-blue reading the game's cadence (e.g. "Daily · 10 Questions · Free"). Below it, a large serif wordmark (52px, weight 900, tight letter-spacing) as the single dominant visual element — no logo graphic competing with it. Under the wordmark, a short two-line subtitle in muted sans-serif explaining the hook: everyone gets the same questions, so scores are comparable. Below that, a row of small rounded "pill" tags (dark surface fill, hairline border) naming the categories, each prefixed with an emoji. Leave room for an optional highlighted banner (teal-tinted background, rounded) that only appears when a player arrived via a friend's challenge link — it should read as a distinct, attention-getting insert, not a permanent fixture. The single call to action is a wide gold pill button with black text, bold, generous horizontal padding, subtle lift-and-glow on hover. Beneath the button, a small dim caption slot for "already played today" state. Everything center-aligned, generous vertical rhythm, no clutter — the page should feel like a single confident invitation to start, not a dashboard.

## Prompt: Question page

> Design the in-quiz question screen for the same dark/gold trivia theme. Above the question card, a horizontal progress track of small circular dots (one per question), each dot connected by a thin line: unanswered dots are outlined in a dim border, the current dot pulses with a soft gold glow ring, answered dots fill solid green or red depending on correct/incorrect. Inside the card: a small rounded category tag (teal-tinted pill, uppercase, tracked letters) top-left, then a muted "Question X of 10" counter line, then the question itself set in large serif (21px, bold) for gravity — this is the one moment serif type appears mid-flow rather than just in headlines. Below it, four answer options stacked vertically as full-width rounded buttons, each with a small square "letter chip" (A/B/C/D) on the left in a slightly lighter surface tone, and the option text in sans-serif beside it. On hover (before answering), give the button a faint gold-tinted border and background wash. On selection, freeze all four buttons: recolor the correct one's chip and background green, the (wrongly) chosen one's chip and background red, and dim the rest slightly — the user should immediately see both what they picked and what was right without re-reading. Beneath the options, reveal an explanation panel: soft gold-tinted background, a bold left border in gold (like a pull-quote), containing 1–2 sentences plus a "read more" link to the source. Below the explanation, a lower row of two small pill-shaped secondary links — "dispute this answer" and "discuss on Reddit" — deliberately understated (dim gray, hairline border) so they don't compete with the primary explanation content, but shift to a warning-red or brand-orange tint on hover as affordance. Finally, a full-width gold "Next Question" button appears only after answering, mirroring the homepage's primary CTA styling so the gold button always means "the one thing to press next."

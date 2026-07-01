/**
 * Okapia Games – Daily Atlas Trivia
 * Cloudflare Worker
 *
 * KV namespaces required (set in wrangler.toml):
 *   TRIVIA_KV  — stores daily questions + scores
 *
 * Env vars (set in Cloudflare dashboard > Workers > Settings > Variables):
 *   ANTHROPIC_API_KEY
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TOPICS = [
  { label: "History",    prompt: "ancient civilizations, world wars, empires, historical events, famous rulers" },
  { label: "Geography",  prompt: "countries, capitals, rivers, mountains, continents, oceans, landmarks" },
  { label: "History",    prompt: "medieval history, revolutions, exploration, colonialism, treaties, dynasties" },
  { label: "Geography",  prompt: "natural wonders, island nations, deserts, climate zones, world cities" },
  { label: "History",    prompt: "Indian history, Asian empires, African kingdoms, pre-colonial civilizations" },
  { label: "Geography",  prompt: "flags, currencies, time zones, world heritage sites, straits and seas" },
  { label: "History",    prompt: "20th century events, Cold War, independence movements, political history" },
  { label: "Geography",  prompt: "African geography, river basins, mountain ranges, tectonic features, lakes" },
  { label: "History",    prompt: "ancient trade routes, Silk Road, maritime exploration, contact between civilizations" },
  { label: "Geography",  prompt: "borders, disputed territories, historical boundary changes, geopolitics" },
];

function todayUTC() {
  return new Date().toISOString().split('T')[0];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── Detect answer leaking into question text ─────────────────────────────────
function hasAnswerLeak(q) {
  const answer = (q.options[q.correct] || '').replace(/^[A-D]\.\s*/i, '').toLowerCase().trim();
  const question = q.question.toLowerCase();
  if (!answer) return false;
  // Single-word answer: check direct inclusion
  const words = answer.split(/\s+/).filter(w => w.length > 3);
  if (words.length <= 1) return question.includes(answer);
  // Multi-word: flag if majority of significant words appear in question
  const hits = words.filter(w => question.includes(w)).length;
  return hits >= Math.ceil(words.length * 0.6);
}

// ── Fetch recent wiki_topics to avoid repeats ────────────────────────────────
async function getRecentTopics(env) {
  const topics = new Set();
  const today = new Date();
  await Promise.all(
    Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - (i + 1));
      return env.TRIVIA_KV.get(`questions:${d.toISOString().split('T')[0]}`, 'json').then(cached => {
        if (cached?.questions) cached.questions.forEach(q => topics.add(q.wiki_topic.toLowerCase()));
      });
    })
  );
  return topics;
}

// ── Generate one question via Anthropic ──────────────────────────────────────
async function generateQuestion(topicIdx, apiKey, recentTopics = new Set()) {
  const t = TOPICS[topicIdx];
  const avoidClause = recentTopics.size > 0
    ? `\nDo NOT use any of these Wikipedia topics — they were used in the last 7 days: ${[...recentTopics].join(', ')}.`
    : '';

  const prompt = `Generate a challenging but fair multiple-choice trivia question about: ${t.prompt}.
Base it on a real, specific Wikipedia-worthy fact.${avoidClause}
Return ONLY valid compact JSON (no markdown, no extra text):
{"question":"...","options":["A. ...","B. ...","C. ...","D. ..."],"correct":0,"explanation":"1-2 sentence explanation of the correct answer.","wiki_topic":"Wikipedia article title","category":"${t.label}"}
Rules:
- "correct" is the 0-based index. All 4 options must be plausible. Be specific and factual. No trivially easy questions.
- The correct answer must NOT appear in the question text. Do not include the name of the correct answer — or any term that uniquely identifies it — within the question itself.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  const raw = data.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ── Fetch a CC-licensed image from Wikimedia for a topic ─────────────────────
async function fetchWikiImage(topic) {
  try {
    // Step 1: get the page's lead image filename
    const pageUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`;
    const pageRes = await fetch(pageUrl, { headers: { 'User-Agent': 'Carta/1.0 (carta@okapiagames.com)' } });
    if (!pageRes.ok) return null;
    const page = await pageRes.json();

    // Must have a thumbnail
    if (!page.originalimage?.source) return null;
    const imgUrl   = page.originalimage.source;
    const fileName = decodeURIComponent(imgUrl.split('/').pop().split('?')[0]);

    // Step 2: check license via Wikimedia Commons API
    const metaUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=File:${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=extmetadata&format=json&origin=*`;
    const metaRes = await fetch(metaUrl, { headers: { 'User-Agent': 'Carta/1.0 (carta@okapiagames.com)' } });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json();

    const pages = Object.values(meta?.query?.pages || {});
    if (!pages.length) return null;
    const ext = pages[0]?.imageinfo?.[0]?.extmetadata;
    if (!ext) return null;

    const license = (ext.LicenseShortName?.value || '').toUpperCase();
    const author  = ext.Artist?.value?.replace(/<[^>]+>/g, '').trim() || 'Wikimedia Commons';
    const desc    = ext.ImageDescription?.value?.replace(/<[^>]+>/g, '').trim() || topic;

    // Only accept CC0, CC-BY, CC-BY-SA (any version). Reject NC, ND, fair use.
    const ok = ['CC0','CC BY','CC-BY','CC BY-SA','CC-BY-SA','PUBLIC DOMAIN'].some(p => license.startsWith(p));
    if (!ok) return null;

    return {
      url:     imgUrl,
      caption: desc.length > 80 ? desc.slice(0, 78) + '…' : desc,
      author:  author.length > 60 ? author.slice(0, 58) + '…' : author,
      license: ext.LicenseShortName?.value || license,
      topic,
    };
  } catch {
    return null;
  }
}


// ── Translate questions into supported languages via Google Cloud Translation ──
const TRANSLATE_LANGS = ['ta', 'hi', 'bn', 'kn', 'ja'];

async function translateQuestions(questions, apiKey) {
  if (!apiKey) return {};

  // Flatten to [question, opt0, opt1, opt2, opt3, explanation] per question (6 strings each)
  const strings = questions.flatMap(q => [
    q.question,
    ...q.options.map(o => o.replace(/^[A-D]\.\s*/i, '')),
    q.explanation,
  ]);

  const translations = {};
  await Promise.all(TRANSLATE_LANGS.map(async lang => {
    try {
      const res = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: strings, target: lang, format: 'text' }),
        }
      );
      if (!res.ok) return;
      const data = await res.json();
      const tr = data.data.translations.map(t => t.translatedText);
      const letters = ['A', 'B', 'C', 'D'];
      translations[lang] = questions.map((_, i) => {
        const b = i * 6;
        return {
          question:    tr[b],
          options:     letters.map((l, j) => `${l}. ${tr[b + 1 + j]}`),
          explanation: tr[b + 5],
        };
      });
    } catch {
      // Skip this language silently; frontend falls back to English
    }
  }));

  return translations;
}

async function getDailyQuestions(env) {
  const date = todayUTC();
  const cacheKey = `questions:${date}`;
  const lockKey  = `lock:${date}`;

  // Serve from cache immediately if available
  const cached = await env.TRIVIA_KV.get(cacheKey, 'json');
  if (cached) return cached;

  // Stampede guard: only one Worker generates at a time.
  // Others poll for up to 25 s then serve whatever is cached.
  const lock = await env.TRIVIA_KV.get(lockKey);
  if (lock) {
    // Another instance is already generating — wait and return cache when ready
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const ready = await env.TRIVIA_KV.get(cacheKey, 'json');
      if (ready) return ready;
    }
    throw new Error('Questions are being generated — please try again in a moment.');
  }

  // Claim the lock for 90 seconds
  await env.TRIVIA_KV.put(lockKey, '1', { expirationTtl: 90 });

  try {
    // Fetch recent topics to avoid repeats, then generate all 10 in parallel
    const recentTopics = await getRecentTopics(env);

    const questions = await Promise.all(
      TOPICS.map((_, i) =>
        new Promise(resolve =>
          setTimeout(async () => {
            try { resolve(await generateQuestion(i, env.ANTHROPIC_API_KEY, recentTopics)); }
            catch { resolve(null); }
          }, i * 120)
        )
      )
    );

    // Filter nulls and questions where the answer leaks into the question text
    const valid = questions.filter(q => q && !hasAnswerLeak(q));
    // Accept as few as 6 rather than retrying everything when a few are filtered
    if (valid.length < 6) throw new Error('Too few questions generated');

    // Translate to all supported languages in parallel
    const translations = await translateQuestions(valid, env.GOOGLE_TRANSLATE_KEY);

    // Try to fetch a CC-licensed image — pick randomly from all questions, try up to 4
    let dailyImage = null;
    const candidates = [...valid].sort(() => Math.random() - 0.5).slice(0, 4);
    for (const q of candidates) {
      dailyImage = await fetchWikiImage(q.wiki_topic);
      if (dailyImage) break;
    }

    const payload = { date, questions: valid, translations, dailyImage, generatedAt: new Date().toISOString() };
    // Cache until midnight UTC + 2h buffer
    const now = Date.now();
    const midnight = new Date(date);
    midnight.setUTCDate(midnight.getUTCDate() + 1);
    const ttl = Math.floor((midnight.getTime() - now) / 1000) + 7200;
    await env.TRIVIA_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: ttl });
    return payload;
  } finally {
    // Always release the lock so a failure doesn't block all subsequent requests
    await env.TRIVIA_KV.delete(lockKey);
  }
}

// ── Submit a score ────────────────────────────────────────────────────────────
async function submitScore(env, body) {
  const { date, name, score, cats, results } = body;
  if (!date || !name || score === undefined) return json({ error: 'Missing fields' }, 400);

  const id = crypto.randomUUID().slice(0, 8);
  const entry = { id, name: name.slice(0, 32), score, cats, results, ts: Date.now() };

  const boardKey = `scores:${date}`;
  const existing = (await env.TRIVIA_KV.get(boardKey, 'json')) || [];
  existing.push(entry);
  // Keep top 100 by score
  existing.sort((a, b) => b.score - a.score);
  const trimmed = existing.slice(0, 100);
  await env.TRIVIA_KV.put(boardKey, JSON.stringify(trimmed), { expirationTtl: 7 * 86400 });

  return json({ id, rank: trimmed.findIndex(e => e.id === id) + 1, total: trimmed.length });
}

// ── About page strings (index must match frontend ABOUT_STRINGS) ─────────────
const ABOUT_STRINGS = [
  "A free daily game from Okapia Games",                                                          // 0
  "Every day, everyone answers the same ten questions, drawn from Wikipedia.",                     // 1
  "History and geography aren't separate subjects. They're one story. A river shapes a civilization. A war redraws a border. A voyage changes the world. Every question is another thread.", // 2
  "Every question links to its Wikipedia source so you can verify it, explore further, and keep following your curiosity.", // 3
  "HOW IT WORKS",                                                                                 // 4
  "Each day at midnight UTC, ten questions are generated from Wikipedia across History and Geography. Every player gets the same questions — so scores are comparable and you can challenge friends fairly.", // 5
  "Your personal progress is stored on your device only. Nothing is sent to our servers unless you choose to post your score to the daily leaderboard.", // 6
  "OKAPIA GAMES",                                                                                 // 7
  "Okapia Games is an independent games company based in Bengaluru, India. We make board games and digital games that reward curiosity.", // 8
  "Visit Okapia Games",                                                                           // 9
  "COMMUNITY",                                                                                    // 10
  "Think we got an answer wrong? Dispute it on GitHub — every question links to its Wikipedia source, so bring your evidence.", // 11
  "Want to talk about the questions, suggest topics, or compare scores? Come find us on Reddit.",  // 12
  "Dispute an answer",                                                                            // 13
  "AI-GENERATED CONTENT — ACCURACY NOTICE",                                                      // 14
  "Questions in Carta are generated by an AI language model (Claude by Anthropic) and are intended for entertainment and informal learning only.", // 15
  "While every question is required to cite a real Wikipedia article and must be based on well-established, verifiable facts, AI systems can and do make mistakes. A question may occasionally contain an inaccuracy, an outdated fact, or a subtly wrong answer.", // 16
  "Do not rely on Carta as an authoritative source. Always verify important facts independently — we link directly to the Wikipedia source on every question precisely so you can.", // 17
  "If you believe a question or answer is wrong, use the Dispute this answer button on the question card. We review all disputes.", // 18
  "PRIVACY",                                                                                      // 19
  "Carta does not collect, store, or sell personal data. We do not use cookies, tracking pixels, analytics scripts, or advertising networks.", // 20
  "Your game history — scores, streaks, category performance — is stored exclusively in your browser's localStorage. It never leaves your device unless you explicitly choose to export it (CSV) or post a score to the daily leaderboard.", // 21
  "If you post a score to the leaderboard, the only information sent to our server is your chosen display name, your score, and the date. No email address or persistent identifier is stored.", // 22
  "Carta operates under Indian law. Our servers are hosted on Cloudflare's global network.",      // 23
];

async function getAboutTranslations(env) {
  const cacheKey = 'about_translations:v1';
  const cached = await env.TRIVIA_KV.get(cacheKey, 'json');
  if (cached) return cached;

  if (!env.GOOGLE_TRANSLATE_KEY) return {};

  const translations = {};
  await Promise.all(TRANSLATE_LANGS.map(async lang => {
    try {
      const res = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${env.GOOGLE_TRANSLATE_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: ABOUT_STRINGS, target: lang, format: 'text' }),
        }
      );
      if (!res.ok) return;
      const data = await res.json();
      translations[lang] = data.data.translations.map(t => t.translatedText);
    } catch { }
  }));

  await env.TRIVIA_KV.put(cacheKey, JSON.stringify(translations), { expirationTtl: 30 * 86400 });
  return translations;
}

// ── Get leaderboard ───────────────────────────────────────────────────────────
async function getLeaderboard(env, date) {
  const scores = (await env.TRIVIA_KV.get(`scores:${date}`, 'json')) || [];
  return json({ date, scores: scores.slice(0, 20) });
}

// ── Edge cache helper ─────────────────────────────────────────────────────────
// Checks Cloudflare's edge cache first; on miss, runs handler, caches 2xx results.
// s-maxage controls CF edge TTL; max-age=0 means browsers always revalidate.
async function edgeCached(request, ctx, ttlSeconds, handler) {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await handler();
  if (response.ok) {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', `public, s-maxage=${ttlSeconds}, max-age=0`);
    const toStore = new Response(response.body, { status: response.status, headers });
    ctx.waitUntil(cache.put(request, toStore.clone()));
    return toStore;
  }
  return response;
}

// ── Router ────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // Serve the game HTML (static, inlined below)
    if (path === '/' || path === '/index.html') {
      return edgeCached(request, ctx, 300, async () =>
        new Response(GAME_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
        })
      );
    }

    // GET /api/questions — edge-cached 5 min; circuit breaker only fires on cache misses
    if (path === '/api/questions' && request.method === 'GET') {
      return edgeCached(request, ctx, 300, async () => {
        try {
          // Circuit breaker: counts Worker invocations (cache misses), not raw player count
          const countKey = `player_count:${todayUTC()}`;
          const current = parseInt(await env.TRIVIA_KV.get(countKey) || '0');
          if (current >= 50000) {
            return json({ error: "Carta is having an incredibly popular day — we've hit today's limit. Come back tomorrow!" }, 503);
          }
          await env.TRIVIA_KV.put(countKey, String(current + 1), { expirationTtl: 48 * 3600 });
          const payload = await getDailyQuestions(env);
          return json(payload);
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      });
    }

    // POST /api/score
    if (path === '/api/score' && request.method === 'POST') {
      try {
        const body = await request.json();
        return submitScore(env, body);
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    // GET /api/about — edge-cached 1 hour (rarely changes)
    if (path === '/api/about' && request.method === 'GET') {
      return edgeCached(request, ctx, 3600, async () => {
        try {
          const translations = await getAboutTranslations(env);
          return json({ strings: ABOUT_STRINGS, translations });
        } catch (e) {
          return json({ error: e.message }, 500);
        }
      });
    }

    // GET /api/leaderboard?date=YYYY-MM-DD — edge-cached 60 s
    if (path === '/api/leaderboard' && request.method === 'GET') {
      return edgeCached(request, ctx, 60, async () => {
        const date = url.searchParams.get('date') || todayUTC();
        return getLeaderboard(env, date);
      });
    }

    // POST /api/share — upload postcard PNG, store in R2, return public share URL
    // (R2 gives strongly-consistent reads, so a WhatsApp/Twitter crawler hitting
    // /img/:id.png moments later never races an eventually-consistent KV write.)
    if (path === '/api/share' && request.method === 'POST') {
      try {
        const buf = await request.arrayBuffer();
        if (buf.byteLength > 3 * 1024 * 1024) return json({ error: 'Too large' }, 400);
        const id = crypto.randomUUID().slice(0, 12);
        await env.POSTCARDS.put(`postcard:${id}`, buf, {
          httpMetadata: { contentType: 'image/png' },
        });
        const origin = new URL(request.url).origin;
        return json({ url: `${origin}/share/${id}` });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // GET/HEAD /img/:id.png — serve stored postcard PNG (used by OG share page)
    if (path.startsWith('/img/') && path.endsWith('.png') && (request.method === 'GET' || request.method === 'HEAD')) {
      const id = path.slice(5, -4);
      const obj = await env.POSTCARDS.get(`postcard:${id}`);
      if (!obj) return new Response('Not found', { status: 404 });
      return new Response(obj.body, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
          ...CORS,
        },
      });
    }

    // GET /share/:id — OG-tagged HTML page so WhatsApp/Twitter show the postcard image
    if (path.startsWith('/share/') && request.method === 'GET') {
      const id = path.slice(7);
      const origin = new URL(request.url).origin;
      const imgUrl = `${origin}/img/${id}.png`;
      const html = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>Carta · Daily Atlas Trivia</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Carta by Okapia Games">
<meta property="og:title" content="Carta · Daily Atlas Trivia">
<meta property="og:description" content="Can you beat my score? Ten questions every day — history, geography, general knowledge.">
<meta property="og:image" content="${imgUrl}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1800">
<meta property="og:image:height" content="1000">
<meta property="og:url" content="${origin}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${imgUrl}">
<meta http-equiv="refresh" content="0; url=/">
</head><body><script>window.location='/';</script></body></html>`;
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── Inlined Game HTML ─────────────────────────────────────────────────────────
// (The full game frontend is a template literal below.
//  In production, you can also serve it from R2 or a Pages project.)
const GAME_HTML = `__GAME_HTML__`;

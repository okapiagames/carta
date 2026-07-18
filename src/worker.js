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

// User-Agent required by Wikimedia's API etiquette — requests without one get rate-limited.
const WIKI_UA = 'Carta/1.0 (carta@okapiagames.com)';

// ── Multi-edition support: carta.okapiagames.com (global) vs cartain.okapiagames.com
// ("Carta.In" wordmark, South Asia only, indigo/ocean theme) served from this same
// Worker. Domain is "cartain" (one label) rather than "carta.in" (two labels) because
// Cloudflare's free Universal SSL wildcard only covers one level of subdomain — a
// two-label hostname would need the paid Advanced Certificate Manager or Total TLS. ──
function siteOf(request) {
  return new URL(request.url).hostname.startsWith('cartain.') ? 'in' : 'global';
}

// Per-site regions allowed when sourcing articles — null means unrestricted (global site).
const SITE_REGIONS = { in: ['South Asia'], global: null };

// Prefix date/site-scoped KV keys so the two editions never collide on the same key for
// the same date. Wikipedia category-member cache and About translations are intentionally
// left unprefixed — that data is identical across editions, no reason to fetch it twice.
function siteKey(site, key) {
  return site === 'in' ? `in:${key}` : key;
}

// Titles that are never valid question seeds (list/index/meta pages, not articles).
const EXCLUDED_TITLE_PREFIXES = ['List of', 'Timeline of', 'Index of', 'Wikipedia:', 'Category:', 'Template:', 'File:'];

// ── Category pool for Wikipedia article sourcing ─────────────────────────────
// Weights deliberately counteract Wikipedia's own coverage bias (which massively
// overrepresents the US, UK, and Western Europe). Do not rebalance the relative
// weight given to each region — that's an intentional editorial choice, not a
// bug. Within a region, both narrow "flavour" categories (a specific dynasty)
// and broad "History/Geography of {place}" categories are deliberately mixed —
// narrow ones give a category real texture, broad ones stop the same 5-6
// empires from being the only thing that ever gets asked about. Europe is
// capped intentionally and should not gain new categories.
// `broad: true` marks categories likely to surface widely-recognized topics (umbrella
// national/regional categories, iconic empires, global geography) rather than a niche
// dynasty or a single obscure site. Accessible slots draw from broad categories only;
// challenging slots draw from the full pool, exactly as before.
const CATEGORY_POOL = [
  // South Asia (~52)
  { cat: 'Chola dynasty',                region: 'South Asia', type: 'History',   weight: 4 },
  { cat: 'Maurya Empire',                region: 'South Asia', type: 'History',   weight: 4 },
  { cat: 'Mughal Empire',                region: 'South Asia', type: 'History',   weight: 4, broad: true },
  { cat: 'Gupta Empire',                 region: 'South Asia', type: 'History',   weight: 3 },
  { cat: 'Vijayanagara Empire',          region: 'South Asia', type: 'History',   weight: 3 },
  { cat: 'Indus Valley Civilisation',    region: 'South Asia', type: 'History',   weight: 3 },
  { cat: 'Vedic period',                 region: 'South Asia', type: 'History',   weight: 2 },
  { cat: 'Maratha Empire',               region: 'South Asia', type: 'History',   weight: 3 },
  { cat: 'Sikh Empire',                  region: 'South Asia', type: 'History',   weight: 2 },
  { cat: 'Indian independence movement', region: 'South Asia', type: 'History',   weight: 3, broad: true },
  { cat: 'Bengal Sultanate',             region: 'South Asia', type: 'History',   weight: 1 },
  { cat: 'Geography of India',           region: 'South Asia', type: 'Geography', weight: 3, broad: true },
  { cat: 'Rivers of India',              region: 'South Asia', type: 'Geography', weight: 2 },
  { cat: 'Mountains of India',           region: 'South Asia', type: 'Geography', weight: 2 },
  { cat: 'World Heritage Sites in India',region: 'South Asia', type: 'Geography', weight: 4, broad: true },
  { cat: 'Geography of South Asia',      region: 'South Asia', type: 'Geography', weight: 2, broad: true },
  { cat: 'Himalayas',                    region: 'South Asia', type: 'Geography', weight: 3, broad: true },
  { cat: 'Islands of India',             region: 'South Asia', type: 'Geography', weight: 3 },
  { cat: 'Western Ghats',                region: 'South Asia', type: 'Geography', weight: 1 },

  // Africa (~47)
  { cat: 'Mali Empire',                  region: 'Africa', type: 'History',   weight: 4 },
  { cat: 'Kingdom of Kush',              region: 'Africa', type: 'History',   weight: 4 },
  { cat: 'Ethiopian Empire',             region: 'Africa', type: 'History',   weight: 3 },
  { cat: 'Ancient Egypt',                region: 'Africa', type: 'History',   weight: 4, broad: true },
  { cat: 'Swahili people',               region: 'Africa', type: 'History',   weight: 3 },
  { cat: 'Great Zimbabwe',               region: 'Africa', type: 'History',   weight: 3 },
  { cat: 'History of Africa',            region: 'Africa', type: 'History',   weight: 3, broad: true },
  { cat: 'History of West Africa',       region: 'Africa', type: 'History',   weight: 2, broad: true },
  { cat: 'History of North Africa',      region: 'Africa', type: 'History',   weight: 2, broad: true },
  { cat: 'History of East Africa',       region: 'Africa', type: 'History',   weight: 1, broad: true },
  { cat: 'Kingdom of Aksum',             region: 'Africa', type: 'History',   weight: 2 },
  { cat: 'Sokoto Caliphate',             region: 'Africa', type: 'History',   weight: 2 },
  { cat: 'Nubia',                        region: 'Africa', type: 'History',   weight: 2 },
  { cat: 'Ashanti Empire',               region: 'Africa', type: 'History',   weight: 1 },
  { cat: 'Decolonisation of Africa',     region: 'Africa', type: 'History',   weight: 1, broad: true },
  { cat: 'African queens',               region: 'Africa', type: 'History',   weight: 2 },
  { cat: 'Geography of Africa',          region: 'Africa', type: 'Geography', weight: 2, broad: true },
  { cat: 'Rivers of Africa',             region: 'Africa', type: 'Geography', weight: 2 },
  { cat: 'Mountains of Africa',          region: 'Africa', type: 'Geography', weight: 1 },
  { cat: 'World Heritage Sites in Africa',region: 'Africa', type: 'Geography', weight: 2, broad: true },
  { cat: 'Great Rift Valley',            region: 'Africa', type: 'Geography', weight: 2, broad: true },
  { cat: 'Islands of Africa',            region: 'Africa', type: 'Geography', weight: 1 },

  // MENA (~35)
  { cat: 'Islamic Golden Age',           region: 'MENA', type: 'History',   weight: 4, broad: true },
  { cat: 'Achaemenid Empire',            region: 'MENA', type: 'History',   weight: 3 },
  { cat: 'Ottoman Empire',               region: 'MENA', type: 'History',   weight: 3, broad: true },
  { cat: 'Abbasid Caliphate',            region: 'MENA', type: 'History',   weight: 3 },
  { cat: 'Ancient Mesopotamia',          region: 'MENA', type: 'History',   weight: 3, broad: true },
  { cat: 'Islamic art',                  region: 'MENA', type: 'History',   weight: 2 },
  { cat: 'Arabic literature',            region: 'MENA', type: 'History',   weight: 2 },
  { cat: 'Fatimid Caliphate',            region: 'MENA', type: 'History',   weight: 1 },
  { cat: 'Safavid dynasty',              region: 'MENA', type: 'History',   weight: 2 },
  { cat: 'Umayyad Caliphate',            region: 'MENA', type: 'History',   weight: 1 },
  { cat: 'Mamluk Sultanate',             region: 'MENA', type: 'History',   weight: 1 },
  { cat: 'History of Iran',              region: 'MENA', type: 'History',   weight: 2, broad: true },
  { cat: 'Geography of the Middle East', region: 'MENA', type: 'Geography', weight: 3, broad: true },
  { cat: 'Rivers of Iran',               region: 'MENA', type: 'Geography', weight: 3 },
  { cat: 'World Heritage Sites in Iran', region: 'MENA', type: 'Geography', weight: 2, broad: true },

  // SE Asia (~29)
  { cat: 'Khmer Empire',                 region: 'SE Asia', type: 'History',   weight: 4, broad: true },
  { cat: 'Majapahit',                    region: 'SE Asia', type: 'History',   weight: 3 },
  { cat: 'Srivijaya',                    region: 'SE Asia', type: 'History',   weight: 3 },
  { cat: 'History of Southeast Asia',    region: 'SE Asia', type: 'History',   weight: 3, broad: true },
  { cat: 'History of Indonesia',         region: 'SE Asia', type: 'History',   weight: 1, broad: true },
  { cat: 'History of Vietnam',           region: 'SE Asia', type: 'History',   weight: 1, broad: true },
  { cat: 'History of Thailand',          region: 'SE Asia', type: 'History',   weight: 2, broad: true },
  { cat: 'History of Cambodia',          region: 'SE Asia', type: 'History',   weight: 1, broad: true },
  { cat: 'Geography of Southeast Asia',  region: 'SE Asia', type: 'Geography', weight: 3, broad: true },
  { cat: 'Mekong',                       region: 'SE Asia', type: 'Geography', weight: 3, broad: true },
  { cat: 'World Heritage Sites in Indonesia', region: 'SE Asia', type: 'Geography', weight: 3, broad: true },
  { cat: 'Islands of Indonesia',         region: 'SE Asia', type: 'Geography', weight: 2 },

  // East/Central Asia (~32)
  { cat: 'Tang dynasty',                 region: 'East/Central Asia', type: 'History',   weight: 3 },
  { cat: 'Song dynasty',                 region: 'East/Central Asia', type: 'History',   weight: 3 },
  { cat: 'Mongol Empire',                region: 'East/Central Asia', type: 'History',   weight: 4, broad: true },
  { cat: 'History of China',             region: 'East/Central Asia', type: 'History',   weight: 2, broad: true },
  { cat: 'History of Korea',             region: 'East/Central Asia', type: 'History',   weight: 3, broad: true },
  { cat: 'History of Central Asia',      region: 'East/Central Asia', type: 'History',   weight: 3, broad: true },
  { cat: 'History of Mongolia',          region: 'East/Central Asia', type: 'History',   weight: 1, broad: true },
  { cat: 'History of Japan',             region: 'East/Central Asia', type: 'History',   weight: 1, broad: true },
  { cat: 'Geography of East Asia',       region: 'East/Central Asia', type: 'Geography', weight: 2, broad: true },
  { cat: 'Geography of Central Asia',    region: 'East/Central Asia', type: 'Geography', weight: 2, broad: true },
  { cat: 'Tian Shan',                    region: 'East/Central Asia', type: 'Geography', weight: 2 },
  { cat: 'Rivers of Asia',               region: 'East/Central Asia', type: 'Geography', weight: 2 },
  { cat: 'Geography of China',           region: 'East/Central Asia', type: 'Geography', weight: 2, broad: true },
  { cat: 'Geography of Japan',           region: 'East/Central Asia', type: 'Geography', weight: 1, broad: true },
  { cat: 'Islands of Japan',             region: 'East/Central Asia', type: 'Geography', weight: 1 },

  // Americas (~26)
  { cat: 'Inca Empire',                  region: 'Americas', type: 'History',   weight: 3, broad: true },
  { cat: 'Maya peoples',                 region: 'Americas', type: 'History',   weight: 3, broad: true },
  { cat: 'Aztec Empire',                 region: 'Americas', type: 'History',   weight: 3, broad: true },
  { cat: 'History of South America',     region: 'Americas', type: 'History',   weight: 4, broad: true },
  { cat: 'History of Central America',   region: 'Americas', type: 'History',   weight: 2, broad: true },
  { cat: 'History of Mexico',            region: 'Americas', type: 'History',   weight: 1, broad: true },
  { cat: 'History of Peru',              region: 'Americas', type: 'History',   weight: 1, broad: true },
  { cat: 'Geography of South America',   region: 'Americas', type: 'Geography', weight: 2, broad: true },
  { cat: 'Geography of Central America', region: 'Americas', type: 'Geography', weight: 2, broad: true },
  { cat: 'Andes',                        region: 'Americas', type: 'Geography', weight: 2, broad: true },
  { cat: 'Amazon River',                 region: 'Americas', type: 'Geography', weight: 1, broad: true },
  { cat: 'Geography of Mexico',          region: 'Americas', type: 'Geography', weight: 2, broad: true },

  // Global Geography (~25) — no regional bias
  // NOTE: several bare top-level categories here (Deserts, Islands, Volcanoes, Lakes,
  // Waterfalls, World Heritage Sites) are mostly generic/definitional articles ("Lava
  // cave", "Cabbeling", "Reverse waterfall") or unrelated noise (car rallies), not
  // specific famous places — verified live and deliberately NOT marked broad. Kept in
  // the pool for challenging-slot variety, just not relied on for "easy".
  { cat: 'Mountain ranges',              region: 'Global Geography', type: 'Geography', weight: 3 },
  { cat: 'Seven Summits',                region: 'Global Geography', type: 'Geography', weight: 2, broad: true },
  { cat: 'International straits',        region: 'Global Geography', type: 'Geography', weight: 3, broad: true },
  { cat: 'World Heritage Sites',         region: 'Global Geography', type: 'Geography', weight: 4 },
  { cat: 'Oceans',                       region: 'Global Geography', type: 'Geography', weight: 4, broad: true },
  { cat: 'Deserts',                      region: 'Global Geography', type: 'Geography', weight: 2 },
  { cat: 'Islands',                      region: 'Global Geography', type: 'Geography', weight: 2 },
  { cat: 'Volcanoes',                    region: 'Global Geography', type: 'Geography', weight: 2 },
  { cat: 'Lakes',                        region: 'Global Geography', type: 'Geography', weight: 2 },
  { cat: 'Waterfalls',                   region: 'Global Geography', type: 'Geography', weight: 1 },

  // Oceania (~9)
  { cat: 'History of Polynesia',         region: 'Oceania', type: 'History',   weight: 2 },
  { cat: 'Māori culture',                region: 'Oceania', type: 'History',   weight: 2, broad: true },
  { cat: 'History of Oceania',           region: 'Oceania', type: 'History',   weight: 2, broad: true },
  { cat: 'Geography of Oceania',         region: 'Oceania', type: 'Geography', weight: 3, broad: true },

  // Europe (~5) — Byzantine, Rome, Greece only. Do not add categories here.
  { cat: 'Byzantine Empire',             region: 'Europe', type: 'History', weight: 2, broad: true },
  { cat: 'Roman Empire',                 region: 'Europe', type: 'History', weight: 2, broad: true },
  { cat: 'Ancient Greece',               region: 'Europe', type: 'History', weight: 1, broad: true },
];

// ── Daily rotating thread, seeded by date so it's the same for all players all day ──
const DAILY_THREADS = [
  "trade and the movement of goods, ideas, and people across the world",
  "the relationship between water — rivers, seas, monsoons — and human civilisation",
  "how things get their names — places, animals, inventions, scientific discoveries",
  "the history of food — where it came from, how it travelled, what it changed",
  "surprising firsts — the first time something happened anywhere in the world",
  "the connections between science, art, and power across different civilisations",
  "migration, diaspora, and how peoples have moved and reshaped the world",
  "the lives of ordinary people — not kings, but farmers, traders, sailors, weavers",
  "numbers that changed history — populations, distances, dates, quantities",
  "animals in human history — beasts of burden, sacred creatures, ecological shifts",
];

function pickDailyThread(date) {
  // Rotate on a true day-count, not the date string's units digit — parsing
  // "YYYYMMDD" as an integer and taking %10 previously just returned the last
  // digit of the day-of-month, so the theme repeated on a fixed calendar-day
  // cycle (e.g. the 1st/11th/21st of every month, forever) instead of rotating.
  const [y, m, d] = date.split('-').map(Number);
  const epochDay = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  const idx = epochDay % DAILY_THREADS.length;
  return DAILY_THREADS[idx];
}

// ── Question slots — 8 accessible (Q1-8, 4 History + 4 Geography, sourced from each
// region's most widely-recognized categories), 2 challenging (Q9-10, 1 History + 1
// Geography, sourced from the full category depth exactly as before) ────────────────
const TOPIC_SLOTS = [
  { label: 'History',   difficulty: 'accessible'  },
  { label: 'Geography', difficulty: 'accessible'  },
  { label: 'History',   difficulty: 'accessible'  },
  { label: 'Geography', difficulty: 'accessible'  },
  { label: 'History',   difficulty: 'accessible'  },
  { label: 'Geography', difficulty: 'accessible'  },
  { label: 'History',   difficulty: 'accessible'  },
  { label: 'Geography', difficulty: 'accessible'  },
  { label: 'History',   difficulty: 'challenging' },
  { label: 'Geography', difficulty: 'challenging' },
];

const PERSONA = `You are the Quizzard — a genuinely curious collector of the world's best
"wait, WHAT?" facts, sharing them the way you'd tell a friend something
you just found out yourself, grinning as you do it. Not a teacher lecturing
from the front of a room — a fellow discoverer standing next to the reader,
bright-eyed, pointing at something interesting and saying "look at THIS."
Your energy is warm, upbeat, a little delighted with the world — this is
the best part of someone's day, not a pop quiz.

Your questions span the full breadth of human civilisation — Chola dynasty,
Roman Empire, Ibn Battuta, Indus Valley, all equal. You actively resist the
gravitational pull of Western-centric history, because the best facts are
usually the ones people haven't heard yet. The same instinct applies to
whoever history tends to leave out of the frame — when the material genuinely
centers a queen, scholar, trader, or general who happens to be a woman, tell
her story rather than reaching past her for a more familiar king.

Cheerful voice, neutral content — these aren't in tension. You state facts,
not verdicts. Never editorialize, moralize, or signal how the reader should
feel about a person, culture, or event — no "sadly," "impressively,"
"shockingly," "of course," or similar throat-clearing judgment calls. Let
the fact carry its own weight; your personality comes through in energy,
curiosity, and phrasing — the brightness of *how* you tell it — never in
opinion about *what* you're telling.

Storytelling is one tool in the kit, not the whole voice — reach for a
narrative setup on roughly half your questions, and let the rest be more
direct: a clean, striking fact, plainly put, delivered with the same grin.
Either way, you're a careful weaver of facts: precise and economical, never
padding a question with atmosphere it doesn't need.`;

const QUESTION_CRAFT_RULES = `QUESTION CRAFT — the hook itself must be a fact worth knowing, not
just scene-dressing wrapped around one:
- Open with a genuinely surprising or delightful fact — a real "wait,
  WHAT" detail. If you stripped away the phrasing, there should still be
  an interesting fact underneath, not just an atmospheric sentence. Never
  a bare "What is X" stem. One short sentence, two at most — three is a
  last resort, not a target. Every word should earn its place; a reader
  should get the hook in one pass, not need to re-read it.
- Short, direct sentences over long ones with stacked clauses. If a
  sentence needs a comma-separated aside to make sense, cut the aside or
  split it into its own sentence.
- Don't save every good detail for the explanation. If the article gives
  you two interesting angles, put the better one in the question itself
  and let the explanation go deeper on the same person/place/event — a
  layer further into the same thread, not a rehash of what the question
  already said and not a jump to an unrelated angle.
- Split roughly evenly across the ten questions: about half can use a
  short narrative setup ("When X happened...", "The year Y did Z..."),
  the other half should state the fact directly and ask the question with
  no scene to set. A plain, striking fact is just as strong a hook as a
  story — don't let narrative framing become the default.
- State facts, don't rate them. No adjectives that pass judgment on the
  subject or event ("tragic," "impressive," "brilliant," "shocking") —
  describe what happened, not how the reader should feel about it.`;

const ANSWER_OPTION_RULES = `ANSWER OPTIONS — four distinct types:
1. The correct answer — unambiguously right, verifiable.
2. The tempting wrong answer — something a well-read person might
   confidently guess, but is wrong.
3. The plausible but unlikely — fits the category, feels possible,
   probably wrong.
4. The red herring — oddly specific and confident-sounding, but wrong.

No obviously absurd options. No joke answers. Options must be
meaningfully different from each other — not just variations with
different numbers.`;

const EXPLANATION_RULES = `EXPLANATION: 2-3 sentences that explain the question just answered — not
a second, unrelated fact bolted on after it. Stay inside the same person,
place, or event the question already set up, and go one layer deeper: the
twist, the consequence, or the detail that makes the answer click into
place. If the question was about Samarkand, the explanation is still about
Samarkand — not a pivot to a different city, era, or figure that happens
to share a topic. The kind of detail that makes you want to keep reading,
not a dry restatement of the question. State it plainly — don't
editorialize or tell the reader how impressive, surprising, or sad it is;
the fact itself should do that work. Curiosity comes through in what you
chose to include, not in commentary on it.`;

const ACCURACY_RULES = `ACCURACY:
- Every question must be based on a well-established fact with a dedicated
  Wikipedia article.
- wiki_topic must be the exact Wikipedia article title provided — do not
  invent or substitute.
- Do not invent dates, names, or statistics. If uncertain about a fact
  from the article, base the question on something you are certain of.
- The correct answer must be unambiguously correct — not a matter of
  active scholarly debate.`;

const CONTENT_TONE_RULES = `TONE: This is a warm, delightful daily game, not a dark-history quiz.
If a given article's central subject is a mass atrocity, genocide, massacre,
or similarly traumatic tragedy, do not center a question on it. Pivot instead
to a neutral, factual angle available in the same summary — geography,
chronology, naming, culture — or, if nothing neutral is available, treat that
as a signal the article is a poor fit and build the gentlest possible
question from whatever context the summary gives you.`;

const ACCESSIBLE_DIFFICULTY = `Genuinely easy — something a half-remembered school textbook or
documentary would answer without hesitation. Easy means the ANSWER is
guessable, not that the hook has to be plain — the fact you open with
should still be a genuine "wait, WHAT"; you're just attaching it to a
more famous, more obvious correct answer.

The seed article may itself be obscure; that's expected, not a constraint.
Read its summary and build the question around whichever name, empire,
place, or event mentioned in it is most widely recognized — even if that's
not the article's own subject. (An obscure local ruler's article will
almost always mention the larger empire he belonged to; ask about that
instead.) wiki_topic stays the original article regardless — only what the
question asks about shifts. If nothing recognizable turns up in the summary
at all, make the question as gentle and guessable as possible rather than
reach for an obscure detail.`;

const CHALLENGING_DIFFICULTY = `This should be genuinely challenging — requiring real knowledge,
careful reasoning, or familiarity with history beyond the standard Western
curriculum.`;

const EXAMPLE_QUESTION = { question: "When Alexander the Great marched into Samarkand in 329 BCE, he reportedly admitted the city was even more beautiful than he'd imagined. Centuries on, that same city would owe its fortune to sitting astride which trade network connecting China to the Mediterranean?", options: ["A. The Amber Road", "B. The Silk Road", "C. The Incense Route", "D. The Royal Road of Persia"], correct: 1, explanation: "Samarkand's wealth wasn't only gold changing hands — it was ideas. Chinese papermakers captured after a battle near the city are said to have brought their craft with them, making Samarkand one of the first places outside China to manufacture paper, centuries before it reached Europe.", wiki_topic: "Silk Road", category: "History" };

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

// ── Layer 3: cross-day deduplication via KV `used_topics` ────────────────────
async function getUsedTopics(env, site) {
  const topics = await env.TRIVIA_KV.get(siteKey(site, 'used_topics'), 'json');
  return new Set((topics || []).map(t => t.toLowerCase()));
}

async function saveUsedTopics(env, site, newTitles) {
  const key = siteKey(site, 'used_topics');
  const existing = (await env.TRIVIA_KV.get(key, 'json')) || [];
  const combined = [...existing, ...newTitles].slice(-140);
  await env.TRIVIA_KV.put(key, JSON.stringify(combined), { expirationTtl: 15 * 86400 });
}

// ── Weighted random pick from a category pool slice ──────────────────────────
function weightedPick(pool) {
  const total = pool.reduce((sum, c) => sum + c.weight, 0);
  let r = Math.random() * total;
  for (const c of pool) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return pool[pool.length - 1];
}

// ── Layer 1: fetch a category's member titles, cached in KV for 7 days ───────
async function fetchCategoryMembers(env, categoryName) {
  const kvKey = `catmembers:${categoryName.replace(/\s+/g, '_')}`;
  const cached = await env.TRIVIA_KV.get(kvKey, 'json');
  if (cached) return cached;

  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent('Category:' + categoryName)}&cmlimit=500&cmtype=page&format=json`;
    const res = await fetch(url, { headers: { 'User-Agent': WIKI_UA } });
    if (!res.ok) return [];
    const data = await res.json();
    const titles = (data.query?.categorymembers || [])
      .map(m => m.title)
      .filter(title => !EXCLUDED_TITLE_PREFIXES.some(p => title.startsWith(p)));
    await env.TRIVIA_KV.put(kvKey, JSON.stringify(titles), { expirationTtl: 7 * 86400 });
    return titles;
  } catch {
    return [];
  }
}

// ── Fetch + validate a single article summary ─────────────────────────────────
async function fetchArticleSummary(title) {
  if (EXCLUDED_TITLE_PREFIXES.some(p => title.startsWith(p))) return null;
  try {
    const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
      headers: { 'User-Agent': WIKI_UA },
    });
    if (!res.ok) return null;
    const page = await res.json();
    if (page.type !== 'standard') return null;
    if (!page.extract || page.extract.length < 150) return null;
    return { title: page.title, summary: page.extract.slice(0, 500) };
  } catch {
    return null;
  }
}

// Fallback when the category API is blocked or a category is exhausted/empty.
async function fetchRandomArticle() {
  try {
    const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/random/summary', {
      headers: { 'User-Agent': WIKI_UA },
    });
    if (!res.ok) return null;
    const page = await res.json();
    if (page.type !== 'standard') return null;
    if (!page.extract || page.extract.length < 150) return null;
    if (EXCLUDED_TITLE_PREFIXES.some(p => page.title.startsWith(p))) return null;
    return { title: page.title, summary: page.extract.slice(0, 500) };
  } catch {
    return null;
  }
}

// Region-scoped equivalent of fetchRandomArticle(), used instead of it whenever
// allowedRegions is set — keeps the fallback path airtight (e.g. cartain must never
// surface a truly random, potentially non-South-Asia article). Unions the cached member
// lists of every CATEGORY_POOL entry in the allowed regions and samples from that.
async function fetchRandomArticleFromRegions(env, allowedRegions, usedTopics, usedInBatch) {
  const entries = CATEGORY_POOL.filter(c => allowedRegions.includes(c.region));
  const memberLists = await Promise.all(entries.map(c => fetchCategoryMembers(env, c.cat)));
  const allMembers = [...new Set(memberLists.flat())];
  if (!allMembers.length) return null;

  const shuffled = [...allMembers].sort(() => Math.random() - 0.5).slice(0, 15); // don't hammer the API indefinitely
  for (const title of shuffled) {
    if (usedTopics.has(title.toLowerCase()) || usedInBatch.has(title.toLowerCase())) continue;
    const article = await fetchArticleSummary(title);
    if (article) return article;
  }
  return null;
}

// ── Layers 1-3 combined: pick one article to seed a given slot type ──────────
// preferBroad narrows sourcing to the region's most widely-recognized categories (for
// accessible slots) rather than its full depth (used for challenging slots, unchanged).
// allowedRegions (array or null) restricts both the category pool AND the random-article
// fallback to those regions — null preserves the original unrestricted global behavior.
async function pickArticleForSlot(env, type, usedTopics, usedInBatch, preferBroad = false, allowedRegions = null) {
  let typedPool = CATEGORY_POOL.filter(c => c.type === type);
  if (allowedRegions) typedPool = typedPool.filter(c => allowedRegions.includes(c.region));
  const broadPool = typedPool.filter(c => c.broad);
  const pool = (preferBroad && broadPool.length) ? broadPool : typedPool;
  const triedCategories = new Set();

  for (let attempt = 0; attempt < 3; attempt++) {
    const available = pool.filter(c => !triedCategories.has(c.cat));
    if (available.length === 0) break;
    const category = weightedPick(available);
    triedCategories.add(category.cat);

    const members = await fetchCategoryMembers(env, category.cat);
    if (!members.length) continue;

    // Filter out recently-used topics; never fail generation because of dedup —
    // fall back to the full unfiltered list if everything in this category is used up.
    let candidates = members.filter(t => !usedTopics.has(t.toLowerCase()) && !usedInBatch.has(t.toLowerCase()));
    if (!candidates.length) candidates = members.filter(t => !usedInBatch.has(t.toLowerCase()));
    if (!candidates.length) candidates = members;

    const shuffled = [...candidates].sort(() => Math.random() - 0.5).slice(0, 3);
    for (const title of shuffled) {
      const article = await fetchArticleSummary(title);
      if (article) return { title: article.title, summary: article.summary, region: category.region, type };
    }
  }

  // Category API blocked/empty for every attempted category — fall back to random summary,
  // scoped to allowedRegions when set so the fallback can never leave the intended region.
  if (allowedRegions) {
    const random = await fetchRandomArticleFromRegions(env, allowedRegions, usedTopics, usedInBatch);
    if (random) return { title: random.title, summary: random.summary, region: allowedRegions[0], type };
    throw new Error(`Could not source a Wikipedia article for slot type ${type} within regions ${allowedRegions.join(',')}`);
  }
  for (let i = 0; i < 5; i++) {
    const random = await fetchRandomArticle();
    if (random && !usedTopics.has(random.title.toLowerCase()) && !usedInBatch.has(random.title.toLowerCase())) {
      return { title: random.title, summary: random.summary, region: 'Global', type };
    }
  }
  throw new Error(`Could not source a Wikipedia article for slot type ${type}`);
}

// ── Layer 4: assemble the single batch prompt ─────────────────────────────────
function buildBatchPrompt(articles, thread) {
  const articleBlock = articles
    .map((a, i) => `${i + 1}. [${a.region}] "${a.title}" — ${a.summary}`)
    .join('\n\n');

  const slotBlock = TOPIC_SLOTS
    .map((slot, i) => {
      const note = slot.difficulty === 'accessible'
        ? 'lean on whatever is most widely recognized, even if that means pivoting away from this article\'s own obscure subject'
        : 'requires real knowledge beyond the standard Western curriculum';
      return `Q${i + 1}: Category=${slot.label}, Difficulty=${slot.difficulty} (${note}), Region=${articles[i].region}, Article="${articles[i].title}"`;
    })
    .join('\n');

  return `${PERSONA}

TODAY'S THREAD: "${thread}" — connect to this naturally, not forced.

ARTICLES (numbered, matching the question slots below):
${articleBlock}

QUESTION SLOTS:
${slotBlock}

${QUESTION_CRAFT_RULES}

${ANSWER_OPTION_RULES}

${EXPLANATION_RULES}

${ACCURACY_RULES}

${CONTENT_TONE_RULES}

DIFFICULTY:
Accessible — ${ACCESSIBLE_DIFFICULTY}
Challenging — ${CHALLENGING_DIFFICULTY}

EXAMPLE QUESTION (tone and format only — do not reuse this content):
${JSON.stringify(EXAMPLE_QUESTION)}

Return a JSON array of exactly 10 question objects, in the same order as the slots above, each shaped like the example, with "wiki_topic" set to the exact article title given for that slot. No markdown, no preamble, no trailing commentary — output ONLY the JSON array.`;
}

async function callHaikuBatch(prompt, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  const raw = data.content[0].text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of questions');
  return parsed;
}

function isValidQuestion(q) {
  return !!q
    && typeof q.question === 'string' && q.question.length > 0
    && Array.isArray(q.options) && q.options.length === 4
    && Number.isInteger(q.correct) && q.correct >= 0 && q.correct <= 3
    && typeof q.explanation === 'string' && q.explanation.length > 0
    && typeof q.wiki_topic === 'string' && q.wiki_topic.length > 0;
}

// ── Orchestrate layers 1-4: source 10 articles, batch-generate, validate ─────
// Sources all 10 slots concurrently (each pick is a handful of sequential Wikipedia
// fetches, so doing this slot-by-slot would take 10x as long). A concurrent pick can't
// see its siblings' choices, so any accidental duplicate titles are re-picked afterward.
async function pickArticlesForSlots(env, usedTopics, allowedRegions) {
  const noSiblings = new Set();
  const articles = await Promise.all(
    TOPIC_SLOTS.map(slot => pickArticleForSlot(env, slot.label, usedTopics, noSiblings, slot.difficulty === 'accessible', allowedRegions))
  );

  const seen = new Set();
  for (let i = 0; i < articles.length; i++) {
    const key = articles[i].title.toLowerCase();
    if (seen.has(key)) {
      articles[i] = await pickArticleForSlot(env, TOPIC_SLOTS[i].label, usedTopics, seen, TOPIC_SLOTS[i].difficulty === 'accessible', allowedRegions);
    }
    seen.add(articles[i].title.toLowerCase());
  }
  return articles;
}

async function generateDailyBatch(env, date, site) {
  const thread = pickDailyThread(date);
  const usedTopics = await getUsedTopics(env, site);
  const allowedRegions = SITE_REGIONS[site];

  let lastError;
  const MAX_ATTEMPTS = 15;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const articles = await pickArticlesForSlots(env, usedTopics, allowedRegions);
      const prompt = buildBatchPrompt(articles, thread);
      const questions = await callHaikuBatch(prompt, env.ANTHROPIC_API_KEY);
      const valid = questions.filter(isValidQuestion).filter(q => !hasAnswerLeak(q));

      if (valid.length < TOPIC_SLOTS.length) {
        console.warn(`generateDailyBatch: attempt ${attempt + 1}/${MAX_ATTEMPTS} only produced ${valid.length}/${TOPIC_SLOTS.length} valid questions, retrying`);
        throw new Error(`Only ${valid.length}/${TOPIC_SLOTS.length} questions passed validation`);
      }

      const shipped = valid.slice(0, TOPIC_SLOTS.length);
      await saveUsedTopics(env, site, shipped.map(q => q.wiki_topic));
      return { questions: shipped, thread };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`Question generation failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
}

// ── Turn a raw Wikimedia image description into a short, readable caption ────
// Commons descriptions are frequently multi-language ("English: ... Français:
// ..."), carry citation markers, or are otherwise not fit to show as-is.
function cleanCaption(raw, topic) {
  if (!raw) return topic;

  let text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\[[^\]]*\]/g, '')      // citation/footnote markers, e.g. [1], [citation needed]
    .replace(/\s+/g, ' ')
    .trim();

  // Multi-language descriptions are concatenated as "English: ... Français: ...".
  // Keep only the segment for the first language label present.
  const labels = [...text.matchAll(/\b([A-Z][a-zA-Zà-ÿ]{2,20}):\s/g)];
  if (labels.length >= 2) {
    text = text.slice(labels[0].index + labels[0][0].length, labels[1].index).trim();
  } else if (labels.length === 1 && labels[0].index === 0) {
    text = text.slice(labels[0][0].length).trim();
  }

  text = text.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!text || text.length < 4) return topic;

  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Truncate at a word boundary instead of slicing mid-word.
function truncateAtWord(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '…';
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
    const desc    = cleanCaption(ext.ImageDescription?.value, topic);

    // Only accept CC0, CC-BY, CC-BY-SA (any version). Reject NC, ND, fair use.
    const ok = ['CC0','CC BY','CC-BY','CC BY-SA','CC-BY-SA','PUBLIC DOMAIN'].some(p => license.startsWith(p));
    if (!ok) return null;

    return {
      url:     imgUrl,
      caption: truncateAtWord(desc, 78),
      author:  truncateAtWord(author, 58),
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

async function getDailyQuestions(env, site) {
  const date = todayUTC();
  const cacheKey = siteKey(site, `questions:${date}`);
  const lockKey  = siteKey(site, `lock:${date}`);

  // Serve from cache immediately if available
  const cached = await env.TRIVIA_KV.get(cacheKey, 'json');
  if (cached) return cached;

  // Stampede guard: only one Worker generates at a time.
  // Others poll for up to 45 s then serve whatever is cached.
  const lock = await env.TRIVIA_KV.get(lockKey);
  if (lock) {
    // Another instance is already generating — wait and return cache when ready
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const ready = await env.TRIVIA_KV.get(cacheKey, 'json');
      if (ready) return ready;
    }
    throw new Error('Questions are being generated — please try again in a moment.');
  }

  // Claim the lock for 4 minutes — generateDailyBatch now retries up to 15
  // times to land exactly 10 valid questions, so a single generation can
  // take meaningfully longer than the old 90s budget.
  await env.TRIVIA_KV.put(lockKey, '1', { expirationTtl: 240 });

  try {
    // Source articles (Wikipedia category pool) and batch-generate all 10 questions in one Haiku call
    const { questions: valid, thread } = await generateDailyBatch(env, date, site);

    // Translate to all supported languages in parallel
    const translations = await translateQuestions(valid, env.GOOGLE_TRANSLATE_KEY);

    // Try to fetch a CC-licensed image — pick randomly from all questions, try up to 4
    let dailyImage = null;
    const candidates = [...valid].sort(() => Math.random() - 0.5).slice(0, 4);
    for (const q of candidates) {
      dailyImage = await fetchWikiImage(q.wiki_topic);
      if (dailyImage) break;
    }

    const payload = { date, questions: valid, translations, dailyImage, thread, generatedAt: new Date().toISOString() };
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

// ── Track outbound Instagram follow-link clicks ───────────────────────────────
// No identity is captured — Instagram doesn't expose who actually follows from a
// link click, so this is a simple daily click count per edition, not per-player.
async function trackInstagramClick(env, site) {
  const key = siteKey(site, `instagram_clicks:${todayUTC()}`);
  const current = parseInt(await env.TRIVIA_KV.get(key) || '0');
  await env.TRIVIA_KV.put(key, String(current + 1), { expirationTtl: 400 * 86400 });
  return json({ ok: true });
}

// ── Submit a score ────────────────────────────────────────────────────────────
async function submitScore(env, site, body) {
  const { date, name, cats, results } = body;
  if (!date || !name || !Array.isArray(results) || results.length === 0 || results.length > 20) {
    return json({ error: 'Missing or invalid fields' }, 400);
  }
  // Recompute score server-side from `results` rather than trusting a client-submitted
  // score value, so a spoofed POST can't fake the top of the leaderboard.
  const score = results.filter(Boolean).length;

  const id = crypto.randomUUID().slice(0, 8);
  const entry = { id, name: name.slice(0, 32), score, cats, results, ts: Date.now() };

  const boardKey = siteKey(site, `scores:${date}`);
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
async function getLeaderboard(env, site, date) {
  const scores = (await env.TRIVIA_KV.get(siteKey(site, `scores:${date}`), 'json')) || [];
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
      return edgeCached(request, ctx, 300, async () => {
        // cartain gets its own wordmark in the tags that matter for link previews —
        // the rest of the page brands itself client-side via IS_IN_SITE/BRAND.
        const html = siteOf(request) === 'in'
          ? GAME_HTML
              .replace('<title>Carta · Okapia Games</title>', '<title>Carta.In · Okapia Games</title>')
              .replace('content="Carta · Okapia Games">', 'content="Carta.In · Okapia Games">')
              .replace(/https:\/\/carta\.okapiagames\.com\//g, 'https://cartain.okapiagames.com/')
          : GAME_HTML;
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
        });
      });
    }

    // GET /sitemap.xml — single-page app, so this just points crawlers at the homepage
    // of whichever edition served the request (each edition is a distinct indexable site).
    if (path === '/sitemap.xml' && request.method === 'GET') {
      const origin = new URL(request.url).origin;
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;
      return new Response(xml, {
        headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ...CORS },
      });
    }

    // GET/HEAD /og.png — default Open Graph preview image (for shares of the bare URL,
    // as opposed to a postcard /share/:id link, which gets its own generated image from R2)
    if (path === '/og.png' && (request.method === 'GET' || request.method === 'HEAD')) {
      const bytes = Uint8Array.from(atob(OG_IMAGE_B64), c => c.charCodeAt(0));
      return new Response(bytes, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=604800, immutable',
          ...CORS,
        },
      });
    }

    // GET /api/questions — edge-cached 5 min; circuit breaker only fires on cache misses
    if (path === '/api/questions' && request.method === 'GET') {
      return edgeCached(request, ctx, 300, async () => {
        try {
          const site = siteOf(request);
          // Circuit breaker: counts Worker invocations (cache misses), not raw player count.
          // Tracked per-site so a spike on one edition can't trip the breaker for the other.
          const countKey = siteKey(site, `player_count:${todayUTC()}`);
          const current = parseInt(await env.TRIVIA_KV.get(countKey) || '0');
          if (current >= 50000) {
            // Log once per day so it's visible in Cloudflare Worker Logs / `wrangler tail`,
            // without spamming a log line on every request for the rest of the day.
            const alertKey = siteKey(site, `circuit_breaker_alerted:${todayUTC()}`);
            if (!(await env.TRIVIA_KV.get(alertKey))) {
              console.warn(`Circuit breaker tripped (${site}): ${current} cache-miss invocations today (${todayUTC()})`);
              ctx.waitUntil(env.TRIVIA_KV.put(alertKey, '1', { expirationTtl: 48 * 3600 }));
            }
            return json({ error: "Carta is having an incredibly popular day — we've hit today's limit. Come back tomorrow!" }, 503);
          }
          await env.TRIVIA_KV.put(countKey, String(current + 1), { expirationTtl: 48 * 3600 });
          const payload = await getDailyQuestions(env, site);
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
        return submitScore(env, siteOf(request), body);
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }

    // POST /api/track-instagram — fired when a player clicks the "Follow us" link
    if (path === '/api/track-instagram' && request.method === 'POST') {
      try {
        return await trackInstagramClick(env, siteOf(request));
      } catch (e) {
        return json({ error: e.message }, 500);
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
        return getLeaderboard(env, siteOf(request), date);
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
        // Actual PNG pixel size varies with the uploading device's devicePixelRatio —
        // store it so the OG tags below reflect the real image instead of a guess.
        const w = parseInt(url.searchParams.get('w'), 10);
        const h = parseInt(url.searchParams.get('h'), 10);
        await env.POSTCARDS.put(`postcard:${id}`, buf, {
          httpMetadata: { contentType: 'image/png' },
          customMetadata: (w > 0 && h > 0) ? { w: String(w), h: String(h) } : {},
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
      const meta = await env.POSTCARDS.head(`postcard:${id}`);
      // Fall back to the common 2x-DPR postcard size if metadata is missing (older links).
      const imgW = parseInt(meta?.customMetadata?.w, 10) || 1800;
      const imgH = parseInt(meta?.customMetadata?.h, 10) || 1000;
      const brand = siteOf(request) === 'in' ? 'Carta.In' : 'Carta';
      const html = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>${brand} · Daily Atlas Trivia</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="${brand} by Okapia Games">
<meta property="og:title" content="${brand} · Daily Atlas Trivia">
<meta property="og:description" content="Can you beat my score? Ten questions every day — history, geography, general knowledge.">
<meta property="og:image" content="${imgUrl}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${imgW}">
<meta property="og:image:height" content="${imgH}">
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

  // Cron trigger (see wrangler.toml [triggers]) — fires at UTC midnight so the
  // India edition's questions are generated and cached proactively instead of
  // making the first visitor of the day eat the generation latency.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      getDailyQuestions(env, 'in').catch(err =>
        console.error('scheduled: failed to pre-generate India daily batch', err)
      )
    );
  },
};

// ── Inlined Game HTML ─────────────────────────────────────────────────────────
// (The full game frontend is a template literal below.
//  In production, you can also serve it from R2 or a Pages project.)
// ── Default OG image (1200x630 PNG, base64) ───────────────────────────────────
const OG_IMAGE_B64 = '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QCAEAAAAABAIAQAAAAAEQgAAAAAAgRAAAAAAQCAEAAAAABAIAQAAAAAEQgAAAAAAgRAAAAAAQCAEAAAAABAIAQAAAAAEQgAAAAAAgRAAAAAAQCAEAAAAABAIAQAAAAAEQgAAAAAAgRAAAAAAQCAEAAAAABAIAQAAAAAEQgAAAAAAgRAAAAAAQCAEAAAAAAIhRQAAAAAABEIAAAAAAIEQAAAAAEAgBAAAAAAQCAEAAAAABEIAAAAAAIEQAAAAAEAgBAAAAAAQCAEAAAAABEIAAAAAAIEQAAAAAEAgBAAAAAAQCAEAAAAABEIAAAAAAIEQAAAAAEAgBAAAAAAQCAEAAAAABEIAAAAAAIEQAAAAAEAgBAAAAAAQCAEAAAAABEIAAAAAAIEQAAAAAEAgBAAAAAACIQAAAACAQAgAAAAAIBACAAAAAAiEAAAAAAACIQAAAACAQAgAAAAAIBACAAAAAAiEAAAAAAACIQAAAACAQAgAAAAAIBACAAAAAAiEAAAAAAACIQAAAACAQAgAAAAAIBACAAAAAAiEAAAAAAACIQAAAACAQAgAAAAAIBACAAAAAAiEAAAAAAACIQAAAACAQAgAAAAAIBACAAAAAIEQAAAAAEAgBAAAAAAQCAEAAAAABEIAAAAAAIEQAAAAAEAgBAAAAAC0bEqP9p0pBQAAAABoheghBAAAAIBWSubkHkQpAAAAAEArRA8hAAAAABAIAQAAAAAEQgAAAAAAgRAAAAAAQCAEAAAAANxC/h/SPX9dANpDFwAAAABJRU5ErkJggg==';

const GAME_HTML = `__GAME_HTML__`;

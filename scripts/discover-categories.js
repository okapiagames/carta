#!/usr/bin/env node
// scripts/discover-categories.js — crawl Wikipedia's category tree from a known-good
// root to surface CANDIDATE categories for CATEGORY_POOL in src/worker.js.
//
// This does NOT auto-populate the pool. region/type/weight/broad are editorial
// judgment calls — "broad" specifically means "a human recognizes this as famous,"
// which a crawler can't determine (see the CATEGORY_POOL discovery from the numeric-
// answer/theme-repetition investigation: automating that assignment away loses the
// entire accessible/challenging difficulty mechanism). What this DOES automate is the
// tedious part — finding subcategories you might not have thought of, with a rough
// size signal — so a human only has to review and tag, not brainstorm from scratch.
//
// Usage:
//   node scripts/discover-categories.js --root="History of India" --region="South Asia" --type=History
//   node scripts/discover-categories.js --root="Geography of Pakistan" --region="South Asia" --type=Geography --depth=1 --min-members=10
//
// --root         Wikipedia category to crawl (without the "Category:" prefix)
// --region       label only, for the report — doesn't need to match CATEGORY_POOL's
//                region names exactly, just helps you eyeball relevance
// --type         label only, same reasoning ("History" / "Geography" / anything)
// --depth        how many levels of subcategories to follow (default 1). Each level
//                multiplies API calls — keep this low; 1 is usually enough since most
//                topic categories are already fairly specific one level down
// --min-members  skip categories with fewer than this many member pages (default 5) —
//                filters out near-empty categories not worth sourcing from

import { CATEGORY_POOL } from '../src/worker.js';

const WIKI_UA = 'Carta-discovery-script/1.0 (carta@okapiagames.com)';
const MAX_SIZED = 200; // hard cap on how many categories we fetch a member-count for,
                        // so a deep/wide crawl can't hammer Wikipedia's API unbounded

const MAINTENANCE_PATTERNS = [
  /\bstubs?\b/i, /\bredirects?\b/i, /\barticles? (with|needing|lacking|using)\b/i,
  /\bpages? (using|with|needing)\b/i, /\bwikipedia\b/i, /\bcategories\b/i,
  /\btemplates?\b/i, /\bby (year|century|decade|date)\b/i, /\bbirths?\b/i,
  /\bdeaths?\b/i, /\bliving people\b/i, /\bmaintenance\b/i, /\bcs1\b/i,
  /\bcommons category\b/i, /\bset index\b/i, /\bdisambiguation\b/i,
];

function looksLikeMaintenance(name) {
  return MAINTENANCE_PATTERNS.some(p => p.test(name));
}

function parseArgs(argv) {
  const args = { depth: 1, minMembers: 5 };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1] === 'min-members' ? 'minMembers' : m[1];
    const val = m[2];
    args[key] = key === 'depth' || key === 'minMembers' ? Number(val) : val;
  }
  return args;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function wikiCategoryQuery(catName, cmtype) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent('Category:' + catName)}&cmlimit=500&cmtype=${cmtype}&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': WIKI_UA } });
  if (!res.ok) return { members: [], truncated: false };
  const data = await res.json();
  const members = data.query?.categorymembers || [];
  return { members: members.map(m => m.title.replace(/^Category:/, '')), truncated: !!data.continue };
}

async function crawl(root, depth, seen) {
  if (depth < 0 || seen.has(root)) return [];
  seen.add(root);
  await sleep(150);
  const { members: subcats } = await wikiCategoryQuery(root, 'subcat');
  const clean = subcats.filter(c => !looksLikeMaintenance(c));
  let results = [...clean];
  if (depth > 0) {
    for (const sub of clean) {
      results = results.concat(await crawl(sub, depth - 1, seen));
    }
  }
  return [...new Set(results)];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.region || !args.type) {
    console.error('Usage: node scripts/discover-categories.js --root="History of India" --region="South Asia" --type=History [--depth=1] [--min-members=5]');
    process.exit(1);
  }

  const existing = new Set(CATEGORY_POOL.map(c => c.cat.toLowerCase()));

  console.log(`Crawling "Category:${args.root}" (depth ${args.depth})...`);
  const candidates = await crawl(args.root, args.depth, new Set());
  console.log(`Found ${candidates.length} subcategories after filtering maintenance categories. Checking sizes (capped at ${MAX_SIZED})...\n`);

  const toSize = candidates.slice(0, MAX_SIZED);
  const results = [];
  for (const cat of toSize) {
    await sleep(150);
    const { members, truncated } = await wikiCategoryQuery(cat, 'page');
    const count = truncated ? '500+' : members.length;
    if (typeof count === 'number' && count < args.minMembers) continue;
    results.push({ cat, count, already: existing.has(cat.toLowerCase()) });
  }

  results.sort((a, b) => (b.count === '500+' ? 501 : b.count) - (a.count === '500+' ? 501 : a.count));

  console.log(`${'Category'.padEnd(45)} ${'Members'.padEnd(10)} Status`);
  console.log('-'.repeat(70));
  for (const r of results) {
    console.log(`${r.cat.padEnd(45)} ${String(r.count).padEnd(10)} ${r.already ? 'already in pool' : 'NEW candidate'}`);
  }

  const newCount = results.filter(r => !r.already).length;
  console.log(`\n${newCount} new candidates for region: '${args.region}', type: '${args.type}'.`);
  console.log(`Review each — assign a weight (this file's convention is roughly 1-5) and only`);
  console.log(`mark broad:true for ones a typical player would actually recognize — then add`);
  console.log(`to CATEGORY_POOL in src/worker.js by hand.`);
}

main().catch(err => {
  console.error('discover-categories failed:', err);
  process.exit(1);
});

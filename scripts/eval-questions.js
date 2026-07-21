#!/usr/bin/env node
// scripts/eval-questions.js — offline quality gate for a day's generated question batch.
//
// This is NOT part of the request path (see #28: adding a judge call to /api/questions
// would reintroduce the exact latency problem that issue fixed). Run it by hand, or on
// a schedule you control, against a batch that's already been generated and cached.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node scripts/eval-questions.js [--date=YYYY-MM-DD] [--site=global|in] [--file=path.json] [--model=claude-sonnet-5]
//
// Without --file, pulls the cached batch straight from production KV via `wrangler kv key get`
// (same TRIVIA_KV namespace the Worker uses — requires the same Cloudflare auth `wrangler`
// already uses locally). With --file, judges a local JSON payload instead (e.g. one saved
// from a manual generateDailyBatch test run) so you don't need KV access to try this out.
//
// Judges the actual rubric text imported from src/worker.js — not a hand-copied rubric —
// so this can't silently drift out of sync the next time PERSONA/HISTORY_RULES/etc. change.

import { execFileSync } from 'child_process';
import {
  PERSONA, HISTORY_RULES, GEOGRAPHY_RULES, QUESTION_CRAFT_RULES, ANSWER_OPTION_RULES,
  EXPLANATION_RULES, ACCURACY_RULES, CONTENT_TONE_RULES, ACCESSIBLE_DIFFICULTY,
  CHALLENGING_DIFFICULTY, TOPIC_SLOTS,
} from '../src/worker.js';

function parseArgs(argv) {
  const args = { site: 'global', model: 'claude-sonnet-5' };
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function todayUTC() {
  return new Date().toISOString().split('T')[0];
}

function fetchBatchFromKV(date, site) {
  const key = site === 'in' ? `in:questions:${date}` : `questions:${date}`;
  const raw = execFileSync(
    'npx',
    ['wrangler', 'kv', 'key', 'get', key, '--binding', 'TRIVIA_KV', '--remote'],
    { encoding: 'utf8' }
  );
  return JSON.parse(raw);
}

function buildJudgePrompt(questions) {
  const rubric = `You are a strict quality reviewer for a daily trivia game. You did not write
these questions — someone else did, following the rules below. Your only job is to check
whether each question actually follows them, and say exactly where it doesn't.

${PERSONA}

${HISTORY_RULES}

${GEOGRAPHY_RULES}

${QUESTION_CRAFT_RULES}

${ANSWER_OPTION_RULES}

${EXPLANATION_RULES}

${ACCURACY_RULES}

${CONTENT_TONE_RULES}

DIFFICULTY:
Accessible — ${ACCESSIBLE_DIFFICULTY}
Challenging — ${CHALLENGING_DIFFICULTY}`;

  const questionBlock = questions
    .map((q, i) => {
      const slot = TOPIC_SLOTS[i] || {};
      return `Q${i + 1} (expected Category=${slot.label || '?'}, Difficulty=${slot.difficulty || '?'}):
${JSON.stringify(q)}`;
    })
    .join('\n\n');

  return `${rubric}

Review each of the following ${questions.length} questions against every rule above. For each
one, check specifically for:
- Accuracy: does anything look invented, or is the correct answer actually debatable?
- Leading/leak: could someone with zero knowledge of the subject land on the correct option
  just by parsing the sentence (technical definition that only fits one option, answer's
  words appearing in the question, a process of elimination baked into the hook)?
- Editorializing: any judgment-carrying words in the question, options, or explanation?
- Category fit: does a "Geography" question drift into founding/conquest/political history,
  or a "History" question ignore the anti-Western-centric-bias instruction?
- Difficulty fit: does "accessible" actually land on a famous, guessable answer; does
  "challenging" actually require real specific knowledge (not just an obscure hook wrapped
  around a famous answer, and not just a famous subject with a trivial detail)?
- Answer options: four meaningfully distinct options, no numeric-only variation set, no
  absurd/joke options?
- Explanation: stays on the same subject as the question, one layer deeper, no new
  unrelated fact bolted on?

${questionBlock}

Return ONLY a JSON array of exactly ${questions.length} verdict objects, same order as above,
each shaped like: {"index": 1, "pass": true, "issues": [], "notes": ""}. "issues" is a list of
short strings, each naming one specific rule violated (empty array if none). "notes" is one
sentence of anything else worth a human's attention, or "" if nothing. No markdown, no
preamble — output ONLY the JSON array.`;
}

async function callJudge(prompt, model, apiKey) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const raw = data.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set. Export it or run with ANTHROPIC_API_KEY=sk-... node scripts/eval-questions.js');
    process.exit(1);
  }

  const date = args.date || todayUTC();
  let batch;
  if (args.file) {
    const fs = await import('fs');
    batch = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  } else {
    console.log(`Fetching ${args.site}:questions:${date} from production KV...`);
    batch = fetchBatchFromKV(date, args.site);
  }

  const questions = batch.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    console.error('No questions found in batch payload.');
    process.exit(1);
  }

  console.log(`Judging ${questions.length} questions with ${args.model}...`);
  const prompt = buildJudgePrompt(questions);
  const verdicts = await callJudge(prompt, args.model, apiKey);

  let failCount = 0;
  for (const v of verdicts) {
    const q = questions[v.index - 1];
    if (v.pass) {
      console.log(`\n✅ Q${v.index}: PASS${v.notes ? ` — ${v.notes}` : ''}`);
    } else {
      failCount++;
      console.log(`\n❌ Q${v.index}: FAIL — ${q?.question?.slice(0, 80)}...`);
      for (const issue of v.issues) console.log(`   - ${issue}`);
      if (v.notes) console.log(`   note: ${v.notes}`);
    }
  }

  console.log(`\n${verdicts.length - failCount}/${verdicts.length} passed.`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('eval-questions failed:', err);
  process.exit(1);
});

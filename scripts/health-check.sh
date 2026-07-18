#!/usr/bin/env bash
# Carta health check — run this, then hand the output to Claude for a summary.
set -uo pipefail
cd "$(dirname "$0")/.."

TODAY=$(date -u +%Y-%m-%d)
KV_NAMESPACE_ID="e3cfeee425ca4e2b94c72028d1353ceb"
REPO="okapiagames/carta"

echo "=== Carta Health Check — $(date -u +"%Y-%m-%d %H:%M UTC") ==="

echo
echo "--- Live site checks ---"
for site in carta.okapiagames.com cartain.okapiagames.com; do
  for path in "/" "/og.png" "/api/leaderboard?date=$TODAY"; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "https://$site$path")
    echo "GET https://$site$path -> HTTP $code"
  done
done

echo
echo "--- Latest Cloudflare deployment ---"
npx wrangler deployments list 2>/dev/null | tail -8

echo
echo "--- Latest local git commit ---"
git log -1 --format="%h  %ad  %s" --date=iso 2>/dev/null

echo
echo "--- Latest GitHub Actions deploy run ---"
curl -s "https://api.github.com/repos/$REPO/actions/runs?per_page=1" | python3 -c "
import json, sys
d = json.load(sys.stdin)
r = d['workflow_runs'][0]
print(f\"{r['head_sha'][:7]}  {r['status']}/{r.get('conclusion')}  {r['created_at']}  {r['html_url']}\")
" 2>/dev/null

echo
echo "--- R2 postcard bucket (carta-postcards) ---"
npx wrangler r2 bucket info carta-postcards 2>/dev/null | grep -E "object_count|bucket_size"

echo
echo "--- Today's usage ($TODAY) ---"
echo "Note: player_count only increments on /api/questions cache misses (5min edge"
echo "cache), so it's a lower-bound proxy for traffic, not a true visitor count."
echo "Cloudflare Web Analytics dashboard has the real pageview/visitor numbers."
GLOBAL_COUNT=$(npx wrangler kv key get "player_count:$TODAY" --namespace-id="$KV_NAMESPACE_ID" --remote 2>/dev/null)
IN_COUNT=$(npx wrangler kv key get "in:player_count:$TODAY" --namespace-id="$KV_NAMESPACE_ID" --remote 2>/dev/null)
echo "global player_count:$TODAY = ${GLOBAL_COUNT:-0} / 50000"
echo "in     player_count:$TODAY = ${IN_COUNT:-0} / 50000"

GLOBAL_SCORES=$(npx wrangler kv key get "scores:$TODAY" --namespace-id="$KV_NAMESPACE_ID" --remote 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
IN_SCORES=$(npx wrangler kv key get "in:scores:$TODAY" --namespace-id="$KV_NAMESPACE_ID" --remote 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "global leaderboard posts today = ${GLOBAL_SCORES:-0}"
echo "in     leaderboard posts today = ${IN_SCORES:-0}"

GLOBAL_IG=$(npx wrangler kv key get "instagram_clicks:$TODAY" --namespace-id="$KV_NAMESPACE_ID" --remote 2>/dev/null)
IN_IG=$(npx wrangler kv key get "in:instagram_clicks:$TODAY" --namespace-id="$KV_NAMESPACE_ID" --remote 2>/dev/null)
echo "global Instagram follow-link clicks today = ${GLOBAL_IG:-0}"
echo "in     Instagram follow-link clicks today = ${IN_IG:-0}"

echo
echo "--- Cloudflare secrets configured (names only) ---"
npx wrangler secret list 2>/dev/null | python3 -c "
import json, sys
for s in json.load(sys.stdin):
    print(s['name'])
" 2>/dev/null

echo
echo "=== End of health check ==="

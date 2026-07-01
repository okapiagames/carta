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
for path in "/" "/og.png" "/api/leaderboard?date=$TODAY"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://carta.okapiagames.com$path")
  echo "GET $path -> HTTP $code"
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
echo "--- Today's circuit-breaker usage ($TODAY) ---"
COUNT=$(npx wrangler kv key get "player_count:$TODAY" --namespace-id="$KV_NAMESPACE_ID" --remote 2>/dev/null)
echo "player_count:$TODAY = ${COUNT:-0} / 50000"

echo
echo "--- Cloudflare secrets configured (names only) ---"
npx wrangler secret list 2>/dev/null | python3 -c "
import json, sys
for s in json.load(sys.stdin):
    print(s['name'])
" 2>/dev/null

echo
echo "=== End of health check ==="

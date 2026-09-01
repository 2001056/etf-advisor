#!/bin/bash
# ⑤ 종목 정리 검토 트리거 — launchd가 매월 1일 13:30에 실행한다.
# 카테고리마다 2종목 이상인 곳이 없으면 앱이 알아서 넘어간다.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

"$HOME/Projects/etf-advisor/scripts/ensure-docker.sh" || \
  echo "[trigger-consolidate] 도커 준비 실패 — 그래도 시도한다" >&2

ENV_FILE="$HOME/Projects/etf-advisor/web/.env.local"
PORT="${PORT:-3111}"
SECRET=$(grep -m1 '^CRON_SECRET=' "$ENV_FILE" | cut -d= -f2-)
[ -z "$SECRET" ] && { echo "[trigger-consolidate] CRON_SECRET 없음" >&2; exit 78; }

for attempt in 1 2 3; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 30 \
    -X POST -H "x-cron-secret: $SECRET" \
    "http://127.0.0.1:${PORT}/api/cron/consolidate" || echo "000")
  echo "[trigger-consolidate] $(date '+%F %T') 시도 ${attempt}: HTTP ${CODE}"
  [ "$CODE" = "202" ] && exit 0
  [ "$attempt" -lt 3 ] && sleep 180
done
echo "[trigger-consolidate] 3회 실패 — 이번 회차 건너뜀" >&2
exit 1

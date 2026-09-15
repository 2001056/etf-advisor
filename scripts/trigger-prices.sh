#!/bin/bash
# 가격 이력 적재 + 월 충전 트리거 — launchd가 장 마감 후 매일 16:00에 실행한다.
# 보유 종목이 없으면 0행이 정상이고, 충전은 이미 들어온 달이면 아무것도 하지 않는다.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

"$HOME/Projects/etf-advisor/scripts/ensure-docker.sh" || \
  echo "[trigger-prices] 도커 준비 실패 — 그래도 시도한다" >&2

ENV_FILE="$HOME/Projects/etf-advisor/web/.env.local"
PORT="${PORT:-3111}"
SECRET=$(grep -m1 '^CRON_SECRET=' "$ENV_FILE" | cut -d= -f2-)
[ -z "$SECRET" ] && { echo "[trigger-prices] CRON_SECRET 없음" >&2; exit 78; }

for attempt in 1 2 3; do
  BODY=$(curl -s -o /dev/stdout -w '\n%{http_code}' -m 60 \
    -X POST -H "x-cron-secret: $SECRET" \
    "http://127.0.0.1:${PORT}/api/cron/prices" || echo "000")
  CODE=$(echo "$BODY" | tail -n1)
  echo "[trigger-prices] $(date '+%F %T') 시도 ${attempt}: HTTP ${CODE} $(echo "$BODY" | sed '$d')"
  [ "$CODE" = "200" ] && exit 0
  [ "$attempt" -lt 3 ] && sleep 180
done
echo "[trigger-prices] 3회 실패 — 이번 회차 건너뜀" >&2
exit 1

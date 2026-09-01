#!/bin/bash
# ④ 보유 점검 트리거 — launchd가 매일 13:00에 실행한다.
# 보유 종목이 없으면 앱이 알아서 아무것도 하지 않는다.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

"$HOME/Projects/etf-advisor/scripts/ensure-docker.sh" || \
  echo "[trigger-watch] 도커 준비 실패 — 그래도 시도한다" >&2

ENV_FILE="$HOME/Projects/etf-advisor/web/.env.local"
PORT="${PORT:-3111}"
SECRET=$(grep -m1 '^CRON_SECRET=' "$ENV_FILE" | cut -d= -f2-)
[ -z "$SECRET" ] && { echo "[trigger-watch] CRON_SECRET 없음" >&2; exit 78; }

for attempt in 1 2 3; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 30 \
    -X POST -H "x-cron-secret: $SECRET" \
    "http://127.0.0.1:${PORT}/api/cron/watch" || echo "000")
  echo "[trigger-watch] $(date '+%F %T') 시도 ${attempt}: HTTP ${CODE}"
  [ "$CODE" = "202" ] && exit 0
  [ "$attempt" -lt 3 ] && sleep 180
done
echo "[trigger-watch] 3회 실패 — 이번 회차 건너뜀" >&2
exit 1

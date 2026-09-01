#!/bin/bash
# 정기 조사 트리거 (기획서 §5.1, §10).
# launchd가 월/목 07:30에 이 스크립트를 실행한다.
# 앱이 막 부팅 중이거나 다른 에이전트가 도는 중일 수 있으므로 5분 간격 3회 재시도.
set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

ENV_FILE="$HOME/Projects/etf-advisor/web/.env.local"
PORT="${PORT:-3111}"
URL="http://127.0.0.1:${PORT}/api/cron/research"

# 조사 전에 도커·DB가 떠 있는지 확인한다 (절전에서 깨어난 직후 대비)
"$HOME/Projects/etf-advisor/scripts/ensure-docker.sh" || \
  echo "[trigger-research] 도커 준비 실패 — 그래도 시도해 본다" >&2

SECRET=$(grep -m1 '^CRON_SECRET=' "$ENV_FILE" | cut -d= -f2-)
if [ -z "$SECRET" ]; then
  echo "[trigger-research] CRON_SECRET을 찾을 수 없습니다: $ENV_FILE" >&2
  exit 78
fi

for attempt in 1 2 3; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 30 \
    -X POST -H "x-cron-secret: $SECRET" "$URL" || echo "000")

  echo "[trigger-research] $(date '+%F %T') 시도 ${attempt}: HTTP ${CODE}"

  case "$CODE" in
    202) exit 0 ;;                       # 조사 시작됨
    409) echo "[trigger-research] 다른 에이전트 실행 중 — 재시도" ;;
    000) echo "[trigger-research] 앱에 연결할 수 없음 — 재시도" ;;
    *)   echo "[trigger-research] 예상치 못한 응답 — 재시도" ;;
  esac

  [ "$attempt" -lt 3 ] && sleep 300
done

echo "[trigger-research] 3회 모두 실패 — 이번 회차를 건너뜁니다" >&2
exit 1

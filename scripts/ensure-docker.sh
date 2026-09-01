#!/bin/bash
# 도커(colima)와 DB 컨테이너가 떠 있도록 보장한다.
#
# 맥이 절전에 들어갔다 나오면 colima VM이 내려가는 일이 있고, 그러면 앱이 DB에
# 못 붙어 정기 조사가 조용히 실패한다. 이 스크립트를 launchd가 주기적으로 돌려
# 내려가 있으면 다시 올린다.
#
# 여러 번 실행해도 안전하다(이미 떠 있으면 아무것도 하지 않는다).
set -uo pipefail

# launchd는 로그인 셸 PATH를 상속하지 않는다
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

CONTAINER="etf-advisor-db"
log() { echo "[ensure-docker] $(date '+%F %T') $*"; }

# 1) 도커 데몬
if docker info >/dev/null 2>&1; then
  :
else
  log "도커 데몬이 없음 — colima 시작"
  if ! colima start 2>&1 | tail -3; then
    log "colima 시작 실패"
    exit 1
  fi
  # 데몬이 응답할 때까지 최대 90초
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 3
  done
  if ! docker info >/dev/null 2>&1; then
    log "colima를 올렸지만 도커가 응답하지 않음"
    exit 1
  fi
  log "도커 기동 완료"
fi

# 2) DB 컨테이너 (restart=always라 보통 알아서 뜨지만 확인한다)
if ! docker ps --filter "name=^${CONTAINER}$" --filter "status=running" --format '{{.Names}}' | grep -q .; then
  log "DB 컨테이너가 꺼져 있음 — 시작"
  docker start "$CONTAINER" >/dev/null 2>&1 || { log "컨테이너 시작 실패"; exit 1; }
fi

# 3) DB가 접속을 받을 때까지 (최대 60초)
for _ in $(seq 1 20); do
  docker exec "$CONTAINER" pg_isready -U etf_advisor -d etf_advisor >/dev/null 2>&1 && exit 0
  sleep 3
done

log "DB가 준비되지 않음"
exit 1

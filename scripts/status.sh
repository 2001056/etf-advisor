#!/bin/bash
# 시스템 상태 한눈에 보기 — 뭔가 이상할 때 이것부터 실행.
# ipconfig는 /usr/sbin에 있다 — 빼먹으면 LAN 주소를 못 찾는다
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
PORT="${PORT:-3111}"

echo "=== 도커 DB ==="
if docker ps --filter name=etf-advisor-db --format '{{.Names}}\t{{.Status}}' 2>/dev/null | grep -q etf-advisor-db; then
  docker ps --filter name=etf-advisor-db --format '  {{.Names}}  {{.Status}}'
else
  echo "  DB가 떠 있지 않습니다 → colima start && docker start etf-advisor-db"
fi

echo "=== 앱 ==="
CODE=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${PORT}/login" || echo "000")
if [ "$CODE" = "000" ]; then
  echo "  응답 없음 → launchctl kickstart -k gui/$UID/com.etf-advisor.web"
else
  # 기본 경로가 나가는 인터페이스를 먼저 물어보고, 안 되면 흔한 이름들을 훑는다
  IFACE=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
  IP=$(ipconfig getifaddr "${IFACE:-en0}" 2>/dev/null)
  if [ -z "$IP" ]; then
    for I in en0 en1 en2; do
      IP=$(ipconfig getifaddr "$I" 2>/dev/null) && [ -n "$IP" ] && break
    done
  fi
  echo "  정상 (HTTP $CODE)  http://${IP:-localhost}:${PORT}"
fi

echo "=== launchd ==="
launchctl list | grep etf-advisor | awk '{printf "  %-32s PID=%s exit=%s\n", $3, $1, $2}'

echo "=== codex 로그인 ==="
"$HOME/Projects/etf-advisor/scripts/run-agent.sh" codex login status 2>&1 | head -2 | sed 's/^/  /'

echo "=== 최근 실행 ==="
docker exec etf-advisor-db psql -U etf_advisor -d etf_advisor -tAc \
  "select '  ' || id || '  ' || agent || '  ' || status || '  ' || coalesce(to_char(started_at at time zone 'Asia/Seoul','MM-DD HH24:MI'),'') from agent_runs order by id desc limit 5;" 2>/dev/null \
  || echo "  (DB 조회 실패)"

echo "=== 잔액 ==="
docker exec etf-advisor-db psql -U etf_advisor -d etf_advisor -tAc \
  "select '  ' || category || '  ' || to_char(sum(amount_krw),'FM999,999,999') || '원' from ledger group by category;" 2>/dev/null \
  || echo "  (DB 조회 실패)"

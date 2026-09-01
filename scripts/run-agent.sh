#!/bin/bash
# launchd용 실행 래퍼 (기획서 §10).
# launchd는 로그인 셸 PATH를 상속하지 않고, codex/node의 실제 경로에는 node 버전이
# 박혀 있어(fnm) plist에 절대 경로를 pin하면 버전 업그레이드 때 조용히 죽는다.
# 그래서 plist는 이 스크립트만 가리키고, 경로 해석은 여기서 한다.
set -euo pipefail

FNM_DEFAULT_BIN="$HOME/.local/share/fnm/aliases/default/bin"
export PATH="$FNM_DEFAULT_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

if ! command -v codex >/dev/null 2>&1; then
  echo "[run-agent] codex를 찾을 수 없음 — fnm으로 node를 올렸다면 codex 재설치 필요: npm i -g @openai/codex" >&2
  exit 78 # EX_CONFIG
fi

exec "$@"

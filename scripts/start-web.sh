#!/bin/bash
# 앱 상주 실행 (기획서 §10 — KeepAlive LaunchAgent가 이 스크립트를 띄운다).
# launchd는 로그인 셸 PATH를 상속하지 않으므로 여기서 경로를 잡는다.
set -euo pipefail

FNM_DEFAULT_BIN="$HOME/.local/share/fnm/aliases/default/bin"
export PATH="$FNM_DEFAULT_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

APP_DIR="$HOME/Projects/etf-advisor/web"
cd "$APP_DIR"

# 0.0.0.0 바인딩 — 같은 와이파이의 폰에서 접속하기 위함 (기획서 §9)
export HOSTNAME=0.0.0.0
export PORT="${PORT:-3111}"

exec npm run start -- --hostname 0.0.0.0 --port "$PORT"

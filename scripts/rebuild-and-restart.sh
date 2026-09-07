#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
UNIT_FILE="${PROJECT_ROOT}/deploy/replay-18768.service"
SERVICE="replay-18768.service"
BASE_URL="http://127.0.0.1:18768"

cd "${PROJECT_ROOT}"
npm ci
npm run lint
VITE_REPLAY_BACKEND_MODE=standalone ./node_modules/.bin/vite build

systemd-analyze --user verify "${UNIT_FILE}" "${PROJECT_ROOT}/deploy/replay-backend-18769.service"
USER_UNIT="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/${SERVICE}"
if [[ ! -e "${USER_UNIT}" ]]; then
  systemctl --user link "${UNIT_FILE}" >/dev/null
fi
systemctl --user daemon-reload
systemctl --user enable replay-backend-18769.service "${SERVICE}" >/dev/null
# Codex analysis workers need the same outbound network path as the deploy
# session. Import only named variables; their values never enter the unit file.
export REPLAY_EVALUATOR_SOURCE_ROOT="${REPLAY_EVALUATOR_SOURCE_ROOT:-/home/binqiu/OSWorld-V2}"
systemctl --user import-environment HTTP_PROXY HTTPS_PROXY NO_PROXY CODEX_HOME REPLAY_EVALUATOR_SOURCE_ROOT
systemctl --user restart replay-backend-18769.service "${SERVICE}"

for _ in $(seq 1 30); do
  if systemctl --user is-active --quiet "${SERVICE}" \
    && curl --fail --silent --max-time 5 "${BASE_URL}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

systemctl --user is-active --quiet "${SERVICE}"
curl --fail --silent --show-error --max-time 10 "${BASE_URL}/" >/dev/null
curl --fail --silent --show-error --max-time 15 "${BASE_URL}/api/health" >/dev/null

printf 'Replay deployed at %s\n' "${BASE_URL}/live"

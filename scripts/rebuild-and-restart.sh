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
systemctl --user link --force "${UNIT_FILE}" >/dev/null
systemctl --user daemon-reload
systemctl --user enable replay-backend-18769.service "${SERVICE}" >/dev/null
systemctl --user restart "${SERVICE}"

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

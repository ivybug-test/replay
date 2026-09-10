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
# One build mode: the frontend always consumes backend-normalized ATIF.
./node_modules/.bin/vite build

systemd-analyze --user verify "${UNIT_FILE}" "${PROJECT_ROOT}/deploy/replay-backend-18769.service"
# Install both units on every deploy instead of linking only when absent, so a
# unit change in the repository reaches the host. Remove the destination first:
# install(1) would otherwise write through a symlink left by an older setup.
USER_UNIT_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
mkdir -p "${USER_UNIT_DIR}"
for unit in "${SERVICE}" replay-backend-18769.service; do
  rm -f "${USER_UNIT_DIR}/${unit}"
  install -m 0644 "${PROJECT_ROOT}/deploy/${unit}" "${USER_UNIT_DIR}/${unit}"
done
systemctl --user daemon-reload
systemctl --user enable replay-backend-18769.service "${SERVICE}" >/dev/null
# Codex analysis workers need the same outbound network path as the deploy
# session. Import only named variables; their values never enter the unit file.
# The evaluator checkout defaults to ~/OSWorld-V2, overridable from the caller.
export REPLAY_EVALUATOR_SOURCE_ROOT="${REPLAY_EVALUATOR_SOURCE_ROOT:-${HOME}/OSWorld-V2}"
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

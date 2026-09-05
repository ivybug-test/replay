#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
cd "${PROJECT_ROOT}"
if [[ "$(git branch --show-current)" != "codex/oss-backend-migration" ]]; then
  echo 'Deploy from codex/oss-backend-migration.' >&2
  exit 1
fi
if [[ ! -r /home/binqiu/.config/replay-migration/oss.environment ]]; then
  echo 'Configure the private OSS-only EnvironmentFile documented in deploy/README-migration.md.' >&2
  exit 1
fi
npm run lint
VITE_REPLAY_BACKEND_MODE=standalone ./node_modules/.bin/vite build --outDir dist-migration
backend/.venv/bin/python -m unittest discover -s backend/tests -q
systemd-analyze --user verify deploy/replay-backend-18769.service deploy/replay-migration-18770.service
install -m 0644 deploy/replay-backend-18769.service deploy/replay-migration-18770.service /home/binqiu/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable replay-backend-18769.service replay-migration-18770.service
systemctl --user restart replay-backend-18769.service replay-migration-18770.service
for _ in $(seq 1 30); do
  if curl --noproxy '*' --fail --silent --max-time 2 http://127.0.0.1:18770/api/health >/dev/null; then
    break
  fi
  sleep 0.5
done
curl --noproxy '*' --fail --silent --show-error --max-time 10 http://127.0.0.1:18770/api/health
printf '\nMigration test: http://47.120.53.174:18770/tasks/osworld-v2-003\n'

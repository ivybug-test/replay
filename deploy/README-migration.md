# Standalone backend migration test

Branch: `codex/oss-backend-migration`.
Worktree: `/home/binqiu/replay-backend-migration`.
Original worktree: `/home/binqiu/replay`, branch `codex/replay-bootstrap`.

- Public frontend: http://47.120.53.174:18770/
- Task history: http://47.120.53.174:18770/tasks/osworld-v2-003
- Batch browser: http://47.120.53.174:18770/live
- Backend: `127.0.0.1:18769`, not publicly bound.
- Existing services on 18768/18767 continue running.

## Deployment layout

`replay-migration-18770.service` serves `dist-migration/` and forwards **every**
`/api` request, including `/api/atif-live`, to the standalone backend.
`REPLAY_BACKEND_MODE=standalone` prevents Node from importing or invoking its old
OSS reader. Only the Python backend receives OSS credentials.

`VITE_REPLAY_BACKEND_MODE=standalone` enables OSS execution history on OSWorld task
pages and consumes backend-normalized ATIF without the legacy Agent Work fallback.
Other task catalogs keep their existing local execution lists. Model/status
filters and pagination query `/api/task-runs`; execution links open `/live/runs/.../tasks/...`.
Syncing/incomplete history is shown explicitly and the first page refreshes every
15 seconds. Expanded pages remain stable until manual refresh.

The migration build is separate from `dist/`, so rebuilding the test frontend
does not replace assets being served by the existing instance. The old Node mode
remains the default for the existing service; both service unit names and its
port settings are unchanged. Test services use the independent migration worktree, with their own dependencies,
build output and index. Switching branches or editing the original worktree does
not change their code.

The backend uses `backend/var/migration.sqlite3`, its own rebuildable index, and
scans every 120 seconds after completion. The first scan takes about 30–40 seconds
on the tested dataset. Backend memory high/max are 1.5/2 GiB; frontend 384/512 MiB.
The existing host memory guard includes both test services through
`~/.config/systemd/user/replay-memory-guard.service.d/migration.conf`.

## Credentials and network

`~/.config/replay-migration/oss.environment` is mode 0600 and contains only the
six `OSS_*` configuration values (access key ID/secret, bucket, endpoint, region,
prefix). It was created from the existing authorized OSS configuration without
copying model, VM-management or other credentials. Never commit this file.

The server's existing security group `sg-f8z7ok8v8qng50z9yk8g` has one added
inbound rule: TCP `18770/18770`, source `0.0.0.0/0`, description
`Replay standalone backend migration test - public frontend 18770`.
No backend port or other inbound rules were opened or changed.

## Rebuild and inspect

```bash
./scripts/deploy-migration.sh
systemctl --user status replay-backend-18769.service replay-migration-18770.service
journalctl --user -u replay-backend-18769.service -u replay-migration-18770.service -n 50
curl --noproxy '*' http://127.0.0.1:18770/api/health
```

The script operates only on the two test units and `dist-migration/`; it does not
invoke the existing production rebuild script. Dependencies must already be
installed (`npm ci`, backend requirements). The security-group rule and memory
guard drop-in are one-time setup, not rewritten by this script.

Long native streams are fetched in bounded pages, with fast catch-up while
`has_more` is true (including terminal executions). Window queries fold historical
upserts into the latest step state instead of retaining every patch. Identical
historical chunk overlaps are recovered; conflicting records still fail.

## Validation

```bash
backend/.venv/bin/python -m unittest discover -s backend/tests -q
npm test
REPLAY_TEST_URL=http://127.0.0.1:18770 node tests/migration.browser.mjs
```

The browser test reads real task history, exercises pagination and filtering,
and opens native complete, legacy normalized, and native live trajectories with
actual images. It verifies incremental polling, no Agent Work fallback requests,
and no API 5xx/browser exceptions. Nothing is uploaded to OSS.

## Stop the migration test

```bash
systemctl --user disable --now replay-migration-18770.service replay-backend-18769.service
rm ~/.config/systemd/user/replay-memory-guard.service.d/migration.conf
systemctl --user daemon-reload
```

Remove only the added TCP 18770 security-group rule when retiring the test.
Existing frontend/backend services remain available. `dist-migration/` and the
migration SQLite index may be removed after the test services have stopped.

Verified on 2026-09-04: 55 backend tests, 21 Node tests, TypeScript check and
migration build passed. The real Playwright test passed against the public
`47.120.53.174:18770` URL, including 61 task-003 executions, filters, native/legacy/live
replay, actual images and incremental refresh. No `/api/agent-work` request,
API 5xx or browser exception occurred in the successful run. Original service
PIDs remained unchanged throughout the migration deployment.

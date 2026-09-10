# Host memory guard

The user systemd timer samples `/proc/meminfo` every approximately 5 seconds
(`AccuracySec=1s`). Usage is `100 * (MemTotal - MemAvailable) / MemTotal`.

- At 80% or higher, stop the units in `REPLAY_GUARD_UNITS` — by default
  `replay-18768.service` and `oss-replay-18767.service`. This host adds
  `replay-backend-18769.service` through the drop-in below, so the frontend, the
  legacy service and the Replay backend are all shed together.
- Keep services stopped until usage stays below 75% for 60 seconds of samples.
- At 85% or higher, also emit a critical journal message on threshold crossing.
- Restore only services observed running when the guard stopped them. Services
  manually started while blocked are stopped again on the next check.
- A missing sample interval over 15 seconds or a reboot resets the recovery timer.
- Stop requests are asynchronous; existing service stop timeouts still apply.

This is pressure shedding, not a hard memory limit. Other processes, rapid
allocation between samples, and shutdown latency can still push host usage above
85%. There are no per-service memory caps added by this guard.

## Install

Run from the repository root as the user who owns the two services:

```sh
install -m 0755 deploy/replay-memory-guard.py ~/.local/bin/replay-memory-guard.py
install -m 0644 deploy/replay-memory-guard.service deploy/replay-memory-guard.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now replay-memory-guard.timer
```

## Inspect / disable

```sh
python3 ~/.local/bin/replay-memory-guard.py --status
systemctl --user list-timers replay-memory-guard.timer
journalctl --user -t replay-memory-guard --since today
systemctl --user disable --now replay-memory-guard.timer
```

Disabling the timer does not restart stopped services. To release an existing
pressure latch manually, stop the timer, check available memory, explicitly start
the desired services, and remove `~/.config/replay-memory-guard/state.json`
before re-enabling the timer. The installed unit explicitly sets
`REPLAY_GUARD_STATE_DIR` to this directory. This host's `~/.local/state` is owned
by root and inaccessible to the service user, so the guard uses its own directory
under the user's configuration directory.

The OSS functionality has since migrated to the Replay backend, so retiring the
old service is now an operational step rather than a prerequisite. This host
already extends the guard to the backend through the drop-in, and the old service
is still running alongside it:

```ini
[Service]
Environment="REPLAY_GUARD_UNITS=replay-18768.service oss-replay-18767.service replay-backend-18769.service"
```

To retire the old service, stop and disable `oss-replay-18767.service`, then drop
it from `REPLAY_GUARD_UNITS` and run `systemctl --user daemon-reload`.

Validation: `python3 -m unittest discover -s deploy -p test_memory_guard.py`.

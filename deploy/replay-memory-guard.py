#!/usr/bin/python3
"""Stop observation services under host memory pressure; recover with hysteresis."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

UNITS = tuple(os.environ.get(
    "REPLAY_GUARD_UNITS", "replay-18768.service oss-replay-18767.service"
).split())


def memory_usage(text):
    values = {line.split(':')[0]: int(line.split()[1])
              for line in text.splitlines() if line.startswith(('MemTotal:', 'MemAvailable:'))}
    total, available = values['MemTotal'], values['MemAvailable']
    if not 0 <= available <= total or total <= 0:
        raise ValueError('Invalid MemTotal/MemAvailable')
    return 100 * (total - available) / total


def decide(previous, used, now, boot, statuses):
    """Return next state and an optional (systemctl verb, units) action."""
    state = dict(previous)
    if state.get('boot') != boot or now - state.get('last_check', now) > 15:
        state['low_since'] = None
    state.update(boot=boot, last_check=now, used_percent=round(used, 3))
    state['resume'] = [u for u in state.get('resume', [])
                       if u in UNITS and statuses.get(u) != 'not-found']
    if used >= 80:
        state['blocked'] = True
    if not state.get('blocked'):
        return state, None

    # Re-stop services manually started while the pressure latch is active.
    running = [u for u in UNITS if statuses.get(u) in
               ('active', 'activating', 'reloading', 'deactivating')]
    if running:
        state['resume'] = sorted(set(state['resume']) | set(running))
        state['low_since'] = None
        return state, ('stop', running)
    if used >= 75:
        state['low_since'] = None
    elif state.get('low_since') is None:
        state['low_since'] = now
    elif now - state['low_since'] >= 60:
        resume = state['resume']
        state.update(blocked=False, low_since=None, resume=[])
        return state, ('start', resume) if resume else None
    return state, None


def run_systemctl(*args):
    return subprocess.run(['systemctl', '--user', *args], check=True,
                          capture_output=True, text=True, timeout=10).stdout


def unit_status(unit):
    output = run_systemctl('show', unit, '-p', 'LoadState', '-p', 'ActiveState')
    fields = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
    return 'not-found' if fields['LoadState'] == 'not-found' else fields['ActiveState']


def save_state(path, state):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(state) + '\n')
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--status', action='store_true', help='Read only; never start or stop services')
    args = parser.parse_args()
    directory = Path(os.environ.get('REPLAY_GUARD_STATE_DIR', str(
        Path(os.environ.get('XDG_CONFIG_HOME', str(Path.home() / '.config')))
        / 'replay-memory-guard')))
    path = directory / 'state.json'
    previous = json.loads(path.read_text()) if path.exists() else {}
    used = memory_usage(Path('/proc/meminfo').read_text())
    statuses = {unit: unit_status(unit) for unit in UNITS}
    if args.status:
        print(json.dumps({'used_percent': round(used, 2), 'services': statuses,
                          'guard_state': previous}, indent=2))
        return
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    state, action = decide(previous, used, time.monotonic(), boot, statuses)
    critical = used >= 85
    state['critical'] = critical
    if critical and not previous.get('critical'):
        print(f'<2>Host memory usage {used:.1f}% >= 85%; observation services must remain stopped.', flush=True)
    if state.get('blocked') and not previous.get('blocked'):
        print(f'<4>Memory guard triggered at {used:.1f}% (threshold 80%).', flush=True)
    if action:
        verb, units = action
        # Persist ownership before stopping; only clear it after a successful start request.
        if verb == 'stop':
            save_state(path, state)
        run_systemctl('--no-block', verb, *units)
        print(f'<5>Memory guard {verb}: {", ".join(units)}; host usage {used:.1f}%.', flush=True)
    save_state(path, state)


if __name__ == '__main__':
    main()

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('replay-memory-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
A, B = guard.UNITS


class GuardTests(unittest.TestCase):
    def step(self, state, used, now, active=(), boot='boot-1'):
        return guard.decide(state, used, now, boot,
                            {u: 'active' if u in active else 'inactive' for u in guard.UNITS})

    def test_available_memory_includes_reclaimable_cache(self):
        self.assertEqual(guard.memory_usage('MemTotal: 1000 kB\nMemFree: 1 kB\nMemAvailable: 250 kB\n'), 75)

    def test_threshold_and_only_restore_previously_running_units(self):
        state, action = self.step({}, 79.99, 0, (A,))
        self.assertIsNone(action)
        state, action = self.step(state, 80, 5, (A,))
        self.assertEqual(action, ('stop', [A]))
        self.assertEqual(state['resume'], [A])
        state, _ = self.step(state, 70, 10)
        for now in range(15, 70, 5):
            state, action = self.step(state, 70, now)
            self.assertIsNone(action)
        state, action = self.step(state, 70, 70)
        self.assertEqual(action, ('start', [A]))
        self.assertFalse(state['blocked'])

    def test_critical_pressure_and_manual_restart_stay_stopped(self):
        state, action = self.step({}, 90, 0, (A, B))
        self.assertEqual(action, ('stop', [A, B]))
        state, _ = self.step(state, 79, 5)
        state, action = self.step(state, 79, 10, (B,))
        self.assertEqual(action, ('stop', [B]))

    def test_recovery_requires_continuous_low_samples(self):
        state, _ = self.step({}, 85, 0, (A,))
        state, _ = self.step(state, 70, 5)
        state, _ = self.step(state, 75, 10)
        self.assertIsNone(state['low_since'])
        state, _ = self.step(state, 70, 15)
        self.assertEqual(state['low_since'], 15)

    def test_monitor_gap_and_reboot_reset_recovery(self):
        state, _ = self.step({}, 85, 0, (A,))
        state, _ = self.step(state, 70, 5)
        state, action = self.step(state, 70, 100)
        self.assertIsNone(action)
        self.assertEqual(state['low_since'], 100)
        state, action = self.step(state, 70, 2, boot='boot-2')
        self.assertIsNone(action)
        self.assertEqual(state['low_since'], 2)

    def test_decommissioned_service_is_not_restored(self):
        state = {'blocked': True, 'resume': [B]}
        state, action = guard.decide(state, 70, 0, 'boot', {A: 'inactive', B: 'not-found'})
        self.assertEqual(state['resume'], [])
        self.assertIsNone(action)


if __name__ == '__main__':
    unittest.main()

"""Evaluator source is loaded read-only, bounded and without executing code."""

import tempfile
from pathlib import Path
import unittest

from backend.evaluator_source import evaluator_source_summary, load_evaluator_source


class EvaluatorSourceTests(unittest.TestCase):
    def test_task_source_and_referenced_metric_are_extracted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task = root / 'evaluation_examples/task_class/task_123.py'
            metric = root / 'desktop_env/evaluators/metrics/basic.py'
            task.parent.mkdir(parents=True)
            metric.parent.mkdir(parents=True)
            task.write_text(
                'from desktop_env.evaluators import metrics\n'
                'def evaluate(value):\n    return metrics.check_value(value)\n',
                encoding='utf-8',
            )
            metric.write_text(
                'def unrelated():\n    return 0\n\n'
                'def check_value(value):\n    return float(value == 3)\n',
                encoding='utf-8',
            )
            bundle = load_evaluator_source(directory, '123')
            self.assertTrue(bundle['available'])
            self.assertEqual(bundle['task_source']['path'],
                             'evaluation_examples/task_class/task_123.py')
            self.assertEqual([item['symbol'] for item in bundle['dependency_snippets']],
                             ['metrics.check_value'])
            self.assertIn('0002: def evaluate', bundle['task_source']['source'])
            self.assertIn('0004: def check_value', bundle['dependency_snippets'][0]['source'])
            self.assertNotIn('unrelated', bundle['dependency_snippets'][0]['source'])
            public = evaluator_source_summary(bundle)
            self.assertEqual(public['dependency_symbols'], ['metrics.check_value'])
            self.assertNotIn('source', public)

    def test_unconfigured_and_invalid_task_ids_are_not_read(self):
        self.assertFalse(load_evaluator_source(None, '123')['available'])
        self.assertFalse(load_evaluator_source('/tmp', '../../etc/passwd')['available'])


if __name__ == '__main__':
    unittest.main()

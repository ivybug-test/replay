import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "import_osworld_difficulty", Path(__file__).resolve().parents[1] / "scripts/import_osworld_difficulty.py"
)
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class DifficultyTests(unittest.TestCase):
    def test_uses_explicit_labels_not_heading_scores_or_navigation(self):
        html = b'''<a href="#tasks-001.fake">001. Score 1.0</a>
        <h2 id="tasks-001.example">001. <span class="diff medium"></span>Score 1.0</h2>
        <h2 id="tasks-048.example">048. <span class="diff hard"></span>Score -</h2>
        <h2 id="other"><span class="diff easy"></span></h2>'''
        result = importer.snapshot(html, 'https://example.test/osworld')
        self.assertEqual(set(result['tasks']), {'001', '048'})
        self.assertEqual(result['tasks']['001']['difficulty'], 'medium')
        self.assertEqual(result['tasks']['048']['difficulty'], 'hard')
        self.assertEqual(result['tasks']['001']['source_url'], 'https://example.test/osworld#tasks-001.example')

    def test_missing_duplicate_or_ambiguous_labels_fail(self):
        with self.assertRaisesRegex(ValueError, 'No explicit'):
            importer.snapshot(b'<h2>No tasks here</h2>', 'https://example.test')
        heading = b'<h2 id="tasks-001.example"><span class="diff easy"></span></h2>'
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            importer.snapshot(heading + heading, 'https://example.test')
        with self.assertRaisesRegex(ValueError, 'Invalid difficulty'):
            importer.snapshot(heading.replace(b'diff easy', b'diff easy hard'), 'https://example.test')


if __name__ == '__main__':
    unittest.main()

"""Check the task import contract without running OSWorld task modules."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "import_osworld", Path(__file__).resolve().parents[1] / "scripts/import_osworld.py"
)
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.examples = self.root / "evaluation_examples"
        (self.examples / "task_class").mkdir(parents=True)
        self.manifest = self.examples / "test_v2.json"
        self.manifest.write_text('{"tasks": ["001"]}')
        for capability in importer.CAPABILITY_FILES:
            members = ["001", "082"] if capability in ("cross_source_reasoning", "implicit_state_inference") else []
            (self.examples / f"{capability}.json").write_text(json.dumps({capability: members}))
        self.task = self.examples / "task_class/task_001.py"
        self.task.write_text('''
raise RuntimeError("Task code must never execute")
TASK_ID = "001"
FILE = "/home/user/Desktop/report.txt"
SESSION = uuid.uuid4().hex
class Example(BaseTask):
    id = TASK_ID
    snapshot = "chrome"
    related_apps: list[str] = ["chrome", "writer"]
    source = "https://example.org/reference"
    base_instruction = f"  Open {FILE} at https://app.{HOST_SUFFIX}, session {SESSION}.  "
    instruction = base_instruction.strip() + " Save the result."
    def setup(self, environment):
        raise RuntimeError("Do not execute setup")
    def evaluate(self, environment):
        return "PRIVATE_REFERENCE"
''')

    def test_extracts_complete_template_without_executing_task(self):
        bundle = importer.build_dataset(self.root)
        task = bundle["tasks"][0]
        self.assertEqual(task["id"], "osworld-v2-001")
        self.assertEqual(task["category"], "Capability tasks")
        self.assertEqual(task["metadata"]["snapshot"], "chrome")
        self.assertEqual(task["metadata"]["capabilities"], ["cross_source_reasoning", "implicit_state_inference"])
        self.assertEqual(task["difficulty"], "easy")
        self.assertIn('osworld-2.html#tasks-001', task["metadata"]["difficulty_source"])
        self.assertEqual(task["instruction"],
                         "Open /home/user/Desktop/report.txt at https://app.{{HOST_SUFFIX}}, "
                         "session {{SESSION}}. Save the result.")
        self.assertEqual(task["files"][0]["content"], task["instruction"])
        self.assertEqual(task["metadata"]["related_apps"], ["chrome", "writer"])
        self.assertEqual(set(task["metadata"]["template_variables"]), {"HOST_SUFFIX", "SESSION"})
        self.assertEqual(bundle["runs"], [])
        self.assertNotIn("PRIVATE_REFERENCE", json.dumps(bundle))

    def test_manifest_excludes_unlisted_files_and_is_repeatable(self):
        (self.examples / "task_class/task_999.py").write_text("not valid python!")
        first = importer.build_dataset(self.root)
        self.assertEqual(len(first["tasks"]), 1)
        self.assertEqual(first, importer.build_dataset(self.root))

    def test_duplicate_missing_and_mismatched_ids_fail(self):
        self.manifest.write_text('{"tasks": ["001", "001"]}')
        with self.assertRaisesRegex(ValueError, "duplicate"):
            importer.build_dataset(self.root)
        self.manifest.write_text('{"tasks": ["002"]}')
        (self.examples / 'cross_source_reasoning.json').write_text('{"cross_source_reasoning": ["001", "002"]}')
        with self.assertRaises(FileNotFoundError):
            importer.build_dataset(self.root)
        self.manifest.write_text('{"tasks": ["001"]}')
        self.task.write_text(self.task.read_text().replace('TASK_ID = "001"', 'TASK_ID = "002"'))
        with self.assertRaisesRegex(ValueError, "does not match"):
            importer.build_dataset(self.root)

    def test_unextractable_instruction_is_an_error(self):
        source = self.task.read_text().replace(
            'instruction = base_instruction.strip() + " Save the result."',
            'instruction = load_instruction_from_network()',
        )
        self.task.write_text(source)
        with self.assertRaisesRegex(ValueError, "could not extract instruction"):
            importer.build_dataset(self.root)

    def test_cyclic_references_are_an_error(self):
        self.task.write_text(self.task.read_text().replace('TASK_ID = "001"', 'TASK_ID = OTHER\nOTHER = TASK_ID'))
        with self.assertRaisesRegex(ValueError, "Cyclic constant"):
            importer.build_dataset(self.root)

    def test_capabilities_preserve_multiple_labels_and_ignore_outside_manifest(self):
        tasks = importer.build_dataset(self.root)["tasks"]
        self.assertEqual([task["metadata"]["osworld_task_id"] for task in tasks], ["001"])
        self.assertEqual(tasks[0]["metadata"]["capabilities"], ["cross_source_reasoning", "implicit_state_inference"])
        for capability in importer.CAPABILITY_FILES:
            (self.examples / f"{capability}.json").write_text(json.dumps({capability: []}))
        with self.assertRaisesRegex(ValueError, "missing OSWorld capability"):
            importer.build_dataset(self.root)

    def test_missing_or_duplicate_category_files_fail(self):
        path = self.examples / 'cross_source_reasoning.json'
        path.write_text('{"cross_source_reasoning": ["001", "001"]}')
        with self.assertRaisesRegex(ValueError, "duplicate"):
            importer.build_dataset(self.root)
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            importer.build_dataset(self.root)

    def test_missing_difficulty_is_an_error(self):
        path = self.root / 'difficulty.json'
        path.write_text('{"tasks": {}}')
        with self.assertRaisesRegex(ValueError, "missing or invalid knowledge-base difficulty"):
            importer.build_dataset(self.root, path)


if __name__ == "__main__":
    unittest.main()

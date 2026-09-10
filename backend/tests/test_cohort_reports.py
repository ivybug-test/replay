"""Cohort reports remain schema-isolated and immutable by revision."""

import tempfile
import unittest
from pathlib import Path

from backend.cohort_reports import CohortReportStore


def document(revision=1, sample="sample-001"):
    return {
        "schema_version": "todolist-quality-cohort-report/v1",
        "analysis_type": "todolist-quality",
        "run_id": "run-1",
        "revision": revision,
        "created_at": "2026-09-07T13:39:05Z",
        "samples": [{"blind_id": sample}],
        "group_summary": {"group": {"any_severe": "1/1"}},
    }


def task_document(revision=2):
    return {
        "schema_version": "todolist-quality-task-report/v2",
        "analysis_type": "todolist-quality",
        "run_id": "run-1",
        "revision": revision,
        "created_at": "2026-09-07T14:39:05Z",
        "task_dossiers": [{"task_id": "001"}],
    }


class CohortReportStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = CohortReportStore(str(Path(self.temp.name) / "reports.sqlite3"))
        self.addCleanup(self.store.close)

    def test_create_is_idempotent_but_revision_is_immutable(self):
        first = self.store.create(document(), "# Report", "Title", "Summary")
        same = self.store.create(document(), "# Report", "Title", "Summary")
        self.assertEqual(same["report_id"], first["report_id"])
        with self.assertRaisesRegex(ValueError, "revision already exists"):
            self.store.create(document(sample="changed"), "# Changed", "Title", "Summary")
        second = self.store.create(document(2, "changed"), "# Changed", "Title", "Summary")
        self.assertNotEqual(second["report_id"], first["report_id"])
        listed = self.store.list_reports()["reports"]
        self.assertEqual([(item["revision"], item["report_id"]) for item in listed],
                         [(2, second["report_id"])])
        self.assertEqual(self.store.get(first["report_id"])["revision"], 1)

    def test_rejects_non_cohort_documents(self):
        invalid = document()
        invalid["analysis_type"] = "aft"
        with self.assertRaisesRegex(ValueError, "analysis type"):
            self.store.create(invalid, "# Report", "Title", "Summary")

    def test_accepts_detailed_task_report_v2(self):
        created = self.store.create(task_document(), "# Detailed", "Title", "Summary")
        self.assertEqual(created["revision"], 2)
        self.assertEqual(created["document"]["task_dossiers"][0]["task_id"], "001")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Import one validated immutable Cohort Report into Replay's official store."""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.cohort_reports import CohortReportStore  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=str(ROOT / "backend/var/aft.sqlite3"))
    parser.add_argument("--document", required=True)
    parser.add_argument("--markdown", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--summary", required=True)
    args = parser.parse_args()
    document = json.loads(Path(args.document).read_text())
    markdown = Path(args.markdown).read_text()
    store = CohortReportStore(args.db)
    try:
        result = store.create(document, markdown, args.title, args.summary)
    finally:
        store.close()
    print(json.dumps({key: result[key] for key in (
        "report_id", "analysis_type", "run_id", "revision", "created_at",
    )}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

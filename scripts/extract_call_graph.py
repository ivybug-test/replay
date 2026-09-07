#!/usr/bin/env python3
"""Extract a deterministic role-aware call graph from an ATIF-v1.8 file."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.aft_atif import extract_call_graph  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('trajectory', nargs='?', help='ATIF JSON file; omit to read stdin')
    args = parser.parse_args()
    if args.trajectory:
        with open(args.trajectory, encoding='utf-8') as handle:
            trajectory = json.load(handle)
    else:
        trajectory = json.load(sys.stdin)
    json.dump(extract_call_graph(trajectory), sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()

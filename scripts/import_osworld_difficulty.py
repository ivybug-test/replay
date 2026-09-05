#!/usr/bin/env python3
"""Snapshot the explicit per-task difficulty labels from the team's knowledge base."""
import argparse
import hashlib
import json
import re
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote

DEFAULT_URL = "http://47.120.53.174/osworld-2.html"
DEFAULT_OUTPUT = Path(__file__).with_name("osworld_difficulty.json")


class DifficultyParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tasks = {}
        self.current = None

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "h2":
            anchor = attrs.get("id", "")
            match = re.match(r"tasks-(\d{3})\.", anchor)
            self.current = (match[1], anchor) if match else None
        if tag == "span" and self.current:
            classes = attrs.get("class", "").split()
            if "diff" in classes:
                labels = set(classes) & {"easy", "medium", "hard"}
                if len(labels) != 1:
                    raise ValueError(f"Invalid difficulty for {self.current[0]}")
                task_id, anchor = self.current
                if task_id in self.tasks:
                    raise ValueError(f"Duplicate difficulty for {task_id}")
                self.tasks[task_id] = {"difficulty": labels.pop(), "anchor": anchor}

    def handle_endtag(self, tag):
        if tag == "h2":
            self.current = None


def snapshot(html: bytes, url: str) -> dict:
    parser = DifficultyParser()
    parser.feed(html.decode("utf-8"))
    if not parser.tasks:
        raise ValueError("No explicit per-task difficulty labels found")
    return {
        "source_url": url,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "source_sha256": hashlib.sha256(html).hexdigest(),
        "basis": "Knowledge-base per-task baseline difficulty labels (not human completion time).",
        "tasks": {task_id: {
            "difficulty": item["difficulty"],
            "source_url": url + "#" + quote(item["anchor"], safe=""),
        } for task_id, item in sorted(parser.tasks.items())},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    with urllib.request.urlopen(args.url, timeout=30) as response:
        result = snapshot(response.read(), args.url)
    temporary = args.output.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(f"Saved {len(result['tasks'])} difficulty labels to {args.output}")


if __name__ == "__main__":
    main()

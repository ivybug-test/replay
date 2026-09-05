#!/usr/bin/env python3
"""Export OSWorld V2 task descriptions without importing or executing task code."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path


FIELDS = ("id", "instruction", "snapshot", "related_apps", "source")
CAPABILITY_FILES = (
    "conflict_disambiguation", "cross_source_reasoning", "dynamic_environment",
    "human_in_the_loop", "implicit_state_inference", "multi_item_state_tracking",
    "multimodal_editing", "streaming_interaction", "tutorial_following",
    "visual_spatial_precision",
)


def assignments(body: list[ast.stmt]) -> dict[str, ast.expr]:
    result = {}
    for node in body:
        targets = node.targets if isinstance(node, ast.Assign) else (
            [node.target] if isinstance(node, ast.AnnAssign) else []
        )
        for target in targets:
            if isinstance(target, ast.Name) and node.value is not None:
                result[target.id] = node.value
    return result


class StaticValues:
    """Resolve only data expressions; runtime values remain visible placeholders."""

    def __init__(self, module: dict, local: dict):
        self.module = module
        self.local = local
        self.unresolved: dict[str, str] = {}
        self.active: set[tuple[str, bool]] = set()

    def name(self, name: str, local: bool = True):
        scope = self.local if local and name in self.local else self.module
        node = scope.get(name)
        key = (name, scope is self.local)
        if key in self.active:
            raise ValueError(f"Cyclic constant reference: {name}")
        if node is None:
            return self.placeholder(name, "External or runtime value")
        self.active.add(key)
        try:
            try:
                return self.value(node, scope is self.local)
            except ValueError as error:
                if "Cyclic constant" in str(error):
                    raise
                return self.placeholder(name, ast.unparse(node))
        finally:
            self.active.remove(key)

    def placeholder(self, name: str, expression: str):
        self.unresolved[name] = expression
        return "{{" + name + "}}"

    def value(self, node: ast.expr, local: bool = True):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return self.name(node.id, local)
        if isinstance(node, (ast.List, ast.Tuple)):
            return [self.value(item, local) for item in node.elts]
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return self.value(node.left, local) + self.value(node.right, local)
        if isinstance(node, ast.JoinedStr):
            parts = []
            for item in node.values:
                if isinstance(item, ast.Constant):
                    parts.append(item.value)
                    continue
                value = self.value(item.value, local)
                if item.conversion == ord("r"):
                    value = repr(value)
                elif item.conversion == ord("a"):
                    value = ascii(value)
                elif item.conversion == ord("s"):
                    value = str(value)
                spec = self.value(item.format_spec, local) if item.format_spec else ""
                parts.append(format(value, spec))
            return "".join(parts)
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "strip" and not node.args and not node.keywords):
            value = self.value(node.func.value, local)
            if isinstance(value, str):
                return value.strip()
        raise ValueError(f"Unsupported static expression: {ast.unparse(node)}")


def read_task(path: Path, task_id: str, capabilities: list[str], difficulty: dict) -> dict:
    raw = path.read_bytes()
    tree = ast.parse(raw, filename=str(path))
    candidates = [assignments(node.body) for node in tree.body if isinstance(node, ast.ClassDef)]
    candidates = [values for values in candidates if all(field in values for field in FIELDS)]
    if len(candidates) != 1:
        raise ValueError(f"{path.name}: expected one task class with {', '.join(FIELDS)}")
    resolver = StaticValues(assignments(tree.body), candidates[0])
    values = {field: resolver.name(field) for field in FIELDS}
    if values["id"] != task_id:
        raise ValueError(f"{path.name}: task ID does not match manifest ID {task_id}")
    instruction = values["instruction"]
    placeholders = {"{{" + name + "}}" for name in resolver.unresolved}
    if not isinstance(instruction, str) or not instruction.strip() or instruction in placeholders:
        raise ValueError(f"{path.name}: could not extract instruction")
    if not isinstance(values["snapshot"], str) or "{{" in values["snapshot"]:
        raise ValueError(f"{path.name}: invalid snapshot")
    if not isinstance(values["related_apps"], list) or not all(isinstance(a, str) for a in values["related_apps"]):
        raise ValueError(f"{path.name}: invalid related_apps")
    if not isinstance(values["source"], str):
        raise ValueError(f"{path.name}: invalid source")
    metadata = {
        "osworld_task_id": task_id,
        "snapshot": values["snapshot"],
        "related_apps": values["related_apps"],
        "original_source": values["source"],
        "definition_path": f"evaluation_examples/task_class/{path.name}",
        "definition_sha256": hashlib.sha256(raw).hexdigest(),
        "template_variables": resolver.unresolved,
        "capabilities": capabilities,
        "difficulty_source": difficulty["source_url"],
        "difficulty_basis": "knowledge_base_baseline",
    }
    summary = " ".join(instruction.split())
    summary = summary[:97].rstrip() + "…" if len(summary) > 100 else summary
    return {
        "id": f"osworld-v2-{task_id}", "vendorId": "osworld-v2",
        "title": f"{task_id} · {summary}", "source": "osworld",
        "category": "Capability tasks", "difficulty": difficulty["difficulty"],
        "instruction": instruction,
        "files": [
            {"path": "instruction.md", "kind": "markdown", "content": instruction},
            {"path": "metadata.json", "kind": "json", "content": json.dumps(metadata, ensure_ascii=False, indent=2)},
        ],
        "metadata": metadata,
    }


def build_dataset(root: Path, difficulty_file: Path | None = None) -> dict:
    manifest = root / "evaluation_examples/test_v2.json"
    task_ids = json.loads(manifest.read_text(encoding="utf-8"))["tasks"]
    if not isinstance(task_ids, list) or not task_ids:
        raise ValueError("Manifest must contain a nonempty tasks list")
    if any(not isinstance(task_id, str) or not task_id.isascii() or not task_id.isdigit() for task_id in task_ids):
        raise ValueError("Manifest task IDs must be numeric strings")
    if len(set(task_ids)) != len(task_ids):
        raise ValueError("Manifest contains duplicate task IDs")
    task_id_set = set(task_ids)
    capability_by_task = {task_id: [] for task_id in task_ids}
    for capability in CAPABILITY_FILES:
        path = root / f"evaluation_examples/{capability}.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        members = document.get(capability)
        if not isinstance(members, list) or any(not isinstance(member, str) for member in members):
            raise ValueError(f"{path.name}: expected a string list named {capability}")
        if len(set(members)) != len(members):
            raise ValueError(f"{path.name}: contains duplicate task IDs")
        for task_id in members:
            if task_id in task_id_set:
                capability_by_task[task_id].append(capability)
    missing_capabilities = [task_id for task_id, values in capability_by_task.items() if not values]
    if missing_capabilities:
        raise ValueError(f"Tasks missing OSWorld capability categories: {', '.join(missing_capabilities)}")
    difficulty_path = difficulty_file or Path(__file__).with_name("osworld_difficulty.json")
    difficulties = json.loads(difficulty_path.read_text(encoding="utf-8"))["tasks"]
    for task_id in task_ids:
        entry = difficulties.get(task_id, {})
        if entry.get("difficulty") not in {"easy", "medium", "hard"} or not entry.get("source_url"):
            raise ValueError(f"Task {task_id}: missing or invalid knowledge-base difficulty")
    tasks = [read_task(
        root / f"evaluation_examples/task_class/task_{task_id}.py",
        task_id,
        capability_by_task[task_id],
        difficulties[task_id],
    ) for task_id in task_ids]
    return {
        "vendors": [{"id": "osworld-v2", "name": "OSWorld 2.0", "coverage": (
            f"{len(tasks)} task definitions from the local OSWorld V2 test_v2.json manifest. "
            "Uses the ten official, multi-label OSWorld capability categories; execution records are not included. "
            "Difficulty follows the team's knowledge-base baseline labels. "
            "Runtime-dependent instruction values are marked with {{variable}} placeholders."
        )}],
        "agents": [], "tasks": tasks, "runs": [],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="OSWorld-V2 checkout")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "public/osworld-v2.dataset.json")
    parser.add_argument("--difficulty-file", type=Path, default=Path(__file__).with_name("osworld_difficulty.json"))
    args = parser.parse_args()
    dataset = build_dataset(args.root, args.difficulty_file)
    # One task per line keeps generated data easy to compare across imports.
    sections = [f'  "{key}": ' + ("[\n" + ",\n".join(
        "    " + json.dumps(item, ensure_ascii=False) for item in values
    ) + "\n  ]" if values else "[]") for key, values in dataset.items()]
    content = "{\n" + ",\n".join(sections) + "\n}\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(".json.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(args.output)
    templates = sum(bool(task["metadata"]["template_variables"]) for task in dataset["tasks"])
    print(f"Imported {len(dataset['tasks'])} tasks into {args.output} ({templates} with template variables)")


if __name__ == "__main__":
    main()

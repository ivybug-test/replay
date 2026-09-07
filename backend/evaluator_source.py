"""Read-only, bounded evaluator source context for post-run AFT analysis."""

from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
import re
from typing import Any


MAX_TASK_SOURCE_CHARS = 80_000
MAX_SYMBOL_SOURCE_CHARS = 40_000
_TASK_ID = re.compile(r'^[0-9]{3,4}$')


def _revision(root: Path) -> str | None:
    head = root / '.git' / 'HEAD'
    try:
        value = head.read_text(encoding='utf-8').strip()
        if value.startswith('ref: '):
            ref = root / '.git' / value[5:]
            value = ref.read_text(encoding='utf-8').strip()
        return value if re.fullmatch(r'[0-9a-fA-F]{7,64}', value) else None
    except OSError:
        return None


def _read(path: Path, limit: int) -> tuple[str, bool]:
    text = path.read_text(encoding='utf-8', errors='replace')
    return (text, False) if len(text) <= limit else (text[:limit], True)


def _numbered(source: str, start: int = 1) -> str:
    return ''.join(
        f'{number:04d}: {line}'
        for number, line in enumerate(source.splitlines(keepends=True), start)
    )


def _called_symbols(source: str) -> dict[str, set[str]]:
    output = {'metrics': set(), 'getters': set()}
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return output
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        owner = node.func.value
        if isinstance(owner, ast.Name) and owner.id in output:
            output[owner.id].add(node.func.attr)
    return output


def _symbol_snippets(root: Path, called: dict[str, set[str]]) -> list[dict[str, Any]]:
    snippets = []
    remaining = MAX_SYMBOL_SOURCE_CHARS
    for package in ('metrics', 'getters'):
        wanted = called[package]
        if not wanted:
            continue
        directory = root / 'desktop_env' / 'evaluators' / package
        for path in sorted(directory.glob('*.py')):
            if remaining <= 0 or not wanted:
                break
            source = path.read_text(encoding='utf-8', errors='replace')
            try:
                tree = ast.parse(source)
            except SyntaxError:
                continue
            lines = source.splitlines(keepends=True)
            for node in tree.body:
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) \
                        or node.name not in wanted or node.end_lineno is None:
                    continue
                text = ''.join(lines[node.lineno - 1:node.end_lineno])
                numbered = _numbered(text, node.lineno)
                clipped = numbered[:remaining]
                snippets.append({
                    'symbol': f'{package}.{node.name}',
                    'path': str(path.relative_to(root)),
                    'start_line': node.lineno, 'end_line': node.end_lineno,
                    'source': clipped, 'truncated': len(clipped) < len(numbered),
                })
                remaining -= len(clipped)
                wanted.remove(node.name)
                if remaining <= 0:
                    break
    return snippets


def load_evaluator_source(root_value: str | None, task_id: Any) -> dict[str, Any]:
    """Return source used for analysis; never executes or imports evaluator code."""
    identity = str(task_id or '').strip()
    if not root_value:
        return {'available': False, 'reason': 'evaluator source root is not configured'}
    if not _TASK_ID.fullmatch(identity):
        return {'available': False, 'reason': 'task id cannot be mapped to evaluator source'}
    root = Path(root_value).resolve()
    path = (root / 'evaluation_examples' / 'task_class' / f'task_{identity}.py').resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return {'available': False, 'reason': 'evaluator source path escapes configured root'}
    if not path.is_file():
        return {'available': False, 'reason': 'task evaluator source is unavailable'}
    try:
        source, truncated = _read(path, MAX_TASK_SOURCE_CHARS)
        snippets = _symbol_snippets(root, _called_symbols(source))
    except OSError as exc:
        return {'available': False, 'reason': f'evaluator source is unreadable: {type(exc).__name__}'}
    numbered_source = _numbered(source)
    digest_input = json.dumps({
        'task': numbered_source, 'snippets': snippets,
    }, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode()
    return {
        'available': True, 'task_id': identity, 'repository_revision': _revision(root),
        'task_source': {
            'path': str(path.relative_to(root)), 'source': numbered_source,
            'truncated': truncated,
        },
        'dependency_snippets': snippets,
        'digest': hashlib.sha256(digest_input).hexdigest(),
    }


def evaluator_source_summary(bundle: dict[str, Any]) -> dict[str, Any]:
    """Drop code bodies before persisting the public report."""
    task = bundle.get('task_source') or {}
    return {
        'available': bool(bundle.get('available')),
        'reason': bundle.get('reason'), 'task_id': bundle.get('task_id'),
        'repository_revision': bundle.get('repository_revision'),
        'digest': bundle.get('digest'), 'task_path': task.get('path'),
        'task_source_truncated': task.get('truncated'),
        'dependency_symbols': [item.get('symbol') for item in bundle.get('dependency_snippets') or []],
    }

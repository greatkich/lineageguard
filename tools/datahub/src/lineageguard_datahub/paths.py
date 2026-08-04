from __future__ import annotations

from pathlib import Path


def repository_root(start: Path | None = None) -> Path:
    candidate = (start or Path.cwd()).resolve()
    for parent in (candidate, *candidate.parents):
        if (parent / "AGENTS.md").is_file() and (parent / "walkthrough").is_dir():
            return parent
    raise RuntimeError("REPOSITORY_ROOT_NOT_FOUND")


def canonical_manifest_path(root: Path | None = None) -> Path:
    return (
        root or repository_root()
    ) / "walkthrough/scenarios/canonical/expected-datahub-graph.json"

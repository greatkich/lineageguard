from __future__ import annotations

import hashlib
import stat
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


def resolve_checked_file(
    root: Path,
    relative_path: str,
    expected_sha256: str,
    *,
    maximum_bytes: int = 1024 * 1024,
) -> Path:
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("CHECKED_PATH_INVALID")
    root = root.resolve()
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("CHECKED_PATH_SYMLINK_DENIED")
    resolved = (root / relative).resolve(strict=True)
    if not resolved.is_relative_to(root):
        raise ValueError("CHECKED_PATH_OUTSIDE_REPOSITORY")
    if not stat.S_ISREG(resolved.stat().st_mode):
        raise ValueError("CHECKED_PATH_NOT_REGULAR_FILE")
    if resolved.stat().st_size > maximum_bytes:
        raise ValueError("CHECKED_FILE_TOO_LARGE")
    if hashlib.sha256(resolved.read_bytes()).hexdigest() != expected_sha256:
        raise ValueError("CHECKED_FILE_DIGEST_MISMATCH")
    return resolved

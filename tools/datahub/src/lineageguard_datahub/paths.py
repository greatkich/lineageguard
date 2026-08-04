from __future__ import annotations

import hashlib
import os
import stat
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class CheckedBytes:
    relative_path: str
    sha256: str
    content: bytes


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
    read_checked_bytes(
        root,
        relative_path,
        expected_sha256,
        maximum_bytes=maximum_bytes,
    )
    return root.resolve() / Path(relative_path)


def read_checked_bytes(
    root: Path,
    relative_path: str,
    expected_sha256: str,
    *,
    maximum_bytes: int = 1024 * 1024,
) -> CheckedBytes:
    """Capture digest-verified bytes through no-follow descriptors.

    Callers execute or copy ``content``. They must never reopen the repository path after this
    function returns; doing so would reintroduce a check/use race.
    """
    checked = read_bounded_bytes(root, relative_path, maximum_bytes=maximum_bytes)
    if checked.sha256 != expected_sha256:
        raise ValueError("CHECKED_FILE_DIGEST_MISMATCH")
    return checked


def read_bounded_bytes(
    root: Path,
    relative_path: str,
    *,
    maximum_bytes: int = 1024 * 1024,
) -> CheckedBytes:
    relative = Path(relative_path)
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        raise ValueError("CHECKED_PATH_INVALID")
    root = root.resolve(strict=True)
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    descriptors: list[int] = []
    try:
        current = os.open(root, directory_flags | no_follow)
        descriptors.append(current)
        for part in relative.parts[:-1]:
            try:
                current = os.open(part, directory_flags | no_follow, dir_fd=current)
            except FileNotFoundError:
                raise
            except OSError as error:
                raise ValueError("CHECKED_PATH_SYMLINK_DENIED") from error
            descriptors.append(current)
            if not stat.S_ISDIR(os.fstat(current).st_mode):
                raise ValueError("CHECKED_PATH_PARENT_NOT_DIRECTORY")
        try:
            file_descriptor = os.open(
                relative.parts[-1],
                os.O_RDONLY | no_follow | getattr(os, "O_CLOEXEC", 0),
                dir_fd=current,
            )
        except FileNotFoundError:
            raise
        except OSError as error:
            raise ValueError("CHECKED_PATH_SYMLINK_DENIED") from error
        descriptors.append(file_descriptor)
        info = os.fstat(file_descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("CHECKED_PATH_NOT_REGULAR_FILE")
        if info.st_size > maximum_bytes:
            raise ValueError("CHECKED_FILE_TOO_LARGE")
        chunks: list[bytes] = []
        remaining = maximum_bytes + 1
        while remaining > 0:
            chunk = os.read(file_descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        content = b"".join(chunks)
        if len(content) > maximum_bytes:
            raise ValueError("CHECKED_FILE_TOO_LARGE")
        digest = hashlib.sha256(content).hexdigest()
        return CheckedBytes(relative.as_posix(), digest, content)
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)

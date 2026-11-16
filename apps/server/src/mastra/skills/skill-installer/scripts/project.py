"""Whole-project installation records and atomic publication."""
from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path, PurePosixPath
import re
import tempfile

from repository import SkillError, Snapshot, directory, safe_path


PROJECT_FILE = ".skill-project.json"
METADATA_DIR = ".skill-meta"
SOURCES_FILE = ".skill-sources.json"


class ArchiveProjectSnapshot(Snapshot):
    """Expose project-relative paths while reading validated original archive files."""
    def __init__(self, snapshot: Snapshot, prefix: str):
        files = [{**file, "path": file["path"][len(prefix):]} for file in snapshot.files]
        super().__init__(snapshot.source, snapshot.folder, snapshot.ref, "", files)
        self._snapshot = snapshot
        self._originals = {file["path"][len(prefix):]: file for file in snapshot.files}
        self.directories = [path[len(prefix):] for path in getattr(snapshot, "directories", [])
                            if path.startswith(prefix)]

    def read(self, file: dict) -> bytes:
        return self._snapshot.read(self._originals[file["path"]])

    def copy_file(self, file: dict, output: Path):
        self._snapshot.copy_file(self._originals[file["path"]], output)


def project_snapshot(snapshot: Snapshot, existing: dict | None = None) -> Snapshot:
    """Unwrap exactly one common archive directory; repositories keep their root."""
    if (snapshot.source.kind != "archive" or isinstance(snapshot, ArchiveProjectSnapshot)
            or not snapshot.files):
        return snapshot
    if existing is not None and existing["version"] == 1:
        original_paths = {file["path"] for file in snapshot.files}
        if all(entry["path"] in original_paths for entry in existing["entries"]):
            return snapshot
    prefix = snapshot.files[0]["path"].split("/", 1)[0] + "/"
    if not all(file["path"].startswith(prefix) for file in snapshot.files):
        return snapshot
    if prefix[:-1].casefold() == METADATA_DIR:
        raise SkillError("The project contains reserved .skill-meta metadata; existing contents were preserved.")
    return ArchiveProjectSnapshot(snapshot, prefix)


def validate_entries(entries) -> list[dict]:
    if not isinstance(entries, list) or not entries:
        raise SkillError("Invalid project skill entries.")
    names = set()
    paths = set()
    for entry in entries:
        if (not isinstance(entry, dict) or set(entry) != {"path", "name"}
                or not isinstance(entry["path"], str) or not isinstance(entry["name"], str)
                or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", entry["name"])):
            raise SkillError("Invalid project skill entries.")
        path = safe_path(entry["path"])
        if path.split("/")[-1] != "SKILL.md" or path in paths or entry["name"] in names:
            raise SkillError("Invalid project skill entries.")
        paths.add(path)
        names.add(entry["name"])
    for path in paths:
        for other in paths - {path}:
            parent = str(PurePosixPath(other).parent)
            if parent == "." or path.startswith(parent + "/"):
                raise SkillError("A project entry is nested inside another complete skill.")
    return entries


def read_project(group: Path, legacy: bool = False) -> dict | None:
    metadata = group / METADATA_DIR
    if metadata.is_symlink() or (metadata.exists() and not metadata.is_dir()):
        raise SkillError("Invalid project installation record.")
    marker = metadata / PROJECT_FILE
    version, project_root = 2, "."
    if not marker.exists() and not marker.is_symlink():
        if metadata.exists():
            raise SkillError("Invalid project installation record.")
        if not legacy:
            return None
        marker = group / PROJECT_FILE
        version, project_root = 1, "project"
    if marker.is_symlink() or (marker.exists() and not marker.is_file()):
        raise SkillError("Invalid project installation record.")
    if not marker.exists():
        return None
    try:
        if group.is_symlink() or not group.is_dir():
            raise ValueError()
        value = json.loads(marker.read_text(encoding="utf-8"))
        if (not isinstance(value, dict) or set(value) != {"version", "root", "entries"}
                or type(value["version"]) is not int or value["version"] != version or value["root"] != project_root):
            raise ValueError()
        validate_entries(value["entries"])
        if version == 2 and any(entry["path"].split("/", 1)[0].casefold() == METADATA_DIR for entry in value["entries"]):
            raise ValueError()
        project = directory(group, [] if project_root == "." else [project_root])
        if not project.is_dir():
            raise ValueError()
        for entry in value["entries"]:
            parts = entry["path"].split("/")
            parent = directory(project, parts[:-1])
            manifest = parent / parts[-1]
            if manifest.is_symlink() or not manifest.is_file():
                raise ValueError()
        return value
    except (ValueError, TypeError, KeyError, UnicodeError) as exc:
        raise SkillError("Invalid project installation record.") from exc


def group_parts(snapshot: Snapshot, whole_project: bool = False) -> list[str]:
    if whole_project and snapshot.source.kind == "archive":
        return [snapshot.source.repo]
    return [snapshot.source.owner, snapshot.source.repo]


def check_ancestors(root: Path, parts: list[str]):
    """An existing skill or project must never become a container for new groups."""
    for depth in range(len(parts)):
        parent = directory(root, parts[:depth])
        manifest = parent / "SKILL.md"
        if manifest.exists() or manifest.is_symlink():
            raise SkillError("A parent directory already contains a skill; nested installs would be hidden.")
        if depth in (1, 2) and read_project(parent, legacy=depth == 2) is not None:
            raise SkillError("A parent directory contains a whole project; nested installs are not allowed.")


def locate_project(root: Path, snapshot: Snapshot) -> tuple[Path, dict | None]:
    parts = group_parts(snapshot, True)
    check_ancestors(root, parts)
    group = directory(root, parts)
    project = read_project(group, legacy=len(parts) == 2)
    if project is None and snapshot.source.kind == "archive":
        old_group = directory(root, [snapshot.source.owner, snapshot.source.repo])
        old_project = read_project(old_group, legacy=True)
        if old_project is not None and old_project["version"] == 1:
            return old_group, old_project
    return group, project


@contextmanager
def installation_lock(root: Path, parts: list[str]):
    locks = []
    try:
        # Lock ancestors before creating them, sharing the single-directory
        # archive lock with GitHub imports that would use that directory as owner.
        for depth, name in enumerate(parts):
            check_ancestors(root, parts[:depth + 1])
            parent = directory(root, parts[:depth], create=True)
            lock = parent / f".{name}.skill-install.lock"
            try:
                lock.mkdir()
            except FileExistsError as exc:
                raise SkillError("Another install is active for this group. Try again when it finishes.") from exc
            locks.append(lock)
            check_ancestors(root, parts[:depth + 1])
        yield
    finally:
        for lock in reversed(locks):
            lock.rmdir()


def install_project(root: Path, snapshot, selected: list[dict]) -> list[Path]:
    """Called under the shared group lock; stage all bytes and records before one rename."""
    parts = group_parts(snapshot, True)
    check_ancestors(root, parts)
    if snapshot.source.kind == "archive":
        legacy_lock = root / f".{snapshot.source.owner}.skill-install.lock"
        if legacy_lock.exists() or legacy_lock.is_symlink():
            raise SkillError("Another install is active for this group. Try again when it finishes.")
    group, _ = locate_project(root, snapshot)
    if group.exists() or group.is_symlink():
        raise SkillError("The project group already exists. Remove or update the entire group first.")
    source_paths = [file["path"] for file in snapshot.files] + getattr(snapshot, "directories", [])
    if any(path.split("/", 1)[0].casefold() == METADATA_DIR for path in source_paths):
        raise SkillError("The project contains reserved .skill-meta metadata; existing contents were preserved.")
    entries = validate_entries([{"path": skill["manifest"], "name": skill["name"]} for skill in selected])
    record = {"version": 2, "root": ".", "entries": entries}
    with tempfile.TemporaryDirectory(prefix=".skill-project-", dir=group.parent) as temporary:
        staged = Path(temporary) / "next"
        staged.mkdir()
        snapshot.copy({"path": ""}, staged)
        metadata = staged / METADATA_DIR
        metadata.mkdir()
        (metadata / PROJECT_FILE).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        if snapshot.source.kind != "archive":
            source = {"url": snapshot.source.url, "ref": snapshot.ref, "scope": "",
                      "installation": {"mode": "project", "entries": entries}}
            (metadata / SOURCES_FILE).write_text(
                json.dumps({"version": 2, "sources": [source]}, indent=2) + "\n", encoding="utf-8",
            )
        # Recheck destination and its ancestors after potentially slow copying.
        check_ancestors(root, parts)
        directory(root, parts)
        if group.exists() or group.is_symlink():
            raise SkillError("The project group already exists. Existing contents were preserved.")
        staged.rename(group)
    return [group / PurePosixPath(entry["path"]).parent for entry in entries]

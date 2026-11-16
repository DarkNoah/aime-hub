"""Whole-project installation records and atomic publication."""
from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path, PurePosixPath
import re
import tempfile

from repository import SkillError, Snapshot, directory, safe_path


PROJECT_FILE = ".skill-project.json"
PROJECT_ROOT = "project"
SOURCES_FILE = ".skill-sources.json"


class ArchiveProjectSnapshot(Snapshot):
    """Expose project-relative paths while reading validated original archive files."""
    def __init__(self, snapshot: Snapshot, prefix: str):
        files = [{**file, "path": file["path"][len(prefix):]} for file in snapshot.files]
        super().__init__(snapshot.source, snapshot.folder, snapshot.ref, "", files)
        self._snapshot = snapshot
        self._originals = {file["path"][len(prefix):]: file for file in snapshot.files}

    def read(self, file: dict) -> bytes:
        return self._snapshot.read(self._originals[file["path"]])

    def copy_file(self, file: dict, output: Path):
        self._snapshot.copy_file(self._originals[file["path"]], output)


def project_snapshot(snapshot: Snapshot) -> Snapshot:
    """Unwrap exactly one common archive directory; repositories keep their root."""
    if (snapshot.source.kind != "archive" or isinstance(snapshot, ArchiveProjectSnapshot)
            or not snapshot.files):
        return snapshot
    prefix = snapshot.files[0]["path"].split("/", 1)[0] + "/"
    if not all(file["path"].startswith(prefix) for file in snapshot.files):
        return snapshot
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


def read_project(group: Path) -> dict | None:
    marker = group / PROJECT_FILE
    if marker.is_symlink() or (marker.exists() and not marker.is_file()):
        raise SkillError("Invalid project installation record.")
    if not marker.exists():
        return None
    try:
        if group.is_symlink() or not group.is_dir():
            raise ValueError()
        value = json.loads(marker.read_text(encoding="utf-8"))
        if (not isinstance(value, dict) or set(value) != {"version", "root", "entries"}
                or type(value["version"]) is not int or value["version"] != 1 or value["root"] != PROJECT_ROOT):
            raise ValueError()
        validate_entries(value["entries"])
        project = directory(group, [PROJECT_ROOT])
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


@contextmanager
def installation_lock(root: Path, owner: str, repo: str):
    parent = directory(root, [owner], create=True)
    lock = parent / f".{repo}.skill-install.lock"
    try:
        lock.mkdir()
    except FileExistsError as exc:
        raise SkillError("Another install is active for this group. Try again when it finishes.") from exc
    try:
        yield
    finally:
        lock.rmdir()


def install_project(root: Path, snapshot, selected: list[dict]) -> list[Path]:
    """Called under the shared group lock; stage all bytes and records before one rename."""
    group = directory(root, [snapshot.source.owner, snapshot.source.repo])
    if group.exists() or group.is_symlink():
        raise SkillError("The project group already exists. Remove or update the entire group first.")
    entries = validate_entries([{"path": skill["manifest"], "name": skill["name"]} for skill in selected])
    record = {"version": 1, "root": PROJECT_ROOT, "entries": entries}
    with tempfile.TemporaryDirectory(prefix=".skill-project-", dir=group.parent) as temporary:
        staged = Path(temporary) / "next"
        staged.mkdir()
        snapshot.copy({"path": ""}, staged / PROJECT_ROOT)
        (staged / PROJECT_FILE).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        if snapshot.source.kind != "archive":
            source = {"url": snapshot.source.url, "ref": snapshot.ref, "scope": "",
                      "installation": {"mode": "project", "entries": entries}}
            (staged / SOURCES_FILE).write_text(
                json.dumps({"version": 2, "sources": [source]}, indent=2) + "\n", encoding="utf-8",
            )
        # Recheck destination and its ancestors after potentially slow copying.
        directory(root, [snapshot.source.owner, snapshot.source.repo])
        if group.exists() or group.is_symlink():
            raise SkillError("The project group already exists. Existing contents were preserved.")
        staged.rename(group)
    return [group / PROJECT_ROOT / PurePosixPath(entry["path"]).parent for entry in entries]

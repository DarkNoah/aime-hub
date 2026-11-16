#!/usr/bin/env python3
"""Install repository or local archive skills into the current workspace's SKILL_HOME."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile

from repository import SkillError, directory, handle_termination, parse_source, repository, skill_home
from archive import archive
from project import PROJECT_FILE, install_project, installation_lock, project_snapshot, validate_entries


SOURCES_FILE = ".skill-sources.json"


def read_sources(group: Path) -> list[dict]:
    path = group / SOURCES_FILE
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise SkillError("Invalid skill source record; existing contents were preserved.")
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if set(data) != {"version", "sources"} or data["version"] not in (1, 2):
            raise ValueError()
        sources = data["sources"]
        if not isinstance(sources, list) or not sources:
            raise ValueError()
        for source in sources:
            if (not {"url", "ref", "scope"} <= set(source) or set(source) - {"url", "ref", "scope", "installation"}
                    or not isinstance(source["url"], str) or not source["url"]
                    or not isinstance(source["scope"], str)
                    or source["ref"] is not None and (not isinstance(source["ref"], str) or not source["ref"])):
                raise ValueError()
            installation = source.get("installation")
            if installation is not None:
                if not isinstance(installation, dict):
                    raise ValueError()
                if installation.get("mode") == "package":
                    if (set(installation) != {"mode", "path", "name"}
                            or not isinstance(installation["path"], str) or not installation["path"]
                            or not isinstance(installation["name"], str)
                            or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", installation["name"])):
                        raise ValueError()
                elif installation.get("mode") == "project":
                    if set(installation) != {"mode", "entries"}:
                        raise ValueError()
                    validate_entries(installation["entries"])
                elif installation != {"mode": "collection"}:
                    raise ValueError()
            parsed = parse_source(source["url"])
            if (parsed.owner, parsed.repo) != (group.parent.name, group.name):
                raise ValueError()
        return sources
    except (ValueError, TypeError, KeyError) as exc:
        raise SkillError("Invalid skill source record; existing contents were preserved.") from exc


def install(root: Path, snapshot, paths: list[str] | None, whole_project: bool = False) -> list[Path]:
    # Selection and destination validation happen before creating lock directories.
    if whole_project:
        snapshot = project_snapshot(snapshot)
    selected = snapshot.select_project(paths) if whole_project else snapshot.select(paths)[0]
    group = directory(root, [snapshot.source.owner, snapshot.source.repo])
    for parent in (root, group.parent):
        if (parent / "SKILL.md").exists() or (parent / "SKILL.md").is_symlink():
            raise SkillError("A parent directory already contains a skill; nested installs would be hidden.")
    if whole_project and (group.exists() or group.is_symlink()):
        raise SkillError("The project group already exists. Remove or update the entire group first.")
    with installation_lock(root, snapshot.source.owner, snapshot.source.repo):
        if whole_project:
            return install_project(root, snapshot, selected)
        if (group / PROJECT_FILE).exists() or (group / PROJECT_FILE).is_symlink():
            raise SkillError("This group contains a whole project. Manage it as an entire project.")
        return install_skills(root, snapshot, paths)


def install_skills(root: Path, snapshot, paths: list[str] | None) -> list[Path]:
    selected, scopes = snapshot.select(paths)
    group = directory(root, [snapshot.source.owner, snapshot.source.repo])
    for parent in (root, group.parent, group):
        if (parent / "SKILL.md").exists() or (parent / "SKILL.md").is_symlink():
            raise SkillError("A parent directory already contains a skill; nested installs would be hidden.")
    targets = [group / skill["name"] for skill in selected]
    if len(set(targets)) != len(targets):
        raise SkillError("Selected skills resolve to the same destination.")
    for target in targets:
        if target.exists() or target.is_symlink():
            raise SkillError(f"Skill already exists: {target}. Use the management page to update it.")
    directory(root, [snapshot.source.owner, snapshot.source.repo], create=True)
    # Serialize script installs so source records cannot silently replace each other.
    lock = group / ".skill-install.lock"
    try:
        lock.mkdir()
    except FileExistsError as exc:
        raise SkillError("Another install is active for this group. Try again when it finishes.") from exc
    written = []
    try:
        sources = None
        if snapshot.source.kind != "archive":
            sources = {source["url"]: source for source in read_sources(group)}
            for scope in scopes:
                origin = snapshot.origin(scope)
                sources[origin["url"]] = origin
        with tempfile.TemporaryDirectory(prefix=".skill-install-", dir=group) as staging:
            staged = Path(staging)
            for skill in selected:
                snapshot.copy(skill, staged / skill["name"])
            if sources is not None:
                (staged / SOURCES_FILE).write_text(
                    json.dumps({"version": 2, "sources": list(sources.values())}, indent=2) + "\n",
                    encoding="utf-8",
                )
            try:
                for skill, target in zip(selected, targets):
                    if target.exists() or target.is_symlink():
                        raise SkillError(f"Skill already exists: {target}")
                    (staged / skill["name"]).rename(target)
                    written.append(target)
                if sources is not None:
                    (staged / SOURCES_FILE).replace(group / SOURCES_FILE)
            except BaseException:
                for target in reversed(written):
                    shutil.rmtree(target)
                raise
    finally:
        lock.rmdir()
    return written


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--repo", help="owner/repository")
    source.add_argument("--url", help="Original repository or scoped HTTPS URL")
    source.add_argument("--archive", help="Local .zip or .skill package path")
    parser.add_argument("--path", nargs="+", help="Source-relative skill paths or parent directories")
    parser.add_argument("--ref", help="Branch, tag, or full commit SHA (default: repository default branch)")
    parser.add_argument("--whole-project", action="store_true", help="Keep all project files; --path selects enabled skill entries")
    args = parser.parse_args(argv)
    try:
        root = skill_home()
        if args.archive and args.ref is not None:
            raise SkillError("--ref cannot be used with a local archive.")
        source = archive(args.archive) if args.archive else repository(parse_source(args.repo or args.url, args.ref))
        with source as snapshot:
            targets = install(root, snapshot, args.path, args.whole_project)
        for target in targets:
            print(f"Installed {target.name}: {target}")
        return 0
    except (SkillError, OSError, UnicodeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Installation cancelled; temporary files were cleaned.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    handle_termination()
    raise SystemExit(main(sys.argv[1:]))

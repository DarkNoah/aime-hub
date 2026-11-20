#!/usr/bin/env python3
"""List installed skills or inspect candidates in a repository or local archive."""
from __future__ import annotations

import argparse
import json
import sys

from repository import SkillError, directory, handle_termination, installed, parse_source, repository, skill_home
from archive import archive
from project import check_ancestors, ensure_archive_migrated, group_parts, locate_project, project_snapshot, read_archive_group, read_project


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--repo", help="owner/repository")
    source.add_argument("--url", help="Original repository or scoped HTTPS URL")
    source.add_argument("--archive", help="Local .zip or .skill package path")
    parser.add_argument("--path", nargs="+", help="Source-relative skill paths or parent directories")
    parser.add_argument("--ref", help="Branch, tag, or full commit SHA")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--preview", action="store_true", help="Read one selected SKILL.md without installing")
    parser.add_argument("--whole-project", action="store_true", help="List project entries while preserving the complete source tree")
    args = parser.parse_args(argv)
    try:
        root = skill_home()
        if args.repo or args.url or args.archive:
            if args.archive and args.ref is not None:
                raise SkillError("--ref cannot be used with a local archive.")
            source = archive(args.archive) if args.archive else repository(parse_source(args.repo or args.url, args.ref))
            with source as snapshot:
                if args.whole_project:
                    group, project = locate_project(root, snapshot)
                    snapshot = project_snapshot(snapshot, project)
                rows = snapshot.select_project(args.path) if args.whole_project else snapshot.select(args.path)[0]
                if args.preview:
                    if len(rows) != 1:
                        raise SkillError("Preview requires a path selecting exactly one skill.")
                    file = next(file for file in snapshot.files if file["path"] == rows[0]["manifest"])
                    print(snapshot.read(file).decode("utf-8"))
                    return 0
                parts = group_parts(snapshot)
                ensure_archive_migrated(root, snapshot)
                check_ancestors(root, parts)
                if not args.whole_project:
                    group = directory(root, parts)
                    project = read_project(group, legacy=len(parts) == 2)
                archive_group = read_archive_group(group)
                group_conflict = (snapshot.source.kind == "archive" and not args.whole_project
                                  and group.exists() and not archive_group and any(group.iterdir()))
                group_conflict = group_conflict or (snapshot.source.kind != "archive" and archive_group)
                for row in rows:
                    project_root = group / (project["root"] if project else ".")
                    target = project_root / row["path"] if args.whole_project else group / row["name"]
                    row["destination"] = str(target)
                    if args.whole_project:
                        row["projectRoot"] = str(project_root)
                        row["installed"] = project is not None and any(entry["path"] == row["manifest"] for entry in project["entries"])
                        row["conflict"] = group.exists() or group.is_symlink()
                    else:
                        row["installed"] = project is None and not group_conflict and target.is_dir() and not target.is_symlink() and (target / "SKILL.md").is_file()
                        row["conflict"] = project is not None or group_conflict or target.exists() or target.is_symlink()
        else:
            if args.path or args.ref or args.preview or args.whole_project:
                raise SkillError("--path, --ref, --preview and --whole-project require a source.")
            rows = installed(root)
        if args.format == "json":
            print(json.dumps(rows, ensure_ascii=False, indent=2))
        elif not rows:
            print(f"No skills installed in {root}.")
        else:
            for row in rows:
                state = "installed" if row["installed"] else "destination exists" if row.get("conflict") else "available"
                package = "; complete package" if row.get("package") else ""
                print(f"{row['name']} [{state}{package}] — {row['path'] or '.'}")
        return 0
    except (SkillError, OSError, UnicodeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Listing cancelled; temporary files were cleaned.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    handle_termination()
    raise SystemExit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""List installed skills or inspect candidates in a supplied repository."""
from __future__ import annotations

import argparse
import json
import sys

from repository import SkillError, directory, git, handle_termination, installed, parse_source, repository, skill_home


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--repo", help="owner/repository")
    source.add_argument("--url", help="Original repository or scoped HTTPS URL")
    parser.add_argument("--path", nargs="+", help="Repository-relative skill paths or parent directories")
    parser.add_argument("--ref", help="Branch, tag, or full commit SHA")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--preview", action="store_true", help="Read one selected SKILL.md without installing")
    args = parser.parse_args(argv)
    try:
        root = skill_home()
        if args.repo or args.url:
            with repository(parse_source(args.repo or args.url, args.ref)) as snapshot:
                rows, _ = snapshot.select(args.path)
                if args.preview:
                    if len(rows) != 1:
                        raise SkillError("Preview requires a path selecting exactly one skill.")
                    file = next(file for file in snapshot.files if file["path"] == rows[0]["manifest"])
                    print(git(["cat-file", "blob", file["oid"]], snapshot.folder).decode("utf-8"))
                    return 0
                group = directory(root, [snapshot.source.owner, snapshot.source.repo])
                for row in rows:
                    target = group / row["name"]
                    row["destination"] = str(target)
                    row["installed"] = target.is_dir() and not target.is_symlink() and (target / "SKILL.md").is_file()
                    row["conflict"] = target.exists() or target.is_symlink()
        else:
            if args.path or args.ref or args.preview:
                raise SkillError("--path, --ref and --preview require a repository source.")
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

#!/usr/bin/env python3
"""Initialize a skill in the current scope without replacing existing files.

Adapted from the bundled skill initializer; modified to remove product-specific
metadata and use the runtime's SKILL_HOME.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys

ALLOWED_RESOURCES = {"scripts", "references", "assets"}
SKILL_TEMPLATE = """---
name: {name}
description: "[TODO: Describe what this skill does and when to use it.]"
---

# {title}

[TODO: Add task-specific instructions. Link supporting resources only where they are needed.]
"""


def skill_root(path):
    """Use the supplied scope without inferring an account or working directory."""
    configured = os.environ.get("SKILL_HOME", "")
    if not configured:
        raise ValueError("SKILL_HOME must be provided as an absolute directory by the current workspace.")

    def checked_root(raw):
        root = Path(raw)
        if not root.is_absolute() or ".." in root.parts:
            raise ValueError("The skill root must be an absolute path without '..'.")
        for parent in (root, root.parent):
            if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
                raise ValueError("The skill root and its parent must not be symbolic links or files.")
        return root

    root = checked_root(configured)
    if path is not None and root != checked_root(path):
        raise ValueError("--path must match the runtime-supplied SKILL_HOME.")
    if (root / "SKILL.md").exists():
        raise ValueError("The skill root must contain skill folders, not be a skill itself.")
    return root


def init_skill(name, root, resources):
    """Create only a manifest and explicitly requested empty resource folders."""
    skill_dir = root / name
    # mkdir rejects existing directories, files, and dangling symbolic links.
    skill_dir.mkdir(parents=True, exist_ok=False)
    try:
        content = SKILL_TEMPLATE.format(
            name=json.dumps(name),
            title=" ".join(word.capitalize() for word in name.split("-")),
        )
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
        for resource in resources:
            (skill_dir / resource).mkdir()
    except BaseException:
        # Only remove the new directory owned by this invocation.
        shutil.rmtree(skill_dir)
        raise
    return skill_dir


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("skill_name", help="Lowercase letters, digits, and single hyphens")
    parser.add_argument("--path", help="Absolute skill root; defaults to SKILL_HOME")
    parser.add_argument("--resources", default="", help="Comma-separated: scripts,references,assets")
    args = parser.parse_args()
    if len(args.skill_name) > 64 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.skill_name):
        parser.error("Skill names must be 1-64 characters using lowercase letters, digits, and single hyphens.")
    resources = list(dict.fromkeys(part.strip() for part in args.resources.split(",") if part.strip()))
    if set(resources) - ALLOWED_RESOURCES:
        parser.error("Resources must be chosen from scripts,references,assets.")
    try:
        root = skill_root(args.path)
        skill_dir = init_skill(args.skill_name, root, resources)
    except (OSError, ValueError) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 1
    print(f"Created {skill_dir}")
    print("Complete the description and instructions, add needed resources, then run quick_validate.py.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

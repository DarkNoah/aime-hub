#!/usr/bin/env python3
"""Validate a skill's manifest, name, and unfinished instruction placeholders.

Adapted from the bundled skill validator; modified to support portable metadata,
require nonempty fields and matching directory names, and report input errors.
"""

import re
import sys
from pathlib import Path


def validate_skill(skill_path):
    try:
        import yaml
    except ImportError:
        return False, "YAML support is missing. Install scripts/requirements.txt in an available Python environment."

    skill_path = Path(skill_path)
    skill_md = skill_path / "SKILL.md"
    if not skill_md.is_file():
        return False, "SKILL.md not found or not a regular file"
    try:
        content = skill_md.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        return False, f"Cannot read SKILL.md: {error}"
    match = re.match(r"\A---\n(.*?)\n---(?:\n|\Z)", content, re.DOTALL)
    if not match:
        return False, "SKILL.md must start with YAML frontmatter delimited by --- lines"
    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError as error:
        return False, f"Invalid YAML: {error}"
    if not isinstance(frontmatter, dict):
        return False, "Frontmatter must be a YAML mapping"

    name = frontmatter.get("name")
    if not isinstance(name, str) or not 1 <= len(name) <= 64:
        return False, "Name must be a nonempty string of at most 64 characters"
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
        return False, "Name must use lowercase letters, digits, and single hyphens"
    if name != skill_path.absolute().name:
        return False, "Name must match the skill directory name"

    description = frontmatter.get("description")
    if not isinstance(description, str) or not description.strip():
        return False, "Description must be a nonempty string"
    if len(description) > 1024:
        return False, "Description must be at most 1024 characters"
    if description.strip().startswith("[TODO:"):
        return False, "Description contains an unfinished TODO placeholder"
    if "metadata" in frontmatter and not isinstance(frontmatter["metadata"], dict):
        return False, "Metadata must be a YAML mapping"
    if "license" in frontmatter and not isinstance(frontmatter["license"], str):
        return False, "License must be a string"
    if "user-invocable" in frontmatter and not isinstance(frontmatter["user-invocable"], bool):
        return False, "user-invocable must be a boolean"

    body = content[match.end():]
    if not body.strip():
        return False, "Skill instructions must not be empty"
    fence_marker = None
    fence_length = 0
    for line in body.splitlines():
        fence = re.match(r"^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$", line)
        if fence:
            marker = fence.group(1)
            if fence_marker is None:
                fence_marker = marker[0]
                fence_length = len(marker)
            elif marker[0] == fence_marker and len(marker) >= fence_length and not fence.group(2).strip():
                fence_marker = None
                fence_length = 0
            continue
        if fence_marker is None and re.fullmatch(r"[ ]{0,3}\[TODO:[^\n]*\][ \t]*", line):
            return False, "Skill instructions contain an unfinished TODO placeholder"

    return True, "Skill is valid."


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 quick_validate.py <skill-directory>", file=sys.stderr)
        return 1
    valid, message = validate_skill(sys.argv[1])
    print(message)
    return 0 if valid else 1


if __name__ == "__main__":
    sys.exit(main())

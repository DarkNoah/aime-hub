"""Shared repository snapshots and current-scope skill paths."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import tempfile
from contextlib import contextmanager
from collections import Counter
from dataclasses import dataclass
from urllib.parse import quote, unquote, urlsplit


class SkillError(Exception):
    pass


class TransferError(SkillError):
    pass


def handle_termination():
    # Command runners normally cancel with SIGTERM; unwind cleanup contexts.
    def interrupt(_signum, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupt)


@dataclass
class Source:
    owner: str
    repo: str
    url: str
    ref: str | None = None
    kind: str | None = None
    ref_path: str | None = None


def safe_path(value: str, allow_root: bool = False) -> str:
    if allow_root and value in ("", "."):
        return ""
    if (not value or "\\" in value or any(ord(c) < 32 or ord(c) == 127 for c in value)
            or any(part in ("", ".", "..") or part.lower() == ".git" for part in value.split("/"))):
        raise SkillError("Expected a safe repository-relative path.")
    return value


def skill_home() -> Path:
    value = os.environ.get("SKILL_HOME", "")
    root = Path(value)
    if not value or not root.is_absolute() or ".." in root.parts:
        raise SkillError("SKILL_HOME must be provided as an absolute directory by the current workspace.")
    for path in (root.parent, root):
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise SkillError("The skill root must not be a symbolic link or a file.")
    return root


def directory(root: Path, parts: list[str], create: bool = False) -> Path:
    current = root
    for part in [None, *parts]:
        if part is not None:
            safe_path(part)
            if "/" in part:
                raise SkillError("Expected a single directory name.")
            current = current / part
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            raise SkillError("A destination directory is a symbolic link or a file.")
        if create:
            current.mkdir(parents=True, exist_ok=True)
    return current


def installed(root: Path) -> list[dict]:
    result = []
    if not root.exists():
        return result
    def visit(folder: Path):
        manifest = folder / "SKILL.md"
        if manifest.is_file() and not manifest.is_symlink():
            result.append({"name": folder.name, "path": str(folder.relative_to(root)), "installed": True})
            return
        for child in sorted(folder.iterdir()):
            if child.is_dir() and not child.is_symlink() and not child.name.startswith("."):
                visit(child)
    visit(root)
    return result


def parse_source(value: str, ref: str | None = None) -> Source:
    if re.fullmatch(r"[a-zA-Z0-9-]+/[a-zA-Z0-9_.-]+", value):
        value = "https://github.com/" + value
    parsed = urlsplit(value)
    match = re.fullmatch(r"/([a-zA-Z0-9-]+)/([a-zA-Z0-9_.-]+)(?:/(tree|blob)/(.+?))?/?", parsed.path)
    if (parsed.scheme != "https" or parsed.netloc != "github.com" or parsed.query
            or parsed.fragment or not match or "\\" in value):
        raise SkillError("Provide owner/repo or an original https://github.com/owner/repo source URL.")
    owner, repo, kind, ref_path = match.groups()
    repo = repo.removesuffix(".git").lower()
    owner = owner.lower()
    if not repo or repo.startswith("."):
        raise SkillError("Invalid repository name.")
    if ref_path:
        ref_path = safe_path(unquote(ref_path))
        if ref is not None:
            raise SkillError("Use the link's revision or --ref with a repository root, not both.")
    if ref is not None:
        safe_path(ref)
        if ref.startswith("-"):
            raise SkillError("Invalid revision.")
    return Source(owner, repo, f"https://github.com/{owner}/{repo}", ref, kind, ref_path)


def git(args: list[str], cwd: Path | None = None, output=None) -> bytes:
    env = {"PATH": os.environ.get("PATH", ""), "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": ""}
    try:
        result = subprocess.run(["git", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
                                 "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
                                 "-c", "http.followRedirects=false", *args], cwd=cwd, env=env,
                                stdout=output if output is not None else subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError as exc:
        raise SkillError("Git is required to access a repository.") from exc
    if result.returncode:
        raise TransferError("Repository transfer failed; check the public source and network connection.")
    return result.stdout or b""


@dataclass
class Snapshot:
    source: Source
    folder: Path
    ref: str
    scope: str
    files: list[dict]

    def candidates(self) -> list[dict]:
        manifests = [file for file in self.files if file["path"].split("/")[-1] == "SKILL.md"]
        names = [slug(PurePosixPath(file["path"]).parent.name or
                      manifest_name(git(["cat-file", "blob", file["oid"]], self.folder).decode("utf-8")) or
                      self.source.repo) for file in manifests]
        counts = Counter(names)
        result = []
        for file, name in zip(manifests, names):
            if counts[name] > 1:
                name += "-" + hashlib.sha256(file["path"].encode()).hexdigest()[:8]
            path = str(PurePosixPath(file["path"]).parent)
            path = "" if path == "." else path
            bundled = [entry["path"] for entry in manifests if entry["path"] != file["path"]
                       and (not path or entry["path"].startswith(path + "/"))]
            result.append({"name": name, "path": path, "manifest": file["path"],
                           "package": not path or bool(bundled), "bundledSkills": bundled})
        return result

    def select(self, paths: list[str] | None) -> tuple[list[dict], list[str]]:
        scopes = list(dict.fromkeys(safe_path(path, True) for path in paths)) if paths else [self.scope]
        selected = {}
        candidates = self.candidates()
        for scope in scopes:
            if self.scope and not (scope == self.scope or (self.source.kind != "blob" and scope.startswith(self.scope + "/"))):
                raise SkillError("The requested path is outside the source URL scope.")
            if not any(not scope or skill["path"] == scope or skill["manifest"] == scope
                       or skill["manifest"].startswith(scope + "/") for skill in candidates):
                raise SkillError(f"No skills found at the requested path: {scope or '.'}")
        # Selecting a package and one of its descendants still installs it once.
        def scope_directory(scope):
            directory = str(PurePosixPath(scope).parent) if scope.split("/")[-1] == "SKILL.md" else scope
            return "" if directory == "." else directory
        scopes = [scope for index, scope in enumerate(scopes) if not any(
            (scope_directory(other) == scope_directory(scope) and other_index < index) or
            (scope_directory(other) != scope_directory(scope) and
             (not scope_directory(other) or scope_directory(scope).startswith(scope_directory(other) + "/")))
            for other_index, other in enumerate(scopes))]
        for scope in scopes:
            matches = [skill for skill in candidates if not scope or skill["path"] == scope
                       or skill["manifest"] == scope or skill["manifest"].startswith(scope + "/")]
            if not matches:
                raise SkillError(f"No skills found at the requested path: {scope or '.'}")
            for skill in matches:
                if not any(other["manifest"] != skill["manifest"] and
                           (not other["path"] or skill["manifest"].startswith(other["path"] + "/"))
                           for other in matches):
                    selected[skill["manifest"]] = {**skill, "package": skill["package"] or scope_directory(scope) == skill["path"]}
        return list(selected.values()), scopes

    def origin(self, scope: str) -> dict:
        entry = scope if scope.split("/")[-1] == "SKILL.md" else (scope + "/" if scope else "") + "SKILL.md"
        package = next((skill for skill in self.candidates() if skill["manifest"] == entry), None)
        installation = {"mode": "package", "path": entry, "name": package["name"]} if package else {"mode": "collection"}
        if not scope and self.source.ref is None and not self.source.ref_path:
            return {"url": self.source.url, "ref": None, "scope": "", "installation": installation}
        kind = "blob" if scope.split("/")[-1] == "SKILL.md" else "tree"
        suffix = self.ref + ("/" + scope if scope else "")
        return {"url": f"{self.source.url}/{kind}/{quote(suffix, safe='/')}", "ref": self.ref, "scope": scope,
                "installation": installation}

    def copy(self, skill: dict, target: Path):
        prefix = skill["path"] + "/" if skill["path"] else ""
        for file in self.files:
            if not file["path"].startswith(prefix):
                continue
            output = target / file["path"][len(prefix):]
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("xb") as stream:
                git(["cat-file", "blob", file["oid"]], self.folder, stream)
            output.chmod(0o755 if file["mode"] == "100755" else 0o644)


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:54].rstrip("-") or "skill"


def manifest_name(content: str) -> str:
    """Read the standard skill-name scalar without a third-party YAML dependency."""
    frontmatter = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if not frontmatter:
        return ""
    text = frontmatter[1].strip()
    if text.startswith("{"):
        try:
            value = json.loads(text).get("name", "")
            return value if isinstance(value, str) else ""
        except (ValueError, AttributeError):
            return ""
    name = re.search(r"^name:\s*(.+)$", text, re.MULTILINE)
    if not name:
        return ""
    scalar = name[1].strip()
    if scalar.startswith('"'):
        try:
            value, _ = json.JSONDecoder().raw_decode(scalar)
            return value if isinstance(value, str) else ""
        except ValueError:
            return ""
    if scalar.startswith("'"):
        quoted = re.match(r"^'((?:[^']|'')*)'", scalar)
        return quoted[1].replace("''", "'") if quoted else ""
    return re.split(r"\s+#", scalar, maxsplit=1)[0].strip()


@contextmanager
def repository(source: Source):
    remote = source.url + ".git"
    with tempfile.TemporaryDirectory(prefix="skill-repository-") as temporary:
        for index, url in enumerate([remote, "https://githubproxy.cc/" + remote, "https://ghfast.top/" + remote]):
            folder = Path(temporary) / "repo"
            ref, scope = source.ref, ""
            try:
                if source.ref_path:
                    rows = git(["ls-remote", "--heads", "--tags", "--", url]).decode().splitlines()
                    refs = [row.split("\t", 1)[1].split("/", 2)[2] for row in rows if "\trefs/heads/" in row or "\trefs/tags/" in row]
                    matches = [value for value in refs if not value.endswith("^{}") and (source.ref_path == value or source.ref_path.startswith(value + "/"))]
                    ref = max(matches, key=len) if matches else source.ref_path[:40] if re.match(r"^[a-f0-9]{40}(?:/|$)", source.ref_path) else None
                    if not ref:
                        raise SkillError("The source revision no longer exists.")
                    scope = source.ref_path[len(ref):].lstrip("/")
                if ref and re.fullmatch(r"[a-f0-9]{40}", ref):
                    git(["init", "--", str(folder)])
                    git(["fetch", "--depth=1", "--", url, ref], folder)
                    revision = "FETCH_HEAD"
                else:
                    git(["clone", "--depth=1", "--single-branch", "--no-tags", "--no-checkout",
                         *(["--branch", ref] if ref else []), "--", url, str(folder)])
                    revision = "HEAD"
                commit = git(["rev-parse", revision], folder).decode().strip()
                if ref is None:
                    ref = git(["symbolic-ref", "--short", "HEAD"], folder).decode().strip()
                raw = git(["ls-tree", "-rz", commit], folder)
                break
            except TransferError:
                shutil.rmtree(folder, ignore_errors=True)
                if index == 2:
                    raise
        files = []
        for row in raw.decode().split("\0"):
            if not row:
                continue
            metadata, path = row.split("\t", 1)
            mode, _, oid = metadata.split()
            safe_path(path)
            if mode in ("100644", "100755"):
                files.append({"path": path, "mode": mode, "oid": oid})
        if source.kind == "blob":
            if not any(file["path"] == scope and scope.split("/")[-1] == "SKILL.md" for file in files):
                raise SkillError("The source manifest no longer exists.")
        elif scope and not any(file["path"].startswith(scope + "/") for file in files):
            raise SkillError("The source path no longer exists.")
        yield Snapshot(source, folder, ref, scope, files)

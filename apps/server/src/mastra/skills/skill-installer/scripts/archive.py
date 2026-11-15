"""Validated local ZIP snapshots, shared by listing and installation."""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import re
import shutil
import stat
import struct
import tempfile
import unicodedata
import zipfile
import zlib

from repository import SkillError, Snapshot, Source, slug


MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_ENTRIES = 10_000


class ArchiveSnapshot(Snapshot):
    def read(self, file: dict) -> bytes:
        return (self.folder / file["path"]).read_bytes()

    def copy_file(self, file: dict, output: Path):
        with (self.folder / file["path"]).open("rb") as source, output.open("xb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)


def archive_path(value: str) -> str:
    path = value[:-1] if value.endswith("/") else value
    if (not path or "\\" in path or re.match(r"^[a-zA-Z]:", path)
            or any(ord(character) < 32 or ord(character) == 127 for character in path)
            or any(part in ("", ".", "..") for part in path.split("/"))):
        raise SkillError("Archive contains an unsafe path.")
    return path


def ignored(path: str) -> bool:
    return any(part.lower() in (".git", "__macosx", ".ds_store") or part.startswith("._")
               for part in path.split("/"))


def member_chunks(package: zipfile.ZipFile, stream, entry: zipfile.ZipInfo):
    # ZipFile validates local names, flags and overlapping data ranges. Read raw
    # payloads ourselves: ZipExtFile silently truncates output to the claimed size.
    with package.open(entry):
        pass
    stream.seek(entry.header_offset)
    header = stream.read(30)
    if len(header) != 30:
        raise zipfile.BadZipFile("Truncated local header")
    if struct.unpack_from("<HH", header, 6) != (entry.flag_bits, entry.compress_type):
        raise zipfile.BadZipFile("Inconsistent local header")
    name_length, extra_length = struct.unpack_from("<HH", header, 26)
    stream.seek(entry.header_offset + 30 + name_length + extra_length)
    remaining = entry.compress_size
    decoder = zlib.decompressobj(-zlib.MAX_WBITS) if entry.compress_type == zipfile.ZIP_DEFLATED else None
    while remaining:
        data = stream.read(min(64 * 1024, remaining))
        if not data:
            raise zipfile.BadZipFile("Truncated archive data")
        remaining -= len(data)
        if decoder is None:
            yield data
        else:
            while data:
                chunk = decoder.decompress(data, 1024 * 1024)
                data = decoder.unconsumed_tail
                if decoder.unused_data or decoder.eof and remaining:
                    raise zipfile.BadZipFile("Trailing compressed data")
                if chunk:
                    yield chunk
    if decoder is not None:
        while not decoder.eof:
            chunk = decoder.decompress(b"", 1024 * 1024)
            if not chunk:
                break
            yield chunk
        if not decoder.eof or decoder.unused_data:
            raise zipfile.BadZipFile("Invalid compressed data")


@contextmanager
def archive(value: str):
    path = Path(value)
    if path.suffix.lower() not in (".zip", ".skill"):
        raise SkillError("Choose a .zip or .skill package.")
    if not path.is_file():
        raise SkillError("The archive file does not exist.")
    if path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise SkillError("Archive exceeds the 100 MiB upload limit.")
    try:
        with path.open("rb") as stream, zipfile.ZipFile(stream) as package:
            # Use the opened file's size too, in case the path changed before opening.
            stream.seek(0, 2)
            if stream.tell() > MAX_ARCHIVE_BYTES:
                raise SkillError("Archive exceeds the 100 MiB upload limit.")
            entries = package.infolist()
            if not entries:
                raise SkillError("The archive is empty.")
            if len(entries) > MAX_ENTRIES:
                raise SkillError("Archive exceeds the 10,000-entry limit.")
            seen = set()
            tree = {}
            total = 0
            files = []
            for entry in entries:
                name = archive_path(entry.orig_filename)
                mode = entry.external_attr >> 16 if entry.create_system == 3 else 0
                file_type = stat.S_IFMT(mode)
                directory = entry.is_dir()
                if (file_type not in (0, stat.S_IFREG, stat.S_IFDIR)
                        or file_type == stat.S_IFDIR and not directory
                        or file_type == stat.S_IFREG and directory
                        or entry.external_attr & 0x10 and not directory):
                    raise SkillError("Archive contains a symbolic link or unsupported file type.")
                if entry.flag_bits & (1 | 64):
                    raise SkillError("Encrypted archives are not supported.")
                if entry.flag_bits & ~0x080e:
                    raise SkillError("Archive uses unsupported ZIP flags.")
                if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise SkillError("Archive uses an unsupported compression method.")
                key = unicodedata.normalize("NFC", name).lower()
                if key in seen:
                    raise SkillError("Archive contains duplicate or conflicting paths.")
                seen.add(key)
                parts = name.split("/")
                for index in range(1, len(parts) + 1):
                    component = "/".join(parts[:index])
                    component_key = unicodedata.normalize("NFC", component).lower()
                    component_type = "directory" if index < len(parts) or directory else "file"
                    existing = tree.get(component_key)
                    if existing is not None and existing != (component, component_type):
                        raise SkillError("Archive contains duplicate or conflicting paths.")
                    tree[component_key] = (component, component_type)
                total += entry.file_size
                if total > MAX_EXPANDED_BYTES:
                    raise SkillError("Archive exceeds the 512 MiB expanded-size limit.")
                if directory and entry.file_size:
                    raise SkillError("Archive contains an invalid directory entry.")
                if not directory and not ignored(name):
                    files.append({"path": name, "mode": "100755" if mode & 0o111 else "100644", "entry": entry})
            if not any(file["path"].split("/")[-1] == "SKILL.md" for file in files):
                raise SkillError("No SKILL.md was found in the archive.")
            with tempfile.TemporaryDirectory(prefix="skill-archive-") as temporary:
                folder = Path(temporary)
                kept = {file["path"] for file in files}
                expanded = 0
                # Fully verify every member before exposing a snapshot, including ignored metadata.
                for entry in entries:
                    name = archive_path(entry.orig_filename)
                    size = 0
                    crc = 0
                    output = None
                    try:
                        if name in kept and not entry.is_dir():
                            destination = folder / name
                            destination.parent.mkdir(parents=True, exist_ok=True)
                            output = destination.open("xb")
                        for chunk in member_chunks(package, stream, entry):
                            size += len(chunk)
                            expanded += len(chunk)
                            if expanded > MAX_EXPANDED_BYTES or size > entry.file_size:
                                raise SkillError("Archive exceeds its declared size or the expanded-size limit.")
                            crc = zlib.crc32(chunk, crc)
                            if output is not None:
                                output.write(chunk)
                        if size != entry.file_size:
                            raise SkillError("Archive contains an invalid file size.")
                        if crc != entry.CRC:
                            raise zipfile.BadZipFile("Invalid archive CRC")
                    finally:
                        if output is not None:
                            output.close()
                yield ArchiveSnapshot(Source("@local", slug(path.stem), "", kind="archive"), folder, "", "", files)
    except (zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError, NotImplementedError, EOFError, zlib.error) as exc:
        raise SkillError("The archive is damaged, encrypted, or uses an unsupported ZIP format.") from exc

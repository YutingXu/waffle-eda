#!/usr/bin/env python3
"""Check Git's index for private project references and machine-local paths."""

import argparse
import codecs
from dataclasses import dataclass
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import zipfile
import zlib


ROOT = Path(__file__).resolve().parents[1]

PRIVATE_CANDIDATE = re.compile(
    rb"[a-z]{2}[-_ ]?[0-9]{4}(?![0-9])"
    rb"|[a-z]{11}\.pcbdoc"
    rb"|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}",
    re.IGNORECASE,
)
PRIVATE_SEPARATORS = re.compile(rb"[-_ ]")

VERSION_MARKER = re.compile(rb"v[0-9]{1,4}(?![0-9])", re.IGNORECASE)
IDENTIFIER_WORD = frozenset(b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
IDENTIFIER_SEPARATOR = frozenset(b" \t-_.:+/\\")
# Typographic dashes, a Unicode minus and ideographic space.
IDENTIFIER_UTF8_SEPARATOR = frozenset(
    value.encode("utf-8") for value in ("\u2010", "\u2011", "\u2012", "\u2013", "\u2014",
                                        "\u2212", "\u3000")
)
NON_IDENTIFIER_WORD = re.compile(rb"[^a-z0-9]")


SLASH = rb"[/\\]+"
PATH_SEGMENT = rb"[a-z0-9.%_~+\x80-\xff-]+"
LOCAL_PATH = re.compile(
    rb"(?<![a-z0-9._/\\$~-])"
    rb"(?:file:" + SLASH + rb")?(?:[a-z]:)?" + SLASH
    + rb"(?:users|home|root|scratch|temp|documents and settings|"
    + rb"windows" + SLASH + rb"temp|(?:private" + SLASH + rb")?"
    + rb"(?:tmp|var" + SLASH + rb"(?:folders|tmp)))"
    + SLASH + PATH_SEGMENT + rb"(?:" + SLASH + PATH_SEGMENT + rb")*"
    + rb"|-users-[a-z0-9_-]+?-(?:documents|desktop|downloads|library)(?:-|/)",
    re.IGNORECASE,
)
PATH_SEPARATORS = re.compile(SLASH)

# Exact synthetic paths used to check parsing and diagnostics, isolated
# container paths, and the documented before/after UI snapshot commands.
ZIP_HEADERS = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
GZIP_HEADER = b"\x1f\x8b"
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 2048

# This exact importer test fixture deliberately declares oversized members.
# Scan its member names and comments while leaving its payloads unopened.
MAX_POLICY_BYTES = 1024 * 1024
POLICY_SHA256 = re.compile("[0-9a-f]{64}")


@dataclass(frozen=True)
class PrivacyPolicy:
    legacy_fingerprints: frozenset
    versioned_fingerprints: frozenset
    public_component_lines: dict
    public_path_examples: dict
    public_fixture_digests: dict
    oversized_zip_fixtures: dict


GENERIC_POLICY = PrivacyPolicy(frozenset(), frozenset(), {}, {}, {}, {})


def unique_fields(pairs):
    record = dict(pairs)
    if len(record) != len(pairs):
        raise ValueError("Duplicate privacy policy field.")
    return record


def parse_private_policy(data):
    record = json.loads(data, object_pairs_hook=unique_fields)
    fields = set(PrivacyPolicy.__annotations__) | {"schema"}
    if not isinstance(record, dict) or record.keys() != fields or type(record["schema"]) != int or record["schema"] != 1:
        raise ValueError("Unsupported privacy policy format.")

    def digest(value):
        if not isinstance(value, str) or not POLICY_SHA256.fullmatch(value):
            raise ValueError("Invalid privacy policy digest.")
        return value

    def members(value, validate):
        if not isinstance(value, list):
            raise ValueError("Invalid privacy policy member list.")
        result = frozenset(validate(item) for item in value)
        if len(result) != len(value):
            raise ValueError("Duplicate privacy policy member.")
        return result

    def text(value):
        if not isinstance(value, str) or not value or any(character in value for character in ("\0", "\n", "\r")):
            raise ValueError("Invalid privacy policy entry.")
        return value.encode("utf-8")

    def path_map(field, validate):
        mapping = record[field]
        if not isinstance(mapping, dict):
            raise ValueError("Invalid privacy policy path map.")
        return {text(path): validate(value) for path, value in mapping.items()}

    legacy = members(record["legacy_fingerprints"], digest)
    versioned = members(record["versioned_fingerprints"], digest)
    if not legacy or not versioned:
        raise ValueError("Missing required privacy policy rule set.")
    return PrivacyPolicy(
        legacy,
        versioned,
        path_map("public_component_lines", lambda value: members(value, digest)),
        path_map("public_path_examples", lambda value: members(value, text)),
        path_map("public_fixture_digests", digest),
        path_map("oversized_zip_fixtures", digest),
    )


def load_private_policy(filename, digest, root):
    if not filename or not digest or not POLICY_SHA256.fullmatch(digest):
        raise ValueError("Private validation requires a policy file and expected SHA-256.")
    path = Path(filename)
    if not path.is_absolute() or path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Keep the policy outside the repository.")
    # Check the open inode, never follow a final symlink, and do not block on a FIFO.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.getuid():
            raise ValueError("Use a runner-owned regular mode-0600 policy file.")
        data = source.read(MAX_POLICY_BYTES + 1)
    if len(data) > MAX_POLICY_BYTES or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Private policy does not match its expected SHA-256.")
    try:
        return parse_private_policy(data)
    except (ValueError, TypeError, UnicodeError):
        raise ValueError("Invalid private policy format.") from None


def utf8_view(data):
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encoding = "utf-16"
    else:
        # An ordinary UTF-16 document without a BOM often has an ASCII run.
        # Sample both byte lanes so native binary formats keep their raw scan.
        sample = data[:1024]
        even_nuls = sample[::2].count(0)
        odd_nuls = sample[1::2].count(0)
        if odd_nuls >= 3 and even_nuls == 0:
            encoding = "utf-16-le"
        elif even_nuls >= 3 and odd_nuls == 0:
            encoding = "utf-16-be"
        else:
            return data
    try:
        text = data.decode(encoding)
    except UnicodeError:
        return data
    return text.encode("utf-8") if "\0" not in text else data


def zip_fields(data, path, policy):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        fixture_digest = policy.oversized_zip_fixtures.get(path)
        oversized_fixture = bool(fixture_digest and hashlib.sha256(data).hexdigest() == fixture_digest)
        if len(members) > MAX_ARCHIVE_ENTRIES or (
            not oversized_fixture and sum(member.file_size for member in members) > MAX_ARCHIVE_BYTES
        ):
            raise ValueError("ZIP index exceeds the inspection limit")
        yield "ZIP comment", archive.comment
        for number, member in enumerate(members, 1):
            label = f"ZIP member {number}"
            yield f"{label} filename", member.orig_filename.encode("utf-8")
            yield f"{label} comment", member.comment
            if not oversized_fixture and not member.is_dir():
                yield label, archive.read(member)


def gzip_fields(data):
    remaining = MAX_ARCHIVE_BYTES
    for number in range(1, MAX_ARCHIVE_ENTRIES + 1):
        reader = zlib.decompressobj(16 + zlib.MAX_WBITS)
        content = reader.decompress(data, remaining + 1)
        if len(content) > remaining or not reader.eof:
            raise ValueError("gzip member exceeds the inspection limit or is incomplete")
        label = f"gzip member {number}"
        cursor = 10
        flags = data[3]
        if flags & 4:  # Optional extra field has a two-byte little-endian length.
            cursor += 2 + int.from_bytes(data[cursor:cursor + 2], "little")
        for flag, field in ((8, "filename"), (16, "comment")):
            if flags & flag:
                end = data.index(b"\0", cursor)
                yield f"{label} {field}", data[cursor:end]
                cursor = end + 1
        yield label, content
        remaining -= len(content)
        data = reader.unused_data.lstrip(b"\0")
        if not data:
            return
    raise ValueError("gzip member count exceeds the inspection limit")


def adjacent_word_edges(data, offset, direction, limit):
    """Yield the outer edges of nearby words without crossing a line."""
    cursor = offset if direction == 1 else offset - 1
    for _ in range(limit):
        gap = 0
        while 0 <= cursor < len(data):
            if data[cursor] in IDENTIFIER_SEPARATOR:
                cursor += direction
            elif data[cursor] >= 128 and (
                data[cursor:cursor + 3] if direction == 1 else data[max(0, cursor - 2):cursor + 1]
            ) in IDENTIFIER_UTF8_SEPARATOR:
                cursor += 3 * direction
            else:
                break
            gap += 1
            if gap > 8:
                return
        width = 0
        while 0 <= cursor < len(data) and data[cursor] in IDENTIFIER_WORD:
            cursor += direction
            width += 1
            if width > 48:
                return
        if not width:
            return
        yield cursor if direction == 1 else cursor + 1


def versioned_references(data, fingerprints):
    """Yield the longest matching span for each start around a version marker."""
    if not fingerprints:
        return
    for version in VERSION_MARKER.finditer(data):
        starts = tuple(adjacent_word_edges(data, version.start(), -1, 3))
        if not starts:
            continue
        end = version.end()
        ends = list(adjacent_word_edges(data, end, 1, 2))
        if end == len(data) or data[end] not in IDENTIFIER_WORD:
            ends.insert(0, end)
        for start in starts:
            for candidate_end in reversed(ends):
                value = NON_IDENTIFIER_WORD.sub(b"", data[start:candidate_end].lower())
                if hashlib.sha256(value).hexdigest() in fingerprints:
                    yield start, candidate_end
                    break


def private_references(data, path=b"", policy=GENERIC_POLICY):
    for start, _ in versioned_references(data, policy.versioned_fingerprints):
        yield start, "private project or workspace reference"

    for match in PRIVATE_CANDIDATE.finditer(data):
        value = PRIVATE_SEPARATORS.sub(b"", match.group().lower())
        if hashlib.sha256(value).hexdigest() not in policy.legacy_fingerprints:
            continue
        start = data.rfind(b"\n", 0, match.start()) + 1
        end = data.find(b"\n", match.end())
        line = data[start:end if end >= 0 else len(data)].strip()
        if hashlib.sha256(line).hexdigest() not in policy.public_component_lines.get(path, ()):
            yield match.start(), "private project or workspace reference"

    fixture_digest = policy.public_fixture_digests.get(path)
    if fixture_digest and hashlib.sha256(data).hexdigest() == fixture_digest:
        return
    for match in LOCAL_PATH.finditer(data):
        value = PATH_SEPARATORS.sub(b"/", match.group().lower())
        if value.startswith(b"file:"):
            value = value[5:]
        value = value.lstrip(b"/").replace(b":/", b":", 1)
        if value not in policy.public_path_examples.get(path, ()):
            yield match.start(), "machine-local absolute path"


def findings_in(data, location, path, policy):
    data = utf8_view(data)
    findings = {
        (data.count(b"\n", 0, offset) + 1, reason)
        for offset, reason in private_references(data, path, policy)
    }
    for line, reason in sorted(findings):
        yield f"{location}:{line}", reason


REDACTED_FILENAME = ("<redacted tracked filename>", "private reference in filename")


def blob_findings(data, path, policy):
    if any(private_references(path, policy=policy)):
        yield REDACTED_FILENAME
        return
    yield from _blob_findings(data, path, policy)


def _blob_findings(data, path, policy):
    location = repr(os.fsdecode(path))
    yield from findings_in(data, location, path, policy)
    if data.startswith(ZIP_HEADERS):
        archive = zip_fields(data, path, policy)
    elif data.startswith(GZIP_HEADER):
        archive = gzip_fields(data)
    else:
        return
    try:
        for label, contents in archive:
            yield from findings_in(contents, f"{location} ({label})", b"", policy)
    except (ValueError, OSError, EOFError, RuntimeError, zipfile.BadZipFile, zlib.error):
        yield location, "archive could not be inspected within the privacy check limits"


def scan_repository(root, policy=GENERIC_POLICY):
    index = subprocess.check_output(
        ["git", "ls-files", "--stage", "-z"], cwd=root, stderr=subprocess.DEVNULL
    ).split(b"\0")
    with subprocess.Popen(
        ["git", "cat-file", "--batch"], cwd=root,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    ) as blobs:
        for record in index:
            if not record:
                continue
            entry, path = record.split(b"\t", 1)
            mode, oid, stage = entry.split()
            if stage != b"0":
                yield "<unmerged index entry>", "resolve the index before checking"
                continue
            if any(private_references(path, policy=policy)):
                yield REDACTED_FILENAME
                continue
            if mode == b"160000":  # Gitlink entries have no blob in this repository.
                continue
            blobs.stdin.write(oid + b"\n")
            blobs.stdin.flush()
            header = blobs.stdout.readline().split()
            if len(header) != 3 or header[1] != b"blob":
                raise ValueError("could not read a tracked Git blob")
            data = blobs.stdout.read(int(header[2]))
            if blobs.stdout.read(1) != b"\n":
                raise ValueError("truncated Git blob")
            yield from _blob_findings(data, path, policy)
        blobs.stdin.close()
    if blobs.returncode:
        raise subprocess.CalledProcessError(blobs.returncode, blobs.args)


def main(root=ROOT, show_locations=True):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-policy", action="store_true",
                        help="Require the provisioned private policy.")
    parser.add_argument("--policy-file", default=os.environ.get("WAFFLE_PRIVACY_POLICY_FILE"))
    parser.add_argument("--policy-sha256", default=os.environ.get("WAFFLE_PRIVACY_POLICY_SHA256"))
    args = parser.parse_args()
    policy = GENERIC_POLICY
    private = args.require_policy or args.policy_file is not None or args.policy_sha256 is not None
    if private:
        try:
            policy = load_private_policy(args.policy_file, args.policy_sha256, root)
        except ValueError as failure:
            print(str(failure), file=sys.stderr)
            return 2
        except (OSError, RuntimeError):
            print("The private policy could not be opened.", file=sys.stderr)
            return 2
    found = False
    try:
        for location, reason in scan_repository(root, policy):
            if show_locations:
                print(f"{location}: {reason}", file=sys.stderr)
            found = True
    except (OSError, ValueError, subprocess.SubprocessError):
        print("Could not inspect the staged Git index.", file=sys.stderr)
        return 2
    if found:
        if show_locations:
            print("Use a neutral project label or a portable path.", file=sys.stderr)
        else:
            print("The release index has privacy findings.", file=sys.stderr)
    else:
        print("Private release index check passed" if private else "Generic portability check passed")
    return int(found)


if __name__ == "__main__":
    sys.exit(main())

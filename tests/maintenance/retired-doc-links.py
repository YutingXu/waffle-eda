#!/usr/bin/env python3
"""Reject documentation links into retired public-tree paths."""

import argparse
from html import unescape
from html.parser import HTMLParser
from io import BytesIO
import os
from pathlib import Path
import posixpath
import re
import string
import subprocess
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[2]
REPOSITORIES = {"yutingxu/waffle-eda", "yutingxu/atrium"}
RETIRED_DIRS = ("reviews", "handoff", "research", "docs/butter-design")
RETIRED_FILES = re.compile(r"(?:checklist|market_research|roadmap|parity[^/]*)\.md")
ESCAPED = r"\\([" + re.escape(string.punctuation) + r"])"
BACKSLASH = re.compile(ESCAPED)
HORIZONTAL = re.compile(r"[ \t]*")
PADDING = re.compile(r"[ \t]*(?:\n[ \t]*)?")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
QUOTE = r"(?: {0,3}>[ \t]?)*"
REFERENCE = re.compile(r"^" + QUOTE + r" {0,3}\[(?:" + ESCAPED + r"|[^\[\]\n])+\]:[ \t]*", re.M)
TITLE = re.compile(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|\((?:\\.|[^()\\])*\)')
INLINE = re.compile(ESCAPED + r"|[\[\]]|\n[ \t]*\n")
CODE = re.compile(ESCAPED + r"|(?<!`)`+|<!--")
AUTOLINK = re.compile(
    r"<(?P<angle>https?://[^\s<>]+)>|"
    r"(?<![^\s(*_~|])(?P<bare>https?://(?:github\.com|raw\.github(?:usercontent)?\.com)/[^\s<>\[\]\"']+)",
    re.I,
)
SEPARATOR = re.compile(r"\n[ \t]*\n")


def mask(text):
    return re.sub(r"[^\n]", " ", text)


def markdown_text(source):
    """Remove literal blocks, code spans and comments without moving line offsets."""
    blocks = []
    fence = None
    indented = False
    blank = True
    comment = False
    for line in source.splitlines(keepends=True):
        body = re.sub(r"^" + QUOTE, "", line).rstrip("\r\n")
        mark = FENCE.match(body)
        if comment or (not fence and body.lstrip().startswith("<!--")):
            close = line.find("-->")
            comment = close < 0
            blocks.append(mask(line) if comment else mask(line[:close + 3]) + line[close + 3:])
            blank = False
            continue
        if fence:
            blocks.append(mask(line))
            if mark and mark[1][0] == fence[0] and len(mark[1]) >= len(fence) and not mark[2].strip():
                fence = None
            continue
        if mark and (mark[1][0] == "~" or "`" not in mark[2]):
            fence = mark[1]
            blocks.append(mask(line))
        elif (blank or indented) and body.startswith(("    ", "\t")):
            indented = True
            blocks.append(mask(line))
        else:
            if body.strip():
                indented = False
            blocks.append(line)
        blank = not body.strip()
    text = "".join(blocks)
    parts, cursor, scan = [], 0, 0
    while match := CODE.search(text, scan):
        scan = match.end()
        token = match[0]
        if match[1]:
            continue
        if token == "<!--":
            close = text.find("-->", scan)
            end = len(text) if close < 0 else close + 3
        else:
            paragraph = SEPARATOR.search(text, scan)
            finish = paragraph.start() if paragraph else len(text)
            closing = re.compile(r"(?<!`)" + token + r"(?!`)").search(text, scan, finish)
            if not closing:
                continue
            end = closing.end()
        parts.extend((text[cursor:match.start()], mask(text[match.start():end])))
        cursor = scan = end
    return "".join((*parts, text[cursor:]))


def destination(text, start):
    """Return the URL and end offset for one Markdown link destination."""
    start = PADDING.match(text, start).end()
    if text[start:start + 1] == "<":
        end = start + 1
        while end < len(text) and text[end] not in "\n<>":
            escape = BACKSLASH.match(text, end)
            end = escape.end() if escape else end + 1
        if text[end:end + 1] == ">":
            return text[start + 1:end], end + 1
        return "", start
    end, depth = start, 0
    while end < len(text):
        char = text[end]
        if char.isspace() or (char == ")" and depth == 0):
            break
        escape = BACKSLASH.match(text, end)
        if escape:
            end = escape.end()
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        end += 1
    return (text[start:end], end) if not depth else ("", start)


def with_title(text, end, closing):
    padding = PADDING if closing else HORIZONTAL
    position = padding.match(text, end).end()
    title = TITLE.match(text, position) if position > end else None
    if title and not SEPARATOR.search(title[0]):
        position = padding.match(text, title.end()).end()
    if closing:
        return position + 1 if text[position:position + 1] == ")" else None
    return position if text[position:position + 1] in ("", "\n", "\r") else None


SRCSET_URL = re.compile(r"[ \t\n\f\r,]*([^ \t\n\f\r]+)")
SRCSET_DESCRIPTORS = re.compile(r"(?:\([^)]*\)|[^,(])*(?:,|$)")


def srcset_urls(value):
    """Read candidate URLs without splitting on commas inside the URL."""
    offset = 0
    while match := SRCSET_URL.match(value, offset):
        url = match[1]
        yield url.rstrip(",")
        offset = match.end()
        if not url.endswith(","):
            descriptors = SRCSET_DESCRIPTORS.match(value, offset)
            if not descriptors:
                break
            offset = descriptors.end()


class MarkupLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        line, _ = self.getpos()
        for key, value in attrs:
            if not value:
                continue
            if key in {"href", "src"} or (tag == "video" and key == "poster"):
                self.links.append((line, value))
            elif tag in {"img", "source"} and key == "srcset":
                self.links.extend((line, url) for url in srcset_urls(value))


def links(source, markdown):
    if markdown:
        source = markdown_text(source)
        for match in REFERENCE.finditer(source):
            target, end = destination(source, match.end())
            if target and with_title(source, end, closing=False) is not None:
                yield source.count("\n", 0, match.start()) + 1, target
        cursor, depth = 0, 0
        while match := INLINE.search(source, cursor):
            cursor = match.end()
            token = match[0]
            if token == "[":
                depth += 1
            elif token == "]" and depth:
                depth -= 1
                if source[cursor:cursor + 1] == "(":
                    target, end = destination(source, cursor + 1)
                    if target and (closing := with_title(source, end, closing=True)) is not None:
                        yield source.count("\n", 0, match.start()) + 1, target
                        cursor = closing
            elif token.startswith("\n"):
                depth = 0
        for match in AUTOLINK.finditer(source):
            target = match["angle"] or match["bare"].rstrip(".,;:!?")
            if match["bare"]:
                while target.endswith(")") and target.count(")") > target.count("("):
                    target = target[:-1]
            yield source.count("\n", 0, match.start()) + 1, target
    markup = MarkupLinks()
    markup.feed(source)
    markup.close()
    yield from markup.links


def repo_slug(value):
    if value.startswith("git@github.com:"):
        value = value.split(":", 1)[1]
    elif "://" in value:
        try:
            address = urlsplit(value)
        except ValueError:
            return ""
        if address.hostname != "github.com":
            return ""
        value = address.path
    value = value.strip("/").removesuffix(".git")
    return value.casefold() if re.fullmatch(r"[\w.-]+/[\w.-]+", value) else ""


def git(*args, **kwargs):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, **kwargs)


def retired_target(document, target, repositories, refs):
    spelling = unescape(BACKSLASH.sub(r"\1", target)).strip()
    try:
        url = urlsplit(spelling)
    except ValueError:
        return None
    if url.netloc:
        if url.scheme not in {"", "http", "https"}:
            return None
        path = url.path.strip("/").split("/", 2)
        if len(path) != 3 or repo_slug(unquote("/".join(path[:2]))) not in repositories:
            return None
        tail = path[2]
        if url.hostname == "github.com":
            operation, _, tail = tail.partition("/")
            if operation not in {"blob", "tree", "raw", "blame"}:
                return None
        elif url.hostname not in {"raw.githubusercontent.com", "raw.github.com"}:
            return None
        for ref in refs:
            if tail.startswith(ref + "/"):
                tail = tail[len(ref) + 1:]
                break
        else:
            for prefix in ("refs/heads/", "refs/tags/"):
                if tail.startswith(prefix):
                    tail = tail[len(prefix):]
                    break
            tail = tail.partition("/")[2]
        path = "/" + unquote(tail)
    elif url.scheme or not url.path:
        return None
    else:
        path = unquote(url.path)
        if not path.startswith("/"):
            path = "/" + posixpath.join(posixpath.dirname(document), path)
    path = posixpath.normpath("/" + path.lstrip("/")).lstrip("/")
    folded = path.casefold()
    if any(folded == directory or folded.startswith(directory + "/") for directory in RETIRED_DIRS):
        return path
    if RETIRED_FILES.fullmatch(folded):
        return path
    return None


def documentation(path):
    suffix = Path(path).suffix.casefold()
    return suffix in {".md", ".markdown"} or (path.startswith("docs/") and suffix in {".html", ".htm"})


def sources(mode):
    indexed = {}
    for record in git("ls-files", "--stage", "-z", check=True).stdout.split(b"\0"):
        if not record:
            continue
        metadata, filename = record.split(b"\t", 1)
        mode_bits, digest, stage = metadata.decode().split()
        path = filename.decode()
        if documentation(path) and mode_bits in {"100644", "100755"}:
            if stage != "0":
                raise SystemExit(f"retired-doc-links: unresolved index entry {path}")
            indexed[path] = digest
    if mode == "index":
        blobs = git("cat-file", "--batch", input="".join(h + "\n" for h in indexed.values()).encode(), check=True)
        data = BytesIO(blobs.stdout)
        for path, digest in indexed.items():
            actual, kind, size = data.readline().decode().split()
            if actual != digest or kind != "blob":
                raise SystemExit(f"retired-doc-links: invalid Git blob for {path}")
            yield path, data.read(int(size)).decode()
            data.read(1)
        return
    if mode == "worktree":
        for filename in git("ls-files", "--others", "--exclude-standard", "-z", check=True).stdout.split(b"\0"):
            path = filename.decode()
            if documentation(path):
                indexed.setdefault(path, None)
    for path in sorted(indexed):
        file = ROOT / path
        if file.is_file() and not file.is_symlink() and file.resolve().is_relative_to(ROOT):
            yield path, file.read_text(encoding="utf-8")


def controls():
    bad = r"""[inline](../%72eviews/board.md#old "title")
![image](<../research/copper (old).png>)
[ref][old]
[old]: ../handoff/work.md#status
<a href="../CHECKLIST.md?old=yes">old</a>
<img
 src='/docs/butter-design/image.svg'>
<source srcset="images/light.svg 1x, ../reviews/dark.svg 2x, images/dense.svg 3x">
<video poster="../research/tour.png"></video>
<https://github.com/YutingXu/waffle-eda/blob/main/PARITY-panel.md#list>
[old repo](https://raw.githubusercontent.com/YutingXu/Atrium/old%2Fbranch/reviews/x.md)
[slash branch](https://github.com/YutingXu/waffle-eda/tree/topic/notes/research)
[escaped](../research/board\(rev\).md)
[multi line](
    ../ROADMAP.md
    "Old roadmap"
)
[entity](../&#x68;andoff/notes.md)
See https://raw.github.com/YutingXu/Atrium/refs/heads/main/MARKET_RESEARCH.md.
<!--
```
-->
[after a comment](../reviews/after-comment.md)
"""
    good = r"""[anchor](#research/example)
[public](../HANDOFF.md)
[manifest](../parity.json), [poster](../roadmap.svg), [data](../CHECKLIST.csv)
<source srcset="data:image/svg+xml,/reviews/not-a-link.svg 1x, images/dense.svg 2x">
<video poster="../roadmap.svg"></video>
[nested name](reviews/example.md)
[old prose](https://github.com/another-owner/another-repo/blob/main/research/keep.md)
[ordinary path](../docs/ui-library/research/file.md)
\[escaped opening](/reviews/bad.md)
`[inline literal](../reviews/x.md)`
<!-- <img src="/research/example.png"> -->

```md
[fenced](../reviews/old.md)
```

    [indented](../reviews/old.md)
"""
    refs = ("topic/notes",)

    def findings(text):
        return [path for _, target in links(text, True)
                if (path := retired_target("docs/example.md", target, REPOSITORIES, refs)) is not None]
    expected = {
        "reviews/board.md", "research/copper (old).png", "handoff/work.md", "CHECKLIST.md",
        "docs/butter-design/image.svg", "PARITY-panel.md", "reviews/x.md", "research",
        "reviews/dark.svg", "research/tour.png",
        "research/board(rev).md", "ROADMAP.md", "handoff/notes.md", "MARKET_RESEARCH.md", "reviews/after-comment.md",
    }
    if set(findings(bad)) != expected or findings(good):
        raise SystemExit(f"retired-doc-links: rejecting controls differ by {set(findings(bad)) ^ expected}, accepted controls flagged {findings(good)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--index", action="store_const", const="index", dest="mode", help="read staged documentation")
    mode.add_argument("--worktree", action="store_const", const="worktree", dest="mode", help="include nonignored untracked docs in a fresh export")
    parser.add_argument("--repository", action="append", default=[], metavar="OWNER/REPO", help="also treat this GitHub slug as this repository")
    parser.add_argument("--self-test", action="store_true", help="run only the fixture controls")
    options = parser.parse_args()
    controls()
    if options.self_test:
        print("retired-doc-links: accepted local documentation and rejected restored link controls")
        return
    origin = git("config", "--get", "remote.origin.url", text=True).stdout.strip()
    repositories = REPOSITORIES | {repo_slug(value) for value in (
        origin, os.environ.get("GITHUB_REPOSITORY", ""), *options.repository)} - {""}
    refs = []
    for name in git("for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes",
                    text=True, check=True).stdout.splitlines():
        parts = name.split("/", 3)
        refs.extend((name, parts[3] if parts[1] == "remotes" else "/".join(parts[2:])))
    refs.sort(key=len, reverse=True)
    documents = 0
    failed = False
    for name, content in sources(options.mode):
        documents += 1
        findings = {(line, removed) for line, target in links(content, Path(name).suffix.casefold() in {".md", ".markdown"})
                    if (removed := retired_target(name, target, repositories, refs)) is not None}
        for line, removed in sorted(findings):
            print(f"{name}:{line}: retired documentation target {removed!r}")
            failed = True
    if not documents:
        raise SystemExit("retired-doc-links: no tracked documentation; use --worktree on a fresh export")
    if failed:
        raise SystemExit(1)
    print(f"retired-doc-links: checked {documents} documentation files")


if __name__ == "__main__":
    main()

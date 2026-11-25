#!/usr/bin/env python3
"""Render a Waffle project or engineering change order for Git textconv."""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path


sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
from obsolete_project import LIMIT, ObsoleteProject, reject  # noqa: E402


class NumberToken(str):
    """Keep the original numeric precision, including values in extension fields."""


def literal(value):
    if isinstance(value, NumberToken):
        return str(value)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def reject_constant(token):
    raise ValueError("invalid JSON number " + token)


def distinct_keys(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate JSON keys")
    return result


def field(path, key):
    if re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", key):
        return path + "." + key
    return path + "[" + literal(key) + "]"


def walk(value, path, context, collection=""):
    if isinstance(value, dict) and value:
        for key in sorted(value):
            yield from walk(value[key], field(path, key), context, key)
    elif isinstance(value, list) and value:
        if len(value) <= 8 and all(not isinstance(v, (dict, list)) for v in value):
            yield context, path + " = [" + ", ".join(map(literal, value)) + "]"
            return
        for index, item in enumerate(value):
            tag = str(index)
            heading = None
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                tag = "id=" + literal(item["id"])
                name = item.get("ref") or item.get("name")
                kind = item.get("kind")
                label = kind if isinstance(kind, str) and re.fullmatch(r"[A-Za-z_]+", kind) else collection
                heading = label + " " + tag
                if name is not None:
                    heading += " " + literal(name)
            elif collection == "rows" and isinstance(item, dict) and "targetId" in item:
                # The target, field and pad identify a board change for review.
                # Keep the full identity (source, sheet and link) as normal fields too.
                tag = ", ".join(k + "=" + literal(item[k]) for k in ("targetId", "field", "pin") if k in item)
                heading = "ECO " + tag
            title = context
            if heading:
                title = context + " / " + heading
            yield from walk(item, path + "[" + tag + "]", title)
    else:
        yield context, path + " = " + literal(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    with args.file.open("rb") as stream:
        prefix = stream.read(LIMIT)
        try:
            reject(prefix, args.file.name)
        except ObsoleteProject as error:
            sys.exit(str(error))
        stream.seek(0)
        # Native members are already canonical one-record-per-line text. Only the
        # independently versioned engineering change order needs a structured view.
        if not re.search(rb'"format"\s*:\s*"atrium-eco"', prefix):
            shutil.copyfileobj(stream, sys.stdout.buffer)
            return
        data = stream.read()
    try:
        doc = json.loads(data, parse_int=NumberToken, parse_float=NumberToken, object_pairs_hook=distinct_keys,
                         parse_constant=reject_constant)
        if not isinstance(doc, dict) or doc.get("format") != "atrium-eco":
            raise ValueError("unknown format")
    except (ValueError, UnicodeDecodeError):
        # A merge conflict, duplicate key or unknown format must still be visible.
        sys.stdout.buffer.write(data)
        return
    root = "ECO"
    output = sys.stdout.buffer
    section = None
    for title, line in walk(doc, root, root):
        if title != section:
            output.write(("@ " + title + "\n").encode("utf-8", errors="backslashreplace"))
            section = title
        output.write((line + "\n").encode("utf-8", errors="backslashreplace"))


if __name__ == "__main__":
    main()

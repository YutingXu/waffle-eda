#!/usr/bin/env python3
"""Copy the four pinned public Sofle legacy sheets and their libraries into an empty directory for Eeschema."""
import argparse
import os
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
from fixtures import History, KICAD, external


def make_cache(files):
    # A legacy nickname must qualify a cache symbol. Its original drawing and pin records are retained byte for byte.
    keys = set(re.findall(rb'^L (\S+) ', files['SofleKeyboard.sch'], re.M))
    definitions = {}
    for name in ('SofleKeyboard', 'SofleKeyboard-rescue'):
        for m in re.finditer(rb'^(DEF (\S+) .*?^ENDDEF)\r?$', files[name + '.lib'], re.M | re.S):
            key = name.encode() + b':' + m[2]
            if key in definitions:
                raise ValueError('Ambiguous legacy symbol definition.')
            definitions[key] = m[1]
    output = [b'EESchema-LIBRARY Version 2.4', b'#encoding utf-8']
    for key in sorted(keys):
        old = definitions[key]; nickname, short = key.split(b':', 1)
        qualified = nickname + b'_' + short
        block = old.replace(b'DEF ' + short + b' ', b'DEF ' + qualified + b' ', 1)
        block = re.sub(rb'^F1 "' + re.escape(short) + b'"', b'F1 "' + qualified + b'"', block, count=1, flags=re.M)
        if b'ALIAS ' in block or block.partition(b'\nDRAW')[2] != old.partition(b'\nDRAW')[2]:
            raise ValueError('The legacy cache could not preserve the source drawing.')
        output.extend([b'#', b'# ' + qualified, b'#', block])
    return b'\n'.join([*output, b'#', b'#End Library', b''])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--history-cache', type=Path, default=Path.home() / '.cache/waffle/project-history')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    dest = external(args.output)
    dest.mkdir(parents=True, exist_ok=True)
    if any(dest.iterdir()):
        parser.error('Choose an empty scratch directory for the public Eeschema inputs.')
    reader = History(args.history_cache / 'sofle')
    for name in ('sofle-rgb', 'sofle-v1'):
        _, head, current, previous, old = KICAD[name]
        for folder, rev, stem in [(name, head, current), (name + '-previous', reader.revision(previous), old)]:
            tree = reader.tree(rev)
            base = stem.rsplit('/', 1)[0] + '/'
            files = {key: reader.bytes(tree[base + key]) for key in ('SofleKeyboard.sch', 'SofleKeyboard.pro', 'sym-lib-table',
                     'SofleKeyboard.lib', 'SofleKeyboard-rescue.lib', 'SofleKeyboard-cache.lib') if base + key in tree}
            if 'SofleKeyboard-cache.lib' not in files:
                files['SofleKeyboard-cache.lib'] = make_cache(files)
            target = dest / folder; target.mkdir()
            for key, value in files.items():
                (target / key).write_bytes(value)
            print(folder, rev[:12], 'ready for Eeschema')


if __name__ == '__main__':
    main()

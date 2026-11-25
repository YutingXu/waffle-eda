#!/usr/bin/env python3
"""Check real exported Altium copies against an independent OLE reader and binary records.

Requires olefile 0.47 (Python), Node and LinkeDOM for the optional export driver.
Run: python3 tests/formats/altium-copy-interop.py --fixtures DIR --node /path/to/node --dom /path/to/linkedom.mjs
Or:  python3 tests/formats/altium-copy-interop.py --fixtures DIR --copies DIR
The two public fixture names and SHA-256 values below pin the assertions.
"""
import argparse
from collections import Counter
import hashlib
import os
import re
import shutil
from pathlib import Path
import struct
import subprocess
import tempfile

import olefile


SCHEMATIC = 'Level.Shifter.SchDoc'
BOARD = 'qfsae-0.PcbDoc'
DIGESTS = {
    SCHEMATIC: 'c9b5a196a0b3f5cb6ad99f356bf0b4eefee421357c43ccf891f24c6cdb000247',
    BOARD: '54829f6aa00309d2282df48b3046edc4e483400bf756cdc4a6ca1b8af6f4d92b',
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def directory_metadata(ole):
    ole.listdir(streams=True, storages=True)  # populate all live directory entries
    fields = ('sid', 'name', 'clsid', 'entry_type', 'color', 'sid_left', 'sid_right',
              'sid_child', 'dwUserFlags', 'createTime', 'modifyTime')
    return [tuple(getattr(entry, attr) for attr in fields) for entry in ole.direntries if entry is not None]


def compare_ole(original, edited, expected_streams):
    with olefile.OleFileIO(str(original), raise_defects=olefile.DEFECT_INCORRECT) as a, \
         olefile.OleFileIO(str(edited), raise_defects=olefile.DEFECT_INCORRECT) as b:
        assert a.listdir(streams=True, storages=True) == b.listdir(streams=True, storages=True), 'Directory names or types changed'
        assert directory_metadata(a) == directory_metadata(b), 'Storage metadata or class IDs changed'
        assert not a.parsing_issues and not b.parsing_issues, 'Compound document parsing defect'
        differences = {}
        for parts in a.listdir():
            name = '/'.join(parts)
            before, after = a.openstream(parts).read(), b.openstream(parts).read()
            if before != after:
                differences[name] = (before, after)
        assert set(differences) == expected_streams, f'Unexpected changed streams: {sorted(differences)}'
        return differences, len(a.listdir())


def records(data, object_type=None):
    position = 0
    while position < len(data):
        if object_type is not None:
            assert data[position] == object_type, 'Wrong PCB primitive identifier'
            position += 1
        assert position + 4 <= len(data), 'Truncated record prefix'
        word, = struct.unpack_from('<I', data, position)
        size, flags = word & 0xffffff, word >> 24
        start = position + 4
        position = start + size
        assert size > 0 and position <= len(data), 'Invalid Altium record length'
        yield flags, data[start:position]


def check_schematic(old, new):
    changes, count = compare_ole(old, new, {'FileHeader'})
    before, after = [list(records(data)) for data in changes['FileHeader']]
    assert len(before) == len(after) == 335
    changed = [k for k,(a,b) in enumerate(zip(before,after)) if a != b]
    assert changed == [134, 162], f'Unexpected changed schematic records: {changed}'
    expected = {
        134: (b'41', b'Value', b'2.2 \xb5F', '2.2 µF'.encode('utf8')),
        162: (b'34', b'Designator', b'C1701', None),
    }
    for k,(kind,name,text,wide_text) in expected.items():
        original, replacement = before[k][1], after[k][1]
        assert before[k][0] == after[k][0] and original.endswith(b'\0') and replacement.endswith(b'\0')
        def separate(payload):
            untouched, values = [], {}
            for pair in payload[:-1].split(b'|'):
                key, _, value = pair.partition(b'=')
                if key.lower() in {b'text', b'%utf8%text'}:
                    assert key.lower() not in values
                    values[key.lower()] = value
                else:
                    untouched.append(pair)
            return untouched, values
        fields, _ = separate(original)
        same_fields, values = separate(replacement)
        assert fields == same_fields, f'Other source properties changed on record {k}'
        assert b'RECORD=' + kind in fields and b'Name=' + name in fields and b'OwnerIndex=123' in fields
        assert values[b'text'] == text
        if wide_text is not None:
            assert values[b'%utf8%text'] == wide_text
        elif b'%utf8%text' in values:
            assert values[b'%utf8%text'] == text
    return f'{count} streams, 335 records, exactly two component fields changed, both Unicode text encodings verified'


def check_board(old, new):
    changes, count = compare_ole(old, new, {'Tracks6/Data','Vias6/Data'})
    expectations = [('Tracks6/Data',4,998,497,29,100000,130000), ('Vias6/Data',3,53,0,25,280000,240000)]
    for stream, kind, total, index, offset, old_units, new_units in expectations:
        before, after = [list(records(data,kind)) for data in changes[stream]]
        assert len(before) == len(after) == total
        assert [k for k,(a,b) in enumerate(zip(before,after)) if a != b] == [index], f'Unexpected updates to {stream}'
        flags, payload = before[index]
        assert struct.unpack_from('<i',payload,offset)[0] == old_units
        expected = bytearray(payload)
        struct.pack_into('<i',expected,offset,new_units)
        assert after[index] == (flags,bytes(expected)), f'Unexpected bytes changed in {stream} record {index}'
    return f'{count} streams, 998 track and 53 via records, only track 497 width and via 0 drill changed'


def convert(checkout, directory, schematic, board):
    directory.mkdir()
    shutil.copyfile(schematic, directory / 'Board.SchDoc')
    shutil.copyfile(board, directory / 'Board.PcbDoc')
    for script in ('unpack.pl', 'convertschema.pl', 'convertpcb.pl'):
        process = subprocess.run(
            ['perl', str(checkout.resolve() / script)], cwd=directory,
            capture_output=True, timeout=60,
        )
        if process.returncode:
            diagnostic = process.stderr[-1500:].decode(errors='replace')
            raise RuntimeError(f'{script} exited {process.returncode}: {diagnostic}')
    schematic_text = (directory / 'Board-SchDoc.sch').read_text(encoding='utf8')
    layout_text = (directory / 'Board-PcbDoc.kicad_pcb').read_text(encoding='utf8', errors='replace')
    copper = Counter(
        line.strip() for line in layout_text.splitlines()
        if line.strip().startswith(('(via ', '(segment '))
    )
    return schematic_text, copper


def component_fields(schematic):
    result = {}
    for block in re.findall(r'^\$Comp\n(.*?)^\$EndComp$', schematic, flags=re.M | re.S):
        ref = re.search(r'^F 0 "([^"]+)"', block, re.M).group(1)
        value = re.search(r'^F 1 "([^"]+)"', block, re.M).group(1)
        assert ref not in result
        result[ref] = value
    return result


def converter_readback(checkout, original, edited, work):
    # Optional upstream reader: https://github.com/thesourcerer8/altium2kicad
    # Verified with e7be475c364ede8faf9e9e9efb95c18e9243b3ba.
    before, old_copper = convert(checkout, work / 'before', original / SCHEMATIC, original / BOARD)
    after, new_copper = convert(checkout, work / 'after', edited / 'Edited.SchDoc', edited / 'Edited.PcbDoc')
    expected = component_fields(before)
    assert len(expected) == 10 and expected.pop('C17') == '1 µF'
    expected['C1701'] = '2.2 µF'
    assert component_fields(after) == expected

    removed = list((old_copper - new_copper).elements())
    added = list((new_copper - old_copper).elements())
    assert len(removed) == len(added) == 2 and sum(old_copper.values()) == 695
    via = next(line for line in removed if line.startswith('(via '))
    track = next(line for line in removed if line.startswith('(segment '))
    assert '(drill 0.7112)' in via and '(width 0.254)' in track
    assert set(added) == {
        via.replace('(drill 0.7112)', '(drill 0.6096)'),
        track.replace('(width 0.254)', '(width 0.3302)'),
    }
    print('PASS Altium2KiCad independently unpacked and converted both files: '
          'ten symbols (five components and five power symbols) and 695 copper primitives checked')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', required=True, type=Path)
    parser.add_argument('--copies', type=Path, help='Existing files named Edited.SchDoc and Edited.PcbDoc')
    parser.add_argument('--node', default=os.environ.get('NODE', 'node'))
    parser.add_argument('--dom', type=Path, help='Standalone LinkeDOM module for UI export')
    parser.add_argument('--altium2kicad', type=Path, help='Checkout of thesourcerer8/altium2kicad for independent conversion')
    args = parser.parse_args()
    if not __debug__:
        parser.error('Run with Python assertions enabled')
    for name, sha in DIGESTS.items():
        assert digest(args.fixtures / name) == sha, f'Fixture digest mismatch: {name}'
    with tempfile.TemporaryDirectory(prefix='atrium-interop-') as temp:
        copies = args.copies or Path(temp)
        if not args.copies:
            driver = Path(__file__).resolve().with_name('source-copy-ui.cjs')
            command = [args.node, str(driver), '--fixtures', str(args.fixtures.resolve()), '--output-dir', str(copies)]
            if args.dom:
                command.extend(['--dom', str(args.dom.resolve())])
            subprocess.run(command, check=True)
        print('PASS independent SchDoc verification: ' + check_schematic(args.fixtures / SCHEMATIC, copies / 'Edited.SchDoc'))
        print('PASS independent PcbDoc verification: ' + check_board(args.fixtures / BOARD, copies / 'Edited.PcbDoc'))
        if args.altium2kicad:
            converter_readback(args.altium2kicad, args.fixtures, copies, Path(temp))
    for name, sha in DIGESTS.items():
        assert digest(args.fixtures / name) == sha, f'Original file changed: {name}'


if __name__ == '__main__':
    main()

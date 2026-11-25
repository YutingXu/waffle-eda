#!/usr/bin/env python3
"""Summarize completed native tours without printing design-derived strings or local paths."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('results', nargs='+', type=Path)
    parser.add_argument('--frames', action='store_true', help='Include every >100 ms interval and all boundary actions')
    args = parser.parse_args()
    frames, events = defaultdict(list), Counter()
    worker_counts, native_counts = Counter(), Counter()
    report_files = sorted({f for folder in args.results for f in folder.glob('*/run/tour.json')})
    if not report_files:
        parser.error('No native tour reports found.')
    print('| Design | Theme | Result | Sheets / boards | ERC errors / warnings | DRC | Insights | ZIP members | Changes by revision | Edits / undo / redo | Frames >100 ms |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    for file in report_files:
        r = json.loads(file.read_bytes()); name, theme = r['design'], r['theme']
        if not re.fullmatch('[a-z0-9-]+', name) or theme not in ('light', 'dark'):
            raise ValueError('Unexpected run identifier.')
        t = r['trace']; erc = r.get('erc'); outcome = 'pass' if r['passed'] and all(r.get('privateChecks', {}).values()) else 'findings'
        comparisons = ', '.join(str(c['rows']) for c in r['comparisons'])
        members = ', '.join(str(o['files']) for o in r['output'])
        drc = ', '.join(map(str, r['drc']))
        print(f"| {name} | {theme} | {outcome} | {r['sheets']} / {r['boards']} | "
              f"{str(erc['errors']) + ' / ' + str(erc['warnings']) if erc else '—'} | {drc} | {r.get('insights', '—')} | {members} | "
              f"{comparisons} | {r['edits']} / {r['undos']} / {r['redos']} | {len(t['over100'])} |")
        for entry in t['over100']:
            boundary = tuple(entry['actions'])
            if not all(re.fullmatch('[A-Za-z0-9-]+', part) for part in boundary):
                raise ValueError('Unexpected action identifier.')
            frames[name, theme, boundary].append(entry['ms'])
        for event in t['events']:
            events[event['type']] += 1
        worker_counts.update(t.get('workers', {}))
        if 'webKitConsole' in r:
            mirror = r['webKitConsole']
            native_counts['public console enabled'] += int(mirror['available'])
            native_counts['WebKit console entries'] += len(mirror['entries'])
        native_counts['stderr lines'] += r.get('nativeDiagnostics', {}).get('lines', 0)
        native_counts['unexpected interface strings'] += len(r['issueStrings'])
    print('\nPage observations', dict(sorted(events.items())))
    print('Worker coverage', dict(sorted(worker_counts.items())))
    print('Native and UI observations', dict(sorted(native_counts.items())))
    print('Intervals over 100 ms', sum(map(len, frames.values())))
    if args.frames:
        print('\n| Design | Theme | Action boundaries | Intervals in ms |\n|---|---|---|---|')
        for (name, theme, boundary), values in sorted(frames.items()):
            print('|', name, '|', theme, '|', ' → '.join(boundary), '|', ', '.join(map(str, values)), '|')


if __name__ == '__main__':
    main()

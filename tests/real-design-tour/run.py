#!/usr/bin/env python3
"""Tour licensed cached designs in the shipping macOS WKWebView; report only outside any checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
from fixtures import ROOT, HERE, KICAD, History, external, fidelity, payload


def fingerprint(root, paths):
    digest = hashlib.sha256()
    for path in sorted(paths):
        if path.is_file():
            digest.update(path.relative_to(root).as_posix().encode() + b'\0')
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def build_receipt(app, fresh):
    resources = app / 'Contents/Resources'
    sources = [*ROOT.joinpath('app').rglob('*'), ROOT / 'native/bridge.js', ROOT / 'native/git_head.py']
    runtime = fingerprint(ROOT, sources)
    for source in sources:
        if source.is_file():
            rel = source.relative_to(ROOT)
            installed = resources / ('bridge.js' if str(rel) == 'native/bridge.js' else rel)
            if not installed.is_file() or installed.read_bytes() != source.read_bytes():
                raise ValueError('The harness resources differ from this product checkout. Rebuild it.')
    native = fingerprint(ROOT, [*ROOT.joinpath('native/macos').glob('*.swift'), ROOT / 'native/macos/Info.plist',
                                *ROOT.joinpath('native/tests/macos-harness').glob('*.swift'), ROOT / 'native/tests/macos-harness/build.sh'])
    receipt = {'runtimeSHA256': runtime, 'nativeSourcesSHA256': native,
               'executableSHA256': hashlib.sha256((app / 'Contents/MacOS/Waffle').read_bytes()).hexdigest()}
    record = app.parent / 'tour-build.json'
    if fresh:
        record.write_text(json.dumps(receipt))
    elif not record.is_file() or json.loads(record.read_text()) != receipt:
        raise ValueError('This harness has no matching build receipt. Omit --app to build from this checkout.')
    commit = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', '--verify', 'HEAD'], capture_output=True)
    return {**receipt, 'productCheckout': commit.stdout.decode().strip() if commit.returncode == 0 else None,
            'os': platform.mac_ver()[0], 'architecture': platform.machine(),
            'observersSHA256': fingerprint(HERE, [HERE / n for n in ('tour.js', 'observe.js')])}


def private_state(repo):
    # Read only native Git receipts. Personal filenames, local modifications and Git IDs stay in memory.
    reader = History(repo)
    commands = [['rev-parse', '--verify', 'HEAD'], ['ls-files', '--stage', '-z'],
                ['ls-files', '--modified', '--others', '--exclude-standard', '-z']]
    return [hashlib.sha256(reader.read(args, 8 * 1024 * 1024)).digest() for args in commands]


def private_artifacts(output, data):
    allowed = {'inputs.json', 'native.log', 'run/phase.txt', 'run/tour.json', 'run/libs/parts.atrlib',
               'run/libs/linked.atrlib', 'run/outside/secret.json', 'run/support/library-sources.json'}
    names = {f['name'].casefold().encode() for files in [data['current'], *(p['files'] for p in data['previous'])] for f in files}
    for path in output.rglob('*'):
        if path.is_dir() and not path.is_symlink():
            continue
        if path.relative_to(output).as_posix() not in allowed:
            return False
        if not path.is_symlink():
            contents = path.read_bytes().lower()
            if any(name in contents for name in names):
                return False
    return True


def main():
    cache = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'waffle'
    public = [p['id'] for p in fidelity.manifest()] + list(KICAD)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--history-cache', type=Path, default=cache / 'project-history')
    parser.add_argument('--fidelity-cache', type=Path, default=fidelity.DEFAULT_CACHE)
    parser.add_argument('--approved-repo', type=Path, help='Explicit read-only private repository with one top-level Altium project')
    parser.add_argument('--converted-dir', type=Path, help='Public Sofle sheets upgraded by KiCad; see the tour report')
    parser.add_argument('--design', choices=[*public, 'approved'], action='append')
    parser.add_argument('--theme', choices=['light', 'dark'], required=True)
    parser.add_argument('--capture', action='store_true', help='Take public schematic and board screenshots')
    parser.add_argument('--inventory', action='store_true', help='Verify input bytes and report source counts without launching the app')
    parser.add_argument('--app', type=Path, help='Reuse a WaffleHarness.app just built from the intended product checkout')
    parser.add_argument('--keep-app', action='store_true', help='Keep the newly built app for a second theme')
    args = parser.parse_args()
    chosen = args.design or (public + (['approved'] if args.approved_repo else []))
    if 'approved' in chosen and not args.approved_repo:
        parser.error('The approved design requires --approved-repo.')
    os.umask(0o077); dest = external(args.output); dest.mkdir(parents=True, exist_ok=True)
    temporary = None; app = args.app
    if not args.inventory and not app:
        if sys.platform != 'darwin':
            parser.error('The native tour requires macOS with Swift and WebKit.')
        install = Path.home() / 'Library' / 'Caches'; install.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix='waffle-tour-', dir=install))
        with tempfile.TemporaryDirectory(prefix='waffle-tour-build-') as build:
            subprocess.run(['zsh', str(ROOT / 'native/tests/macos-harness/build.sh')], check=True,
                           env={**os.environ, 'HARNESS_OUT': build, 'HARNESS_INSTALL': str(temporary / 'installed')}, stdout=subprocess.DEVNULL)
        app = temporary / 'installed/WaffleHarness.app'
        if args.keep_app:
            print('Reusable harness:', app, flush=True)
    failures = 0
    try:
        if not args.inventory:
            provenance = build_receipt(app, bool(temporary))
            (dest / ('runtime-' + args.theme + '.json')).write_text(json.dumps(provenance, indent=2))
        for name in chosen:
            output = dest / (name + '-' + args.theme)
            try:
                private_before = private_state(args.approved_repo) if name == 'approved' else None
                data = payload(name, args)
                sources = data['current']; history = [{k: v for k, v in p.items() if k != 'files'} for p in data['previous']]
                summary = {'design': name, 'selected': len(sources), 'legacy': bool(data['original']), 'comparisons': history}
                if not data['private']:
                    summary['revision'] = data['revision']
                    if data['conversion']:
                        summary['conversion'] = data['conversion']
                if args.inventory:
                    print(json.dumps(summary), flush=True); continue
                output.mkdir(exist_ok=False)
                (output / 'inputs.json').write_text(json.dumps(summary, indent=2))
                env = {**os.environ, 'HARNESS_SUITE': 'ui', 'HARNESS_EPHEMERAL': '1', 'HARNESS_INPUT_STDIN': '1',
                       'HARNESS_TOUR_PUBLIC_WEB_DATA': '0' if data['private'] else '1', 'HARNESS_PROBES': str(HERE / 'tour.js'), 'HARNESS_EARLY_PROBE': str(HERE / 'observe.js'), 'HARNESS_WORK': str(output / 'run')}
                result = subprocess.run([str(app / 'Contents/MacOS/Waffle')], input=json.dumps(data).encode(),
                                        env=env, capture_output=True, timeout=600)
                web_data = output / 'run/public-web-data'
                if not data['private'] and web_data.is_dir():
                    shutil.rmtree(web_data)
                result_file = output / 'run/tour.json'
                lines = result.stdout.decode(errors='replace').splitlines()
                # Keep raw public native output external. For private input restrict native logs to non-identifying harness metadata.
                if data['private']:
                    lines = [line for line in lines if line.startswith(('RESULT ', 'NOTE  WebKit.framework', 'PASS  Real design tour', 'FAIL  Real design tour'))]
                else:
                    (output / 'native-stderr.log').write_bytes(result.stderr)
                (output / 'native.log').write_text('\n'.join(lines) + '\n')
                report = json.loads(result_file.read_text()) if result_file.exists() else {}
                if report:
                    stderr = result.stderr.decode(errors='replace').splitlines()
                    report['nativeDiagnostics'] = {'lines': len(stderr), 'warnings': sum(bool(re.search('warn', s, re.I)) for s in stderr),
                                                   'errors': sum(bool(re.search('error|exception|fault', s, re.I)) for s in stderr)}
                    if data['private']:
                        report['privateChecks'] = {'repoStateUnchanged': private_before == private_state(args.approved_repo),
                                                   'onlyExpectedArtifactsAndNoSourceNames': private_artifacts(output, data)}
                    result_file.write_text(json.dumps(report, indent=2))
                passed = report.get('passed') and all(report.get('privateChecks', {}).values()) and result.returncode == 0 and 'RESULT ok' in lines
                print(name, args.theme, 'PASS' if passed else 'FAIL', 'frames >100 ms', len(report.get('trace', {}).get('over100', [])),
                      'events', len(report.get('trace', {}).get('events', [])), report.get('failure', {}).get('action', '') or
                      ', '.join(report.get('findings', [])), flush=True)
                failures += not passed
            except Exception as error:
                # A private Git reader or OS failure can include its repository path in its exception message.
                print(name, type(error).__name__, '' if name == 'approved' else str(error), flush=True)
                failures += 1
    finally:
        if temporary and not args.keep_app:
            shutil.rmtree(temporary)
    return int(bool(failures))


if __name__ == '__main__':
    sys.exit(main())

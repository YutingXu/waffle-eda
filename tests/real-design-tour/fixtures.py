"""Read pinned design inputs. Binary files stay in memory, including private Git blobs."""
import base64
from collections import Counter
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import sys
import time
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / 'tests' / 'altium-fidelity'))
import fetch as fidelity
sys.path.insert(0, str(ROOT / 'native'))
import git_head

KICAD = {
    'sofle-rgb': ('sofle', 'fb294f7c58d0f91c379a9ef339159d4d056643e9', 'Sofle_RGB/PCB/SofleKeyboard', 'b717211a^1', 'Sofle_RGB/PCB/SofleKeyboard'),
    'sofle-v1': ('sofle', 'fb294f7c58d0f91c379a9ef339159d4d056643e9', 'Sofle_v1/PCB/SofleKeyboard', '76c9cc2^1', 'PCB/SofleKeyboard'),
    'lily58': ('lily58', '58c649797c185b7b32b9928d4546665153cfacfd', 'Lite_Rev3/Lily58_Lite_Rev3', '5c68a04^1', 'Lite_Rev3/Lily58_Lite_Rev3'),
    'corne': ('corne', '1747b2623b018a7b5acc6d1f7e316debad96a727', 'pcbs/corne-cherry/hotswap/corne-cherry', 'af817cc^1', 'pcbs/corne-cherry/hotswap/corne-cherry'),
}
# In these two histories a previous released board or sheet actually differs from the pinned design.
OLDER_ALTIUM = {'snes-tap': 'dcf78f5', 'esp32c3-haptic': 'f8aa496'}
DESIGN_EXT = {'.schdoc', '.pcbdoc', '.schlib', '.pcblib'}


def sha(data):
    return hashlib.sha256(data).hexdigest()

def external(path):
    path = path.expanduser().resolve()
    if any((ancestor / '.git').exists() for ancestor in (path, *path.parents)):
        raise ValueError('Choose a scratch directory outside all Git checkouts.')
    return path


class History:
    """Use the desktop's allowlisted, no-filters/no-network native Git reader throughout."""
    def __init__(self, directory):
        self.host = git_head._repository(repo=directory)

    def read(self, args, limit=8192):
        self.host.until = time.monotonic() + git_head.TIMEOUT
        return self.host.git(args, 'A local revision is unavailable.', max_output=limit)

    def revision(self, name):
        return self.read(['rev-parse', '--verify', name + '^{commit}']).decode().strip()

    def tree(self, rev):
        out = {}
        for row in self.read(['ls-tree', '-rz', rev], 8 * 1024 * 1024).split(b'\0'):
            if row:
                meta, name = row.split(b'\t', 1)
                mode, kind, oid = meta.split()
                if mode in (b'100644', b'100755') and kind == b'blob':
                    out[os.fsdecode(name)] = oid.decode()
        return out

    def bytes(self, oid):
        n = int(self.read(['cat-file', '-s', oid]))
        if n > git_head.MAX_BYTES:
            raise ValueError('A design blob exceeds the native comparison limit.')
        return self.read(['cat-file', 'blob', oid], n)


def checked_path(base, relative):
    value = relative.replace('\\', '/')
    path = posixpath.normpath(posixpath.join(base, value))
    if path.startswith(('../', '/')) or ':' in path or '\0' in path:
        return None
    return path


def altium_members(manifest, data, tree, flat=False):
    enc = 'utf-16' if data[:2] in (b'\xfe\xff', b'\xff\xfe') else 'utf-8-sig'
    try:
        text = data.decode(enc)
    except UnicodeError:
        text = data.decode('cp1252', errors='replace')
    files = {p.casefold(): p for p in tree}
    found, missing = [manifest], []
    in_document = True
    for line in text.splitlines():
        line = line.strip()
        if line.startswith('['):
            in_document = bool(re.fullmatch(r'\[Document\d+\]', line, re.I))
        key, _, ref = line.partition('=')
        ref = ref.strip().strip('"')
        if in_document and key.strip().lower() == 'documentpath' and PurePosixPath(ref).suffix.lower() in DESIGN_EXT:
            path = checked_path(posixpath.dirname(manifest), ref)
            if flat and path:
                path = posixpath.basename(path)
            if path and path.casefold() in files:
                found.append(files[path.casefold()])
            else:
                missing.append(PurePosixPath(ref).suffix.lower())
    return list(dict.fromkeys(found)), missing


def altium_set(reader, rev, manifest=None, archive=None):
    tree = reader.tree(rev)
    if archive:
        names = [p for p in tree if PurePosixPath(p).name == PurePosixPath(archive).name]
        if len(names) != 1:
            raise ValueError('The pinned source archive is absent or ambiguous.')
        with zipfile.ZipFile(io.BytesIO(reader.bytes(tree[names[0]]))) as z:
            names = {i.filename: i for i in z.infolist() if not i.is_dir()}
            manifest, = [n for n in names if n.lower().endswith('.prjpcb')]
            members, missing = altium_members(manifest, z.read(manifest), names)
            if sum(names[n].file_size for n in members) > git_head.MAX_BYTES:
                raise ValueError('The source package exceeds the native comparison limit.')
            return {PurePosixPath(n).name: z.read(n) for n in members}, missing
    if manifest is None:
        manifest, = [n for n in tree if '/' not in n and n.lower().endswith('.prjpcb')]
    if manifest not in tree:
        raise ValueError('The selected source manifest is absent in this revision.')
    files, missing = altium_members(manifest, reader.bytes(tree[manifest]), tree)
    names = [PurePosixPath(n).name for n in files]
    if len(set(names)) != len(names):
        raise ValueError('The source manifest requires distinct relative names.')
    return {base: reader.bytes(tree[n]) for n, base in zip(files, names)}, missing


def kicad_set(reader, rev, stem):
    tree = reader.tree(rev)
    paths = [stem + ext for ext in ('.kicad_pro', '.kicad_sch', '.sch', '.kicad_pcb') if stem + ext in tree]
    files = {}
    for path in paths:
        data = reader.bytes(tree[path]); name = PurePosixPath(path).name
        if name in files:
            raise ValueError('A selected KiCad sheet name is ambiguous.')
        files[name] = data
        if path.endswith('.kicad_sch'):
            for ref in re.findall(rb'\(property\s+"Sheet ?file"\s+"([^"\r\n]+\.kicad_sch)"', data, re.I):
                child = checked_path(posixpath.dirname(path), ref.decode())
                if child not in tree:
                    raise ValueError('A referenced child sheet is missing from the Git tree.')
                if child not in paths:
                    paths.append(child)
    return files


def signature(files):
    return {name: sha(data) for name, data in files.items()}


def verified_conversion(original, modern):
    """Verify the actual Eeschema save against every placement, independent of Waffle's reader."""
    placements = Counter()
    for component in re.findall(r'^\$Comp\n(.*?)^\$EndComp', original.decode().replace('\r\n', '\n'), re.M | re.S):
        lib, ref = re.search(r'^L (\S+) (\S+)', component, re.M).groups()
        unit = re.search(r'^U (\d+) ', component, re.M).group(1)
        placements[lib, ref, unit] += 1
    root, stack = [], []
    for t in re.findall(r'"(?:\\.|[^"\\])*"|[()]|[^\s()"]+', modern.decode()):
        if t == '(':
            node = []
            (stack[-1] if stack else root).append(node); stack.append(node)
        elif t == ')':
            stack.pop()
        else:
            stack[-1].append(json.loads(t) if t.startswith('"') else t)
    def children(node, key):
        return [c for c in node if isinstance(c, list) and c and c[0] == key]
    if stack or len(root) != 1 or root[0][0] != 'kicad_sch' or children(root[0], 'generator')[0][1] != 'eeschema':
        raise ValueError('The supplied conversion is not an Eeschema schematic.')
    doc = root[0]
    definitions = {s[1] for s in children(children(doc, 'lib_symbols')[0], 'symbol')}
    saved = Counter()
    for instance in children(doc, 'symbol'):
        lib = children(instance, 'lib_id')[0][1]
        ref, = [r[2] for r in children(instance, 'property') if r[1] == 'Reference']
        saved[lib, ref, children(instance, 'unit')[0][1]] += 1
    if not placements or saved != placements or not all(lib in definitions for lib, _, _ in saved):
        raise ValueError('The Eeschema conversion lost library IDs, references, units or embedded definitions.')
    return {'instances': sum(saved.values()), 'definitions': len(definitions)}


def public_altium(project, args):
    name, head = project['id'], project['revision']
    directory, resources = fidelity.verified(project, args.fidelity_cache, True)
    current = {f['name']: (directory / f['name']).read_bytes() for f in resources if f['role'] == 'source'}
    manifest, = [n for n in current if n.lower().endswith('.prjpcb')]
    # The cached release is flat. Read the actual manifest membership, as Finder would.
    refs, absent = altium_members(manifest, current[manifest], current, flat=True)
    current = {k: current[k] for k in refs}
    reader = History(args.history_cache / name)
    archive = next((a['path'] for a in project['assets'] if 'path' in a and any(m.get('role') == 'source' for m in a.get('members', []))), None)
    paths = reader.tree(head)
    anchor = next((path for path in paths if PurePosixPath(path).name == manifest), None)
    parent = reader.revision(head + '^1')
    tracked, _ = altium_set(reader, head, anchor, archive)
    def materialize(files):
        for n, data in list(files.items()):
            pointer = re.fullmatch(rb'version https://git-lfs.github.com/spec/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n?', data)
            if pointer:
                cached = current.get(n, b'')
                if sha(cached) != pointer[1].decode() or len(cached) != int(pointer[2]):
                    raise ValueError('The release lacks a hash-matched object for a local LFS pointer.')
                files[n] = cached
        return files
    tracked = materialize(tracked)
    different = {k for k in tracked.keys() | current.keys() if current.get(k) != tracked.get(k)}
    # The published Rev A archive has a repackaged manifest; each schematic and PCB matches its LFS OID.
    if different and not (name == 'pidp11-io-expander' and different == {manifest}):
        raise ValueError(name + ': pinned release and committed source differ.')
    if different:
        # Compare HEAD with its actual parent. The release provides the verified LFS bytes only.
        current = tracked
    before, _ = altium_set(reader, parent, anchor, archive)
    before = materialize(before)
    previous = [('parent', parent, before)]
    if name in OLDER_ALTIUM:
        old = reader.revision(OLDER_ALTIUM[name]); old_files, _ = altium_set(reader, old, anchor)
        previous.append(('prior-design', old, old_files))
    return current, previous, absent, head


def approved(args):
    reader = History(args.approved_repo)
    head = reader.revision('HEAD')
    current, missing = altium_set(reader, head)
    revisions = reader.read(['log', '--first-parent', '--format=%H', '-n', '100', head], 16384).decode().splitlines()
    parent = revisions[1]; before, _ = altium_set(reader, parent)
    previous = [('parent', parent, before)]
    if signature(before) == signature(current):
        for rev in revisions[2:]:
            try:
                older, _ = altium_set(reader, rev)
            except ValueError:
                continue
            if signature(current) != signature(older):
                previous.append(('prior-design', rev, older)); break
    return current, previous, missing, head


def payload(name, args):
    legacy = name.startswith('sofle-')
    if name in KICAD:
        repo, head, stem, old, oldstem = KICAD[name]
        reader = History(args.history_cache / repo); parent = reader.revision(head + '^1'); old = reader.revision(old)
        current = kicad_set(reader, head, stem)
        previous = [('parent', parent, kicad_set(reader, parent, stem)), ('prior-design', old, kicad_set(reader, old, oldstem))]
        missing = []
    elif name == 'approved':
        current, previous, missing, head = approved(args)
    else:
        project = next(p for p in fidelity.manifest() if p['id'] == name)
        current, previous, missing, head = public_altium(project, args)
    blobs, by_hash = [], {}
    def pack(files):
        result = []
        for key, data in files.items():
            digest = sha(data)
            if digest not in by_hash:
                by_hash[digest] = len(blobs); blobs.append(base64.b64encode(data).decode())
            result.append({'name': key, 'blob': by_hash[digest]})
        return result
    conversion = {}
    def tour_files(files, suffix=''):
        if not legacy:
            return files
        modern = {k: v for k, v in files.items() if not k.endswith('.sch')}
        if args.converted_dir:
            path = args.converted_dir / (name + suffix) / 'SofleKeyboard.kicad_sch'
            modern[path.name] = path.read_bytes()
            conversion[suffix or 'current'] = verified_conversion(files['SofleKeyboard.sch'], modern[path.name])
        return modern
    after = tour_files(current)
    out = {'name': name, 'private': name == 'approved', 'theme': args.theme, 'capture': args.capture and name != 'approved',
           'current': pack(after), 'original': pack(current) if legacy else [], 'previous': [], 'blobs': blobs,
           'missingLibraries': sum(x in ('.schlib', '.pcblib') for x in missing)}
    if any(m in ('.schdoc', '.pcbdoc') for m in missing):
        raise ValueError('The committed manifest is missing a schematic or board.')
    for kind, rev, files in previous:
        equal = signature(current) == signature(files)
        selected = after if equal else tour_files(files, '-previous' if kind == 'prior-design' else '')
        row = {'kind': kind, 'sameSources': equal, 'files': pack(selected)}
        if not out['private']:
            row['revision'] = rev
        out['previous'].append(row)
    if not out['private']:
        out['revision'] = head
    out['conversion'] = conversion
    return out

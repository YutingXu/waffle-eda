"""Project verified folder bytes into the editor's existing headless tools."""
import base64
import codecs
import hashlib
import json
import zlib

from folder_files import FolderError
from obsolete_project import reject


MODEL_HEADER = bytes.fromhex("1f8b08000000000002ff")
MODEL_LIMIT = 32 << 20


def verified_model(data, materialize):
    decoder = zlib.decompressobj(31)
    digest = hashlib.sha256()
    length = 0
    material = bytearray() if materialize else None
    utf8 = codecs.getincrementaldecoder("utf-8")() if materialize else None
    try:
        if data[:10] != MODEL_HEADER:
            raise ValueError("The model has a noncanonical gzip header.")
        for offset in range(0, len(data), 64 << 10):
            raw = decoder.decompress(data[offset:offset + (64 << 10)], MODEL_LIMIT - length + 1)
            length += len(raw)
            if length > MODEL_LIMIT or decoder.unconsumed_tail:
                raise ValueError("The expanded model exceeds the size limit.")
            digest.update(raw)
            if material is not None:
                material.extend(raw)
            if utf8 is not None:
                try:
                    utf8.decode(raw, final=decoder.eof)
                except UnicodeDecodeError:
                    utf8 = None
        if not decoder.eof or decoder.unused_data:
            raise ValueError("Expected exactly one complete gzip member.")
    except (ValueError, zlib.error) as error:
        raise FolderError("The saved model could not be verified. " + str(error), "invalidMember") from error
    proof = {"length": length, "sha256": digest.hexdigest()}
    if material is None:
        return proof, None, None
    if utf8 is not None and length:
        return proof, material, "utf-8"
    # Body assets already support RFC 1950. Reuse the verified DEFLATE stream
    # and leave the native gzip and original STEP bytes untouched.
    stored_size = len(data) - len(MODEL_HEADER) - 8 + 6
    if stored_size > MODEL_LIMIT:
        return proof, None, "reference"
    payload = b"\x78\xda" + data[len(MODEL_HEADER):-8] + zlib.adler32(material).to_bytes(4, "big")
    return proof, payload, "zlib"


def _model_slots(project):
    owners = list(project["documents"])
    for group in (project, *(project.get("layoutBlocks") or [])):
        for definition in group.get("library", []):
            owners.extend((definition, definition.get("footprint") or {}))
    for owner in owners:
        for slot in (owner.get("model3d"), *(owner.get("bodyModels") or [])):
            ref = slot.get("model") if isinstance(slot, dict) else None
            if isinstance(ref, dict) and ref.get("mediaType") == "model/step":
                sha, length = ref.get("sha256"), ref.get("byteLength")
                if isinstance(sha, str) and type(length) is int:
                    yield (sha, length), slot


class ReadOnlyFormat(ValueError):
    code = "read_only_format"


class FolderProject:
    def __init__(self, files, runner):
        self.files = files
        self.runner = runner
        self.last = None

    def run(self, action, data=None, **args):
        encoded = base64.b64encode(data) if data is not None else None
        return self.runner().headless("folder_project", {"action": action, **args}, encoded,
                                      ("folder-project-mcp",), timeout=120, memory=4 << 30)

    def start(self, read, **args):
        raw = read(self.files.path.name)
        reject(raw, self.files.path.name)
        return self.run("start", raw, **args)[0]

    def list_documents(self):
        with self.files.snapshot() as (read, _):
            manifest = self.start(read)
        return {"name": manifest["name"], "project_id": manifest["id"], "format": manifest["format"],
                "source_sha256": None, "version_pending": True, "documents": manifest["documents"],
                **({"format_diagnostics": manifest["format_diagnostics"]} if "format_diagnostics" in manifest else {})}

    def scoped(self, document_id=None, libraries=False, source_rules=False):
        with self.files.snapshot() as (read, read_set):
            manifest = self.start(read, sourceRules=source_rules)
            if libraries:
                remaining = [ref["path"] for ref in manifest["libraries"]]
            else:
                selected = next((row for row in manifest["documents"] if row["id"] == document_id), None)
                if selected is None:
                    raise KeyError(document_id)
                if selected.get("read_only"):
                    raise ValueError("Choose a Waffle version that understands this document type.")
                remaining = [selected["path"]]
            visited = set()
            for path in remaining:
                if path in visited:
                    continue
                related = self.run("owner", read(path), path=path)[0]
                visited.add(path)
                remaining.extend(related["libraries"])
                for asset in related["assets"]:
                    if asset["path"] in visited:
                        continue
                    raw = read(asset["path"])
                    if len(raw) != asset["byteLength"] or hashlib.sha256(raw).hexdigest() != asset["sha256"]:
                        raise FolderError("A required attachment failed verification: " + asset["path"])
                    visited.add(asset["path"])
            head, body = self.run("project")
            if source_rules:
                for ref in manifest["imports"]:
                    found = self.run("read_rules", read(ref["path"]), path=ref["path"], documentId=document_id)[0]
                    if "rules" in found:
                        head["source_rules"] = found["rules"]
                        break
        return json.loads(body), head, read_set

    def member(self, read, ref, *, local_sources=False):
        try:
            return read(ref["path"])
        except FolderError as error:
            if ref["kind"] != "source" or error.code != "incomplete_project":
                raise
            if local_sources:
                if ref.get("git"):
                    raise FolderError("A retained original has no local copy: " + ref["path"] + ". In Waffle, use File › Save as Zip and open the extracted project to include the original from Git history.",
                                      "incomplete_project", [ref["path"]]) from error
                raise
            from project_archive import retained_original
            path = self.files.path
            stored = retained_original(path.parent, path.name, ref["bindingPath"], ref["inputId"])
            return base64.b64decode(stored["data"], validate=True)

    def export_originals(self, refs):
        """Reopen only the verified project's requested source bindings under a native read lease."""
        if not refs:
            return None
        with self.files.snapshot() as (read, seen):
            for path in {self.files.path.name, *(ref["bindingPath"] for ref in refs)}:
                read(path)
                if seen[path] != self.last["read_set"].get(path):
                    raise FolderError("The saved source binding changed during export. Read again and retry.", "conflict", [path])
            originals = {}
            for ref in refs:
                sha = ref["sha256"]
                if sha not in originals:
                    raw = self.member(read, ref)
                    if len(raw) != ref["byteLength"] or hashlib.sha256(raw).hexdigest() != sha:
                        raise FolderError("A retained original differs from its verified source binding.", "conflict", [ref["path"]])
                    originals[sha] = {"sha256": sha, "data": base64.b64encode(raw).decode("ascii")}
        return json.dumps(list(originals.values()), separators=(",", ":")).encode("ascii")

    def full(self, models=False, recover=False, local_sources=False):
        try:
            return self.read_full(models, local_sources=local_sources)
        except FolderError as error:
            if not recover or error.code != "recovery_pending":
                raise
        self.files.recover()
        return self.read_full(models, local_sources=local_sources)

    def read_full(self, models, *, local_sources=False):
        with self.files.snapshot() as (read, read_set):
            local = True

            def member(ref):
                nonlocal local
                raw = self.member(read, ref, local_sources=local_sources)
                local = local and ref["path"] in read_set
                return raw

            head, body = self.project_bytes(read(self.files.path.name), member, models)
        self.last = {**head, "read_set": read_set, "local_members": local, "loaded_models": models}
        return body, head["source_sha256"]

    def unchanged(self, source, models, *, writing=False):
        """Check the previous complete disk closure under a fresh native lease."""
        last = self.last
        if not last or last.get("source_sha256") != source or not last.get("local_members") or last.get("loaded_models") != models:
            return False
        if writing and self.run("version")[0].get("source_sha256") != source:
            return False
        try:
            with self.files.snapshot() as (read, seen):
                for path, expected in last["read_set"].items():
                    read(path)
                    if seen[path] != expected:
                        return False
                return True
        except FolderError as error:
            if error.code not in ("incomplete_project", "recovery_pending"):
                raise
            return False

    def refresh(self, source, hashes):
        """Verify native receipt against a fresh complete lease and project only changed owners."""
        last = self.last
        if not last or last.get("source_sha256") != source or not last.get("local_members"):
            return None
        expected = {**last["read_set"], **hashes}
        if not hashes or hashes.keys() - last["read_set"].keys() or any(not isinstance(value, str) for value in hashes.values()):
            return None
        updated = []
        try:
            with self.files.snapshot() as (read, seen):
                for path, digest in expected.items():
                    raw = read(path)
                    if seen[path] != digest:
                        return None
                    if path in hashes:
                        updated.append(dict(path=path, sha256=digest, data=base64.b64encode(raw).decode("ascii")))
        except FolderError as error:
            if error.code in ("incomplete_project", "conflict"):
                return None
            raise
        head, body = self.run("refresh", json.dumps(updated, separators=(",", ":")).encode(),
                              previous=source, manifestPath=self.files.path.name)
        if not head["refresh"]:
            return None
        self.last = {**last, **head, "read_set": seen}
        return head["source_sha256"], body

    def project_bytes(self, manifest, read, models=False):
        reject(manifest, self.files.path.name)
        part = self.run("start", manifest, full=True, models=models)[0]
        raw = None
        while part.get("request"):
            ref = part["request"]
            if part["verify_model"]:
                digest, material, encoding = verified_model(raw, models)
                part = self.run("feed", material, path=ref["path"], model=digest, modelEncoding=encoding)[0]
            else:
                raw = read(ref)
                part = self.run("feed", raw)[0]
        head, body = self.run("project")
        return head, body.encode("utf-8")

    def export_models(self, expected, working):
        """Materialize a computed pipeline export target without replacing earlier edits."""
        saved, version = self.full(models=True)
        if version != expected:
            raise FolderError("The saved model sources changed during export. Read again and retry.", "conflict")
        if working is None:
            return saved
        payloads = {}
        for ref, slot in _model_slots(json.loads(saved)):
            for key in ("stepText", "zlib"):
                if key in slot:
                    payloads[ref] = {key: slot[key]}
        project = json.loads(working)
        for ref, slot in _model_slots(project):
            if "zlib" not in slot and "stepText" not in slot and ref in payloads:
                slot.update(payloads[ref])
        return json.dumps(project, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def historical(self, snapshot, objects=None):
        if not snapshot.exists:
            return None, None
        if not snapshot.native:
            reject(snapshot.raw, snapshot.anchor)
            raise ValueError("The revision does not contain a Waffle project manifest.")

        def read(ref):
            key, raw = snapshot.member(ref, objects)
            if objects is not None and len(raw) <= (16 << 20):
                objects[key] = raw
                while sum(map(len, objects.values())) > (64 << 20):
                    objects.pop(next(iter(objects)))
            return raw

        return self.project_bytes(snapshot.raw, read)

    def require_editable_format(self, owners=()):
        for diagnostic in (self.last or {}).get("format_diagnostics", []):
            owner = diagnostic["owner"]
            if owner["kind"] == "project" or owner["id"] in owners:
                raise ReadOnlyFormat(diagnostic["message"])

    def proposal_base(self):
        return {key: self.last[key] for key in ("project_id", "manifest_sha256", "members")}

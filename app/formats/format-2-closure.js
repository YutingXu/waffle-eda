"use strict";
// Verify a complete read lease. The callback resolves logical members through the host grant.
globalThis.AtriumFormat2Closure = (() => {
  const G = globalThis, F = G.AtriumFormat2, M = G.AtriumFormat2Model;
  const modelProofs = new WeakMap();
  const checkedDigest = Symbol();
  const modelByteLimit = 32 * 1048576;
  const storedModelLimit = 18 + modelByteLimit + 5 * (Math.floor(modelByteLimit / 16383) + 1);
  function fail(code, message) { throw new F.FormatError(code, message); }
  function bytes(value, path) {
    const data = value?.bytes ?? value;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    fail("missing-member", "Missing project member " + path + ".");
  }
  function compatible(ref, previous) {
    if (ref.id != null && previous.id != null && ref.id !== previous.id ||
        ref.sha256 != null && previous.sha256 != null && ref.sha256 !== previous.sha256 ||
        ref.byteLength != null && previous.byteLength != null && ref.byteLength !== previous.byteLength ||
        ref.mediaType != null && previous.mediaType != null && ref.mediaType !== previous.mediaType ||
        ref.kind !== previous.kind || ref.fileKind !== previous.fileKind) {
      fail("invalid-member", "Inconsistent references to project member " + ref.path + ".");
    }
  }
  function cancel(signal) {
    if (signal?.aborted) throw signal.reason ?? Error("Project verification cancelled.");
  }
  function identity(ref, length, sha256) {
    if (ref.byteLength !== undefined && ref.byteLength !== length ||
        ref.sha256 !== undefined && ref.sha256 !== sha256) {
      fail("member-digest", "Project member failed verification " + ref.path + ".");
    }
  }
  function modelReceipt(ref,value) {
    if (value?.path !== ref.path || !value.model || Object.hasOwn(value,"data") || Object.hasOwn(value,"bytes") ||
        !Number.isSafeInteger(value.length) || value.length < 20 || value.length > storedModelLimit ||
        !Number.isSafeInteger(ref.byteLength) || ref.byteLength > modelByteLimit)
      fail("invalid-member", "Invalid native model proof for " + ref.path + ".");
    identity(ref,value.model.byteLength,value.model.sha256);
    const checked = {};
    modelProofs.set(checked,{length:value.length,sha256:F.checkDigest(value.sha256)});
    return checked;
  }
  function provenanceDigest(raw, physicalSha256) {
    if (!raw.includes(13)) return physicalSha256;
    const text = new TextDecoder("utf-8", {fatal: true}).decode(raw);
    return F.sha256(new TextEncoder().encode(text.replace(/\r\n/g, "\n")));
  }
  function validateArchive(index, files) {
    const stored = new Map(index.members.map(ref => [ref.logicalPath, ref]));
    const root = files.get(index.root.path);
    if (!root) fail("missing-member", "The released manifest is unavailable.");
    const expected = F.manifestMembers(root);
    if (expected.length + 1 !== stored.size) fail("invalid-member", "The released manifest and its member index differ.");
    for (const ref of expected) {
      const member = stored.get(ref.path);
      if (member?.id !== ref.id || member?.fileKind !== ref.kind) {
        fail("invalid-member", "A released member differs from its reference " + ref.path + ".");
      }
    }
  }
  function registerLiveIds(file, used, legacyAliases) {
    const {kind} = file.header;
    if (kind === "block") return;
    const modelOwner = kind === "library" || Object.hasOwn(F.documentSuffix, kind);
    const localAliases = new Set();
    for (const row of file.records()) {
      const localId = modelOwner && row.kind === "modelAlias" ? row.value?.id : undefined;
      const alias = typeof localId === "string" && localId.length > 0;
      if (alias) {
        if (localAliases.has(localId)) fail("invalid-member", "Duplicate model alias in " + file.header.id + ".");
        localAliases.add(localId);
      }
      // Earlier writers stored the owner-local lookup ID in the row's ID too.
      // Only two such aliases in distinct owners can share the unqualified ID.
      const legacy = alias && localId === row.id;
      if (used.has(row.id) && !(legacy && legacyAliases.has(row.id))) {
        fail("invalid-member", "Duplicate live object ID " + row.id + ".");
      }
      used.add(row.id);
      if (legacy) legacyAliases.add(row.id);
    }
  }
  function* steps(manifest, {signal, onNative, onBinding, nativeCache, readAhead = 0} = {}) {
    if (manifest.header.kind !== "project") fail("invalid-member", "Expected a project manifest.");
    const required = new Map(), used = new Set([manifest.header.id]), available = new Map(), archives = [];
    const members = [], pending = [], legacyAliases = new Set();
    function enqueue(ref) {
      const path = F.memberPath(ref.path), key = F.pathKey(path);
      const previous = required.get(key);
      if (previous) {
        if (path !== previous.path) fail("invalid-member", "Colliding project member path " + path + ".");
        compatible(ref, previous);
        return;
      }
      required.set(key, ref);
      pending.push(ref);
    }
    for (const item of manifest.records()) used.add(item.id);
    for (const reference of M.dependencies(manifest)) enqueue(reference);
    for (let index = 0; index < pending.length; index++) {
      cancel(signal);
      const ref = pending[index];
      const ahead = readAhead && ref.kind !== "source" ?
        pending.slice(index + 1, index + readAhead).filter(next => next.kind !== "source") : [];
      const input = yield {ref, ahead};
      const proof = modelProofs.get(input);
      const raw = proof ? null : bytes(input,ref.path);
      cancel(signal);
      const length = proof?.length ?? raw.length;
      const physicalSha256 = proof?.sha256 ?? input?.[checkedDigest] ?? F.sha256(raw);
      let sha256 = physicalSha256;
      if (ref.kind === "model") {
        if (!proof) {
          const model = yield {ref, model: raw};
          identity(ref, model.length, model.sha256);
        }
      } else if (ref.kind === "source" || ref.kind === "asset") {
        identity(ref, length, physicalSha256);
      } else if (ref.kind === "import-index") {
        const I = G.AtriumImportSidecars;
        if (!I) fail("unsupported-feature", "The import provenance reader is unavailable.");
        const binding = I.parse(raw, {kind: "importIndex", id: ref.id, path: ref.path});
        onBinding?.(binding);
        sha256 = provenanceDigest(raw, physicalSha256);
        for (const required of I.dependencies(binding)) {
          const input = binding.inputs.find(input => input.sha256 === required.sha256);
          if (!input?.id) fail("invalid-member", "The import binding lacks the input " + required.path + ".");
          enqueue({...required, kind: "source", bindingPath: binding.ref.path, inputId: input.id});
        }
      } else {
        const archived = ref.kind === "archived", opaque = ref.kind === "opaque";
        const kind = archived || opaque ? ref.fileKind : ref.kind;
        const key = nativeCache && JSON.stringify([kind, ref.id, opaque, physicalSha256]);
        let file = key && nativeCache.get(key);
        if (!file) {
          file = M.parse(raw, {kind, id: ref.id, opaque});
          if (key) nativeCache.set(key, file);
        }
        if (archived || ref.kind === "snapshot") identity(ref, length, physicalSha256);
        else {
          F.checkMemberVersion(manifest, file);
          if (file.transport !== "lf") sha256 = F.sha256(F.serialize(file));
          registerLiveIds(file, used, legacyAliases);
        }
        if (ref.kind === "snapshot") archives.push(M.snapshot(file));
        if (archived) available.set(ref.path, file);
        if (!opaque) {
          onNative?.(file, ref, raw);
          for (const dependency of M.dependencies(file, {archived})) enqueue(dependency);
        }
      }
      members.push({path: ref.path, kind: ref.kind, sha256, physicalSha256, length});
    }
    for (const index of archives) validateArchive(index, available);
    members.sort((a, b) => F.compare(a.path, b.path));
    return {sha256: F.projectDigest(manifest, members), members};
  }
  async function verify(manifest, read, {signal, verifyModel, loadModels, onNative, onBinding, nativeCache, readBatch, proveModels, accelerateDigests} = {}) {
    const cursor = steps(manifest, {signal, onNative, onBinding, nativeCache, readAhead:readBatch ? 8 : 0});
    const prefetched = new Map();
    const sha = accelerateDigests && G.crypto?.subtle && G.AtriumImportSidecars?.sha;
    let state = cursor.next();
    while (!state.done) {
      const {ref, model, ahead} = state.value;
      if (model) {
        const options = {sha256: ref.sha256, byteLength: ref.byteLength, signal};
        if (verifyModel) {
          const raw = await verifyModel(model, options);
          state = cursor.next({length: raw.byteLength, sha256: F.sha256(raw)});
        } else {
          const codec = G.AtriumFormat2Models || loadModels?.();
          if (!codec) fail("unsupported-feature", "The model verifier is unavailable.");
          state = cursor.next(await codec.verify(model, options));
        }
      } else {
        if (!prefetched.has(ref.path) && (ahead.length || proveModels && ref.kind === "model")) {
          const refs = [ref,...ahead];
          const values = await readBatch(refs.map(item=>item.path),refs);
          for (const [index,item] of refs.entries()) {
            const value = values[index];
            prefetched.set(item.path,proveModels && item.kind === "model" ? modelReceipt(item,value) : value);
          }
        }
        let value = prefetched.has(ref.path) ? prefetched.get(ref.path) : await read(ref.path, ref, signal);
        prefetched.delete(ref.path);
        if (sha && !modelProofs.has(value)) {
          cancel(signal);
          const data = bytes(value, ref.path);
          // Web Crypto takes its own copy. Only one member is hashed at a time,
          // with a cap on the temporary copy even when reads are already batched.
          if (data.byteLength >= 128 * 1024 && data.byteLength <= 8 * 1048576 && data.buffer instanceof ArrayBuffer) {
            const digest = await sha(data).catch(() => null);
            if (digest !== null) value = {bytes:data, [checkedDigest]:digest};
          }
        }
        state = cursor.next(value);
      }
    }
    return state.value;
  }

  return Object.freeze({verify, steps});
})();

"use strict";
// Family membership is optional library organisation. Placed parts, the BOM and netlists
// continue to refer to one existing definition, including that definition's actual pinout.
// Both a project (.library) and a reusable library (.defs) may own componentFamilies.
globalThis.AtriumComponentFamilies = (() => {
  const A = globalThis.Atrium;
  const definitions = owner => Array.isArray(owner) ? owner : owner?.library || owner?.defs || [];
  const nonempty = text => typeof text === "string" && !!text.trim();
  const label = (text, field) => {
    if (!nonempty(text)) throw Error("Enter a " + field + ".");
    return text.trim();
  };
  const validMember = m => nonempty(m?.defId) && nonempty(m?.part);
  const validFamily = f => nonempty(f?.id) && nonempty(f?.name) && Array.isArray(f.members) && f.members.every(validMember);

  // Read without migrating or rewriting the file. An ambiguous entry stays individually
  // accessible in the library. Refuse to overwrite a malformed store during a family edit.
  function read(owner) {
    const records = owner?.componentFamilies;
    if (records === undefined) return {families: [], valid: true};
    if (!Array.isArray(records)) return {families: [], valid: false};
    const ids = new Set(), duplicates = new Set(), members = new Set();
    let valid = true;
    for (const f of records) {
      if (!validFamily(f)) {valid = false; continue;}
      if (ids.has(f.id)) {duplicates.add(f.id); valid = false;}
      ids.add(f.id);
    }
    const families = records.filter(f => validFamily(f) && !duplicates.has(f.id));
    for (const f of families) for (const m of f.members) {
      if (members.has(m.defId)) valid = false;
      members.add(m.defId);
    }
    return {families, valid};
  }
  function editable(owner) {
    const store = read(owner);
    if (!store.valid) throw Error("The library has invalid or ambiguous family records. Repair those records before editing families.");
    return store.families;
  }
  function memberships(owner) {
    const byDef = new Map(), repeated = new Set();
    for (const f of read(owner).families) for (const m of f.members) {
      if (byDef.has(m.defId)) repeated.add(m.defId);
      byDef.set(m.defId, {id: f.id, name: f.name, part: m.part});
    }
    for (const id of repeated) byDef.delete(id);
    return byDef;
  }
  function asset(def, kind) {
    if (!def[kind]) return null;
    const origin = kind === "symbol" ? def.symbolSource : def.footprintSource;
    return {defId: origin?.defId || def.id, name: kind === "footprint" ? def.footprint.name || def.name : origin?.name || def.libRef || def.name,
      sourceName: origin?.sourceName ?? def.sourceName ?? def.libraryRef?.name ?? ""};
  }
  function browse(owner, visibleDefs = definitions(owner)) {
    const members = memberships(owner), groups = new Map(), rows = [];
    for (const def of visibleDefs) {
      if (!def || def.mirrorOf) continue;
      const symbol = asset(def, "symbol"), footprint = asset(def, "footprint");
      const option = {id: def.id, def, packageName: footprint?.name || "", symbol, footprint};
      const membership = members.get(def.id);
      if (!membership) {
        rows.push({id: def.id, name: def.name, kind: symbol && footprint ? "component" : symbol ? "symbol" : "footprint",
          parts: [{name: def.name, options: [option]}]});
        continue;
      }
      let group = groups.get(membership.id);
      if (!group) {
        const row = {id: membership.id, name: membership.name, kind: "family", parts: []};
        group = {row, parts: new Map()};
        groups.set(membership.id, group);
        rows.push(row);
      }
      let part = group.parts.get(membership.part);
      if (!part) {
        part = {name: membership.part, options: []};
        group.parts.set(part.name, part);
        group.row.parts.push(part);
      }
      part.options.push(option);
    }
    return rows;
  }

  function store(owner, families) {
    if (families.length) owner.componentFamilies = families;
    else delete owner.componentFamilies;
  }
  function family(owner, id) {
    const f = editable(owner).find(f => f.id === id);
    if (!f) throw Error("That family is no longer in this library.");
    return f;
  }
  // A single prepared replacement also handles moving definitions between families.
  function withFamily(families, next) {
    const claimed = new Set(next.members.map(m => m.defId)), result = [];
    let replaced = false;
    for (const f of families) {
      if (f.id === next.id) {result.push(next); replaced = true; continue;}
      const rest = f.members.filter(m => !claimed.has(m.defId));
      if (rest.length) result.push(rest.length === f.members.length ? f : {...f, members: rest});
    }
    if (!replaced) result.push(next);
    return result;
  }
  function checkedMembers(owner, entries) {
    if (!Array.isArray(entries) || !entries.length) throw Error("Choose at least one library definition.");
    const available = new Set(definitions(owner).filter(d => !d.mirrorOf).map(d => d.id));
    const seen = new Set();
    return entries.map(entry => {
      const id = entry?.defId;
      if (!available.has(id)) throw Error("That component is no longer in this library.");
      if (seen.has(id)) throw Error("Each package definition can occur only once in a family.");
      seen.add(id);
      return {defId: id, part: label(entry.part, "part name")};
    });
  }
  function create(owner, name, entries) {
    const families = editable(owner);
    const next = {id: A.id(), name: label(name, "family name"), members: checkedMembers(owner, entries)};
    store(owner, withFamily(families, next));
    return next.id;
  }
  function update(owner, id, name, entries) {
    const f = family(owner, id), old = new Map(f.members.map(m => [m.defId, m]));
    const members = checkedMembers(owner, entries).map(m => ({...old.get(m.defId), ...m}));
    store(owner, withFamily(owner.componentFamilies, {...f, name: label(name, "family name"), members}));
    return id;
  }
  function assign(owner, id, entries) {
    const f = family(owner, id), members = checkedMembers(owner, entries);
    const merged = new Map(f.members.map(m => [m.defId, m]));
    for (const m of members) merged.set(m.defId, {...merged.get(m.defId), ...m});
    store(owner, withFamily(owner.componentFamilies, {...f, members: [...merged.values()]}));
    return id;
  }
  function rename(owner, id, name) {
    const f = family(owner, id);
    const next = {...f, name: label(name, "family name")};
    store(owner, owner.componentFamilies.map(g => g === f ? next : g));
    return id;
  }
  function ungroup(owner, id, defIds) {
    const f = family(owner, id);
    if (defIds === undefined) {store(owner, owner.componentFamilies.filter(g => g !== f)); return;}
    if (!Array.isArray(defIds)) throw Error("Choose the definitions to remove from this family.");
    const remove = new Set(defIds);
    const current = new Set(f.members.map(m => m.defId));
    if (!defIds.every(k => current.has(k))) throw Error("That definition is no longer in this family.");
    const members = f.members.filter(m => !remove.has(m.defId));
    store(owner, owner.componentFamilies.flatMap(g => g !== f ? [g] : members.length ? [{...f, members}] : []));
  }
  // Removal can also be called on a plain legacy project. A damaged organisational
  // record must never prevent an electrical edit or cause unrelated metadata to be lost.
  function forget(owner, defId) {
    if (!owner.componentFamilies) return;
    const {families, valid} = read(owner);
    if (!valid) return;
    const f = families.find(g => g.members.some(m => m.defId === defId));
    if (f) ungroup(owner, f.id, [defId]);
  }

  // The schematic and PCB engines connect by the stored terminal number. There is no
  // implicit pin map. Named pads can repeat (one physical terminal with several lands).
  function pairing(symbolDef, footprintDef) {
    const pins = new Set((symbolDef?.symbol?.pins || []).map(p => String(p.number ?? "")));
    const pads = new Set((footprintDef?.footprint?.pads || []).filter(p => !p.thermalVia && p.number != null && p.number !== "").map(p => String(p.number)));
    const missingPins = [...pins].filter(n => !pads.has(n));
    const extraPads = [...pads].filter(n => !pins.has(n));
    return {ok: !!symbolDef?.symbol && !!footprintDef?.footprint && !missingPins.length && !extraPads.length, missingPins, extraPads};
  }
  function packageFields(base, physical) {
    if (!base?.symbol || !physical?.footprint || base.mirrorOf || physical.mirrorOf) throw Error("Choose a library symbol and a footprint.");
    const report = pairing(base, physical);
    if (!report.ok) {
      const details = [];
      if (report.missingPins.length) details.push("Pins without pads: " + report.missingPins.map(n => n || "(unnumbered)").join(", "));
      if (report.extraPads.length) details.push("Pads without pins: " + report.extraPads.join(", "));
      throw Error(details.join(". ") + ". Edit the terminal numbers or choose another footprint.");
    }
    const footprint = A.clone(physical.footprint);
    // Library footprint geometry is reusable. A net stamped on an imported board's
    // pad belongs to that board instance, not to a new component made from the land pattern.
    for (const pad of footprint.pads) delete pad.net;
    const fields = {footprint, footprintName: footprint.name || physical.name, footprintSource: asset(physical, "footprint")};
    const L = globalThis.AtriumLibrary, symbolSource = L.portableSource(base), physicalSource = L.portableSource(physical);
    const credit = physicalSource?.footprint || (!physical.symbol || /(?:footprint|pcblib)$/.test(physicalSource?.kind) ? physicalSource : null);
    if (symbolSource || credit) {
      const source = {...symbolSource};
      delete source.footprint;
      if (credit) source.footprint = A.clone(credit);
      fields.source = source;
    }
    for (const key of ["package", "height", "model3d"]) if (physical[key] != null) fields[key] = A.clone(physical[key]);
    return fields;
  }
  function bindFootprint(project, symbolId, footprintId) {
    const at = project.library.findIndex(d => d.id === symbolId), base = project.library[at];
    const physical = project.library.find(d => d.id === footprintId);
    if (base?.footprint) throw Error("This component already has a footprint. Add a package option to keep both.");
    const next = {...base, ...packageFields(base, physical)};
    const validation = globalThis.AtriumLibrary.validateDef(next, {footprintWarnings: false});
    if (!validation.ok) throw Error(validation.errors[0]);
    // This definition had no PCB geometry and keeps its exact symbol, ID and value.
    // Existing schematic instances, including their wires and overrides, need no update.
    project.library[at] = next;
    return next;
  }
  function addPackage(project, baseId, footprintId, options = {}) {
    const base = project.library.find(d => d.id === baseId), physical = project.library.find(d => d.id === footprintId);
    if (!base?.footprint) throw Error("Attach the first footprint to the symbol before adding a package.");
    const fields = packageFields(base, physical), families = editable(project);
    const group = families.find(f => f.members.some(m => m.defId === baseId));
    const part = label(options.part ?? group?.members.find(m => m.defId === baseId)?.part ?? base.name, "part name");
    const name = label(options.name ?? part + " (" + fields.footprintName + ")", "component name");
    /** @type {Definition} */
    const def = {id: A.id(), name, value: options.value ?? part, symbol: A.clone(base.symbol), symbolSource: asset(base, "symbol"), ...fields};
    for (const k of ["prefix", "category", "description", "schDrawing", "sourceSymbolShapes", "componentKind", "excludeFromBOM"]) {
      if (base[k] != null) def[k] = A.clone(base[k]);
    }
    // An order code and supplier SKU belong to one package. Start this new variant's
    // purchasing information from its explicitly supplied MPN, never the base variant.
    if (nonempty(options.mpn)) def.parameters = {"Manufacturer Part Number": options.mpn.trim()};
    const member = {defId: def.id, part};
    const next = group ? {...group, members: [...group.members, member]} : {id: A.id(), name: part, members: [{defId: baseId, part}, member]};
    const organisation = withFamily(families, next);
    globalThis.AtriumLibrary.replaceDef(project, def);
    store(project, organisation);
    return def;
  }

  // Transfer one exact member while preserving local definition IDs. Source-family IDs
  // in two independent files can legitimately coincide; scope imported groups by library.
  function copiedFamilies(from, sourceId, to, targetId, intoProject) {
    const fromFamilies = editable(from), destination = editable(to);
    const source = fromFamilies.find(f => f.members.some(m => m.defId === sourceId));
    if (!source) {
      if (intoProject) return destination;
      // Saving an explicitly ungrouped project entry removes its old source membership.
      return destination.flatMap(f => {
        const members = f.members.filter(m => m.defId !== targetId);
        return members.length === f.members.length ? [f] : members.length ? [{...f, members}] : [];
      });
    }
    const member = source.members.find(m => m.defId === sourceId);
    const libraryId = (intoProject ? from : to).id || (intoProject ? from : to).name;
    let target;
    if (intoProject) {
      target = destination.find(f => f.source?.library === libraryId && f.source.id === source.id);
      // A project can export its own family and later bring another member back.
      if (!target) {
        const original = destination.find(f => !f.source && f.id === source.id);
        if (original) {
          const originalMembers = new Set(original.members.map(m => m.defId));
          if (definitions(to).some(d => originalMembers.has(d.id) && d.libraryRef?.library === libraryId)) target = original;
        }
      }
    } else {
      const id = source.source?.library === libraryId ? source.source.id : source.id;
      target = destination.find(f => f.id === id) || {id, name: source.name, members: []};
    }
    if (!target) target = {id: A.id(), source: {library: libraryId, id: source.id}, name: source.name, members: []};
    const members = target.members.filter(m => m.defId !== targetId);
    members.push({...member, defId: targetId});
    return withFamily(destination, {...target, name: intoProject ? target.name : source.name, members});
  }
  function forLibrary(owner, defs, warnings = []) {
    const {families, valid} = read(owner);
    if (!valid) warnings.push("Ignored ambiguous or malformed component family records.");
    const members = memberships(owner), available = new Set(defs.map(d => d.id));
    return families.flatMap(f => {
      const visible = f.members.filter(m => members.has(m.defId) && available.has(m.defId));
      if (!visible.length) return [];
      const {source, ...portable} = f;
      return [{...portable, members: visible}];
    });
  }
  return Object.freeze({browse, memberships, create, update, assign, rename, ungroup, forget,
    pairing, bindFootprint, addPackage, copiedFamilies, forLibrary, store});
})();

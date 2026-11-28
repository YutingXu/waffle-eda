"use strict";
// The Import Report's source references, one per source object.
//
// A report row (report.kinds[], report.modelObjects[]) lists its first 256 references one by one.
// The rest it packs per file into a grouped reference: objects (and, for modelObjects, ids) are
// strings, {object, count}, or a run of consecutive record numbers {prefix, first, last, width}.
// A census that reads only the plain references sees a board with more than 256 parts as having
// lost the others, so every census module reads the report through here.
//
//   references(row) -> [{file, object, status?, reason?, id?}]
const unpack = values => (values || []).flatMap(v => (v && typeof v === "object"
  ? v.prefix != null ? Array.from({length:v.last - v.first + 1}, (_, i) => v.prefix + String(v.first + i).padStart(v.width || 0, "0")) : [v.object]
  : [v]));

function references(row) {
  const out = [];
  for (const r of row.references || []) {
    const base = {file:r.source?.file, ...(r.status ? {status:r.status} : {}), ...(r.reason ? {reason:r.reason} : {})};
    if (!r.grouped) { out.push({...base, object:r.source?.object, ...(r.id != null ? {id:r.id} : {})}); continue; }
    const objects = unpack(r.objects), ids = r.ids ? unpack(r.ids) : null;
    // objects and ids are packed in step, one of each per produced object.
    objects.forEach((object, i) => out.push({...base, object, ...(ids && ids.length === objects.length ? {id:ids[i]} : {})}));
  }
  return out;
}

module.exports = {references};

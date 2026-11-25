// The test consumers insert the unchanged public widen-power-tracks example.
async function widen() {
  /* public-example */
}
async function fields() {
  const {apiVersion, name, units} = await api.project.info();
  const document = await api.documents.active();
  const tracks = await api.items.list({doc: document.id, kind: "track", fields: ["id", "net", "width", "points"]});
  return {apiVersion, name, units, document, tracks: tracks.sort((a,b) => a.id.localeCompare(b.id))};
}
const before = await fields();
const edit = args?.inspect ? null : await widen();
return {before, edit, after: edit ? await fields() : before};

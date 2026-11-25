"use strict";

// Test a broker round trip without a key, remote dependency or project write.
module.exports.respond = ({tools, reads}) => {
  if (!reads.length && tools.some(tool => tool.tool === "query"))
    return {type:"tools", calls:[{tool:"query", args:{scope:"part"}}]};
  const rows = reads.flatMap(read => read.rows);
  return {type:"answer", text:rows.length ? "Read " + rows.length + " approved rows." : "No approved rows.",
    citations:rows.map(row => row.citation)};
};

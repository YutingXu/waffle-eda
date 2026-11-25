"use strict";
// Synthetic newer-minor files ("stamp": "next-minor" in index.json) must stay newer than this build after
// CURRENT moves on: when the file's own stamp is not newer, it is loaded stamped CURRENT + 1 minor.
// "next-major" files (newer major versions) likewise: CURRENT's major + 1, and a compatibleWith names CURRENT.
module.exports = function stamp(entry, raw) {
  const C = AtriumCompat, CUR = AtriumMigrations.parse(C.CURRENT), NEXT_MINOR = CUR[0] + "." + (CUR[1] + 1);
  if (entry.stamp != null && entry.stamp !== "next-minor" && entry.stamp !== "next-major") throw Error(entry.file + ": unknown stamp " + entry.stamp);
  if (entry.stamp === "next-minor" && AtriumMigrations.cmp(C.versionOf(raw), CUR) <= 0) raw.formatVersion = NEXT_MINOR;
  if (entry.stamp === "next-major" && C.versionOf(raw)[0] <= CUR[0]) {
    raw.version = CUR[0] + 1; raw.formatVersion = CUR[0] + 1 + ".0";
    if (raw.compatibleWith != null) raw.compatibleWith = C.CURRENT;
  }
  return raw;
};

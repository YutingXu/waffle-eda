"use strict";
// Released minor upgrades transform native owner values. Calling the registry does
// not replace the saved byte cursor or grant permission to publish its result.
globalThis.AtriumFormat2Upgrades = (() => {
  const F = globalThis.AtriumFormat2;
  const copy = data => JSON.parse(JSON.stringify(data));

  function create(current, steps = []) {
    const [major, currentMinor] = F.readVersion(current), transforms = new Map();
    for (const [from, transform] of steps) {
      const [sourceMajor, sourceMinor] = F.readVersion(from);
      if (sourceMajor !== major || sourceMinor >= currentMinor || transforms.has(sourceMinor) || typeof transform !== "function")
        throw Error("Invalid native upgrade step from " + from + ".");
      transforms.set(sourceMinor, transform);
    }

    function pending(version) {
      const [sourceMajor, sourceMinor] = F.readVersion(version);
      return sourceMajor === major && sourceMinor < currentMinor;
    }

    function project(header, records) {
      if (!pending(header.formatVersion)) return null;
      const [, first] = F.readVersion(header.formatVersion);
      const chain = [];
      for (let minor = first; minor < currentMinor; minor++) {
        const transform = transforms.get(minor);
        if (!transform) throw new F.FormatError("unsupported-version",
          "No native upgrade is registered from " + major + "." + minor + ".");
        chain.push(transform);
      }
      // Each step owns its own version and receives private values. In particular,
      // a transformer cannot mutate the codec's frozen record or raw row cache.
      const {id, kind} = header;
      let value = copy({header, records: [...records]});
      for (const [index, transform] of chain.entries()) {
        value = transform(value);
        if (value?.header?.id !== id || value.header.kind !== kind || !Array.isArray(value.records))
          throw new F.FormatError("invalid-format", "A native upgrade must keep its owner identity and return records.");
        value = {...value, header: {...value.header, formatVersion: major + "." + (first + index + 1)}};
      }
      return value;
    }

    return Object.freeze({pending, project});
  }

  // Format 2.0 is the first public format. Add a transformer only after
  // publishing a later minor whose reader needs a value-level adjustment.
  return Object.freeze({create, current:create(F.FORMAT)});
})();

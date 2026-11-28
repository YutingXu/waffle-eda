"use strict";

// Pin a suite's time zone to UTC. Require it before the suite builds a date.
// Fabrication headers, dated folder and package names and other local-time output are compared with
// values recorded in UTC; in another zone they differ by the host's offset (+14:00 at Kiritimati) or
// by a day. Node applies a TZ change at once. JavaScriptCore reads TZ only at start, so
// scripts/test-jsc.sh exports TZ=UTC; run jsc directly with TZ=UTC as well.
if (typeof process === "object" && process && process.env) process.env.TZ = "UTC";
const offsets = [new Date(2026, 0, 15, 12).getTimezoneOffset(), new Date(2026, 6, 15, 12).getTimezoneOffset()];
if (offsets.some(offset => offset !== 0))
  throw Error("This suite compares output recorded in UTC; run it with TZ=UTC (the zone here is " +
    Intl.DateTimeFormat().resolvedOptions().timeZone + ").");

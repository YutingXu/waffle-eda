"use strict";
// AtriumPathRecord: Path2D recording for printing and PDF output. Path2D is opaque in browsers,
// so its constructor is wrapped once, before any drawing, to keep each path's commands; native
// drawing is unchanged. It stays eager so that every cached Path2D is recorded from the first
// frame. pdf.js (the writer, AtriumPDF.paths) and print.js (the replaying context) load on
// first use through lazy.js and read the records from here.
//   AtriumPathRecord.REC     WeakMap Path2D -> [op, args..., op, args...]
//   AtriumPathRecord.NAMES   op index -> method name; NARGS: op index -> argument count
globalThis.AtriumPathRecord = (() => {
  const NAMES = ["moveTo", "lineTo", "bezierCurveTo", "closePath", "quadraticCurveTo", "arc", "ellipse", "rect", "roundRect", "arcTo"];
  const NARGS = [2, 2, 6, 0, 4, 6, 8, 4, 5, 5];
  const REC = new WeakMap();
  const radius = r => Array.isArray(r) ? radius(r[0]) : typeof r === "object" && r ? +r.x || 0 : +r || 0;
  function instrument(P, native) {
    for (let k = 0; k < NAMES.length; k++) {
      const name = NAMES[k], n = NARGS[k], orig = native ? P.prototype[name] : null;
      P.prototype[name] = function(...a) {
        let o = REC.get(this); if (!o) REC.set(this, o = []);
        o.push(k); for (let i = 0; i < n; i++) o.push(k === 8 && i === 4 ? radius(a[4]) : +a[i] || 0);
        if (orig) return orig.apply(this, a);
      };
    }
    const add = native ? P.prototype.addPath : null;
    P.prototype.addPath = function(p, m) {
      const src = REC.get(p);
      if (src) { let o = REC.get(this); if (!o) REC.set(this, o = []); o.push(...src); }
      if (add) return add.call(this, p, m);
    };
  }
  (() => {
    const N = globalThis.Path2D;
    if (N?.atriumRecorded) return;
    const P = typeof N === "function" ? class extends N { constructor(a) { super(a); if (a && REC.has(a)) REC.set(this, REC.get(a).slice()); } }
      : class { constructor(a) { if (a && REC.has(a)) REC.set(this, REC.get(a).slice()); } };
    instrument(P, typeof N === "function");
    P.atriumRecorded = true; globalThis.Path2D = P;
  })();
  return Object.freeze({REC, NAMES, NARGS, radius});
})();

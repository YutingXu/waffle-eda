"use strict";
const {profiles} = require("./profiles.cjs");
const ids = profiles.map(p => p.id);
function compare(a, b) {
  const key = row => {const q = row.accepted; return [Number(!q.legal), Number(q.opens > 0), q.opens, q.vias, q.lengthMm, row.expansions];};
  const x = key(a), y = key(b);
  for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return x[j] - y[j];
  return 0;
}
const dot = (a,b) => a.reduce((s,v,i) => s+v*b[i],0);
// Four-variable ridge regression. The unpenalised intercept learns each profile's average rank.
function solve(A, rhs) {
  const m = A.map((r,i) => [...r,rhs[i]]);
  for (let i = 0; i < m.length; i++) {
    const divisor = m[i][i];
    if (!(divisor > 1e-10)) throw Error("Singular training problem");
    for (let k = i; k <= m.length; k++) m[i][k] /= divisor;
    for (let j = 0; j < m.length; j++) if (j !== i) {
      const factor = m[j][i];
      for (let k = i; k <= m.length; k++) m[j][k] -= factor * m[i][k];
    }
  }
  return m.map(r => r.at(-1));
}
function fit(training, heldFamily) {
  if (!training.length || training.some(b => b.family === heldFamily)) throw Error("Held-out family entered training or training is empty");
  const families = [...new Set(training.map(b => b.family))].sort();
  const weights = training.map(b => 1/training.filter(v => b.family === v.family).length);
  const mean = training[0].features.map((_,i) => training.reduce((s,b,j) => s+b.features[i]*weights[j],0)/families.length);
  const scale = mean.map((m,i) => Math.sqrt(training.reduce((s,b,j) => s+(b.features[i]-m)**2*weights[j],0)/families.length) || 1);
  const X = training.map(b => [1,...b.features.map((v,i) => (v-mean[i])/scale[i])]);
  const ranked = training.map(b => ids.map(id => b.runs[id]).map(r =>
    ids.reduce((s,id) => s+(compare(b.runs[id],r)<0 ? 1 : 0),0)/(ids.length-1)));
  const gram = X[0].map((_,i) => X[0].map((_,k) => X.reduce((s,x,j) => s+weights[j]*x[i]*x[k],0)+(k===i && i>0 ? 2 : 0)));
  const coefficients = Object.fromEntries(ids.map((id,c) => [id,solve(gram,X[0].map((_,i) =>
    X.reduce((s,x,j) => s+weights[j]*x[i]*ranked[j][c],0)))]));
  return {families, mean, scale, coefficients};
}
function choose(model, features) {
  const x = [1,...features.map((v,i) => (v-model.mean[i])/model.scale[i])];
  return ids.reduce((best,id) => dot(x,model.coefficients[id]) < dot(x,model.coefficients[best])-1e-12 ? id : best,ids[0]);
}
module.exports = {fit, choose, compare};

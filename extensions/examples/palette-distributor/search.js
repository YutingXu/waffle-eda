"use strict";
// The fixture below takes the place of fetch('https://catalog.example/parts', {signal}).
// Tests and the shipped example never contact a distributor.
exports.search = async ({query}, {signal, emit, data}) => {
  const matches = data.filter(p => (p.label + " " + p.detail).toLowerCase().includes(query.toLowerCase()));
  for (const p of matches) {
    await Promise.resolve();
    if (signal.aborted) return;
    emit([{id: p.id, label: p.label, detail: p.detail, accessory: p.stock + " · " + p.price, actions: [{id: "stock", label: "Warehouse stock"}]}]);
  }
};

"use strict";
const parts = require("./parts.json");
exports.activate = api => api.commands.register("benchstock.details", event => {
  const part = parts.find(p => p.id === event.itemId);
  if (!part) return {kind: "detail", title: "Benchstock", text: "This part is unavailable."};
  if (event.actionId === "stock") return {kind: "list", title: part.label + " stock", items: part.warehouses.map(([id, label, count]) => ({id, label, accessory: count + " available", icon: "folder"}))};
  return {kind: "detail", title: part.label, text: part.detail, blocks: [{kind: "text", text: part.stock + " available · " + part.price}], actions: [{id: "stock", label: "Warehouse stock"}]};
});

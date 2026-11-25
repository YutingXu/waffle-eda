"use strict";
exports.activate = api => api.commands.register("divider.calculate", event => {
  if (event.type === "submit") return {kind: "calculation", title: "Divider output", functionId: "example.divider.vout", version: "1.0.0",
    blocks: [{kind: "math", text: "V_{out}=\\frac{V_{in}R_{bottom}}{R_{top}+R_{bottom}}"},
      {kind: "richText", body: {blocks: [{style: "paragraph", runs: [
        {type: "text", text: "Input ", bold: true}, {type: "text", text: event.values.vin + " V"},
        {type: "text", text: "   Upper ", bold: true}, {type: "text", text: event.values.rtop + " Ω"},
        {type: "text", text: "   Lower ", bold: true}, {type: "text", text: event.values.rbottom + " Ω"}
      ]}]}}],
    arguments: [{value: event.values.vin, dimension: "voltage"}, {value: event.values.rtop, dimension: "resistance"}, {value: event.values.rbottom, dimension: "resistance"}]};
  return {kind: "form", title: "Voltage divider", fields: [
    {id: "vin", label: "Input voltage (V)", type: "number", value: 5, required: true},
    {id: "rtop", label: "Upper resistor (Ω)", type: "number", value: 1000, min: 0, required: true},
    {id: "rbottom", label: "Lower resistor (Ω)", type: "number", value: 2000, min: 0, required: true}
  ], primary: {id: "calculate", label: "Calculate"}};
});

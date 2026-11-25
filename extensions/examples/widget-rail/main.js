"use strict";
exports.activate = api => {
  api.commands.register("rail.view", ({state,inputs}) => ({
    title:state.caption, rows:[{cells:[{text:"VDD"},{text:inputs.rail.text,token:inputs.rail.broken?"broken":"ink"}]}]
  }));
};

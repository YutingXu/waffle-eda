"use strict";
exports.activate = api => {
  api.commands.register("inspection.view", ({state}) => ({
    title:"Inspections", rows:[{cells:[{text:String(state.count) + " complete"}]},
      {cells:[{text:"Record inspection",token:"accent"}],action:"increment"}]
  }));
  api.commands.register("inspection.event", ({state,event}) => ({
    state:{count:event.action === "increment" && event.type !== "focus" ? Math.min(10000,state.count+1) : state.count}
  }));
};

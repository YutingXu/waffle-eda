"use strict";

// Positive feature fixtures explicitly opt in. Keep the normal Preview profile untouched.
function seedProfile(values = {}) {
  if (typeof window !== "undefined" && window !== window.top) return;
  const store = "atrium.prefs";
  let saved;
  try {saved = JSON.parse(localStorage.getItem(store) || "null");} catch {}
  if (!saved || saved.format !== "atrium-prefs") saved = {format:"atrium-prefs",version:1,values:{}};
  saved.values = {...saved.values,...values,"labs.notebook":true};
  localStorage.setItem(store,JSON.stringify(saved));
}

async function profile(pageOrContext,values) {await pageOrContext.addInitScript(seedProfile,values);}

function enable() {
  if (globalThis.localStorage) seedProfile();
  require("../../app/editor/labs.js");
  const prefs = globalThis.AtriumPrefs;
  if (prefs) prefs.set("labs.notebook",true);
  else globalThis.AtriumLabs.bind({get:key=>key==="labs.notebook",on:()=>()=>{}});
  return globalThis.AtriumLabs;
}

module.exports={profile,seedProfile,enable};

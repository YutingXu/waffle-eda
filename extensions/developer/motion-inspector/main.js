"use strict";
const panel = "waffle-dev.motion-inspector", sampleCommand = "motion-inspector.sample";
const names = {full:"Full", reduced:"Reduced", off:"Off"};
const times = [["instant","Press, hover"], ["fast","Popovers, reveals"], ["base","Panels, dialogs"], ["slow","Camera flights"]];
const dispositions = {immediate:"At once", scheduled:"Animates", paused:"Paused"};
const heading = text => ({type:"heading", text});
const rows = rows => ({type:"kv", rows});
const summary = p => names[p.level] + " · " + (p.requested === "off" ? "Animations are set to Off"
  : p.efficient ? "Efficiency mode is on" : p.requested === "reduce" ? "Animations are set to Reduced"
  : p.osReduced ? "the system asks for less motion" : p.requested === "full" ? "Animations are set to Full" : "the system allows motion");

exports.activate = (api, context) => {
  const read = api.motion.inspect, render = view => api.ui.setPanel(panel, view);
  let inputs = {kind:"travel", curve:"standard", elapsedMs:100};
  let snapshot, sample, sampleError, failure, signature, session = 0, timer, reading = false, sampling = 0;
  const show = () => render(failure ? [{type:"text", level:"warn", text:failure}] : [
    heading("Policy"),
    rows([["Now",summary(snapshot.policy)],
      ["Overrides",[snapshot.policy.osReduced && "System reduce motion", snapshot.policy.efficient && "Efficiency"].filter(Boolean).join(" · ") || "None"],
      ["Window",snapshot.policy.suspended ? (snapshot.policy.visibility === "hidden" ? "Hidden · clocks paused" : "Covered · clocks paused") : "Visible · clocks run"],
      ["Eligible",[snapshot.policy.opacity && "fades", snapshot.policy.travel && "travel and camera", snapshot.policy.hover && "hover"].filter(Boolean).join(", ") || "nothing; changes land at once"],
      ["Keyboard","Always lands at once"]]),
    heading("Timings"),
    {type:"table", columns:[{key:"token", title:"Token"},{key:"use", title:"Use"},{key:"planned", title:"Planned", align:"right"},{key:"now", title:"Now"}], rows:snapshot.timings},
    heading("Try a track"),
    {type:"form", retainDraft:true, fields:[
      {key:"kind", label:"Kind", type:"enum", options:["fade","travel","camera"], value:inputs.kind},
      {key:"curve", label:"Curve", type:"enum", options:["standard","decelerate","drawer","linear"], value:inputs.curve},
      {key:"elapsedMs", label:"Elapsed visible time", type:"number", unit:"ms", required:true, value:inputs.elapsedMs, error:sampleError}
    ], submit:{label:"Sample and retarget", command:sampleCommand}},
    ...(sample ? [rows([["Eased value",Math.round(sample.current.value) + " of 100"],
      ["Progress",Math.round(sample.current.progress * 100) + " % · " + (sample.current.finished ? "finished" : "running")],
      ["Retarget to 40","starts from " + Math.round(sample.next.from) + " over " + sample.next.durationMs + " ms"]])] : []),
    heading("Live"),
    {type:"text", text:snapshot.count ? snapshot.count + (snapshot.count === 1 ? " track" : " tracks") + " running" : "No track running. The clock is idle."}
  ]);
  async function measure(input, repaint = true) {
    const epoch = session, sequence = ++sampling;
    inputs = input;
    const {kind, curve, elapsedMs} = input;
    const args = {kind, curve, elapsedMs, from:0, to:100, durationMs:kind === "camera" ? 320 : 200};
    try {
      const [current, next] = await Promise.all([read("sample", args), read("retarget", {...args, previousTarget:100, to:40})]);
      if (epoch !== session || sequence !== sampling) return;
      sample = {current, next}; sampleError = undefined;
    } catch (error) {
      if (epoch !== session || sequence !== sampling) return;
      sampleError = error.message.replace(/^args\.elapsedMs/, "Elapsed time");
    }
    if (repaint && (snapshot || failure)) await show();
  }
  async function refresh() {
    if (reading) return;
    const epoch = session;
    reading = true;
    try {
      const [policy, {count}] = await Promise.all([read("policy", {input:"pointer"}), read("active")]);
      const key = JSON.stringify(policy);
      if (epoch !== session || key === signature && count === snapshot?.count && !failure) return;
      const timings = key === signature ? snapshot.timings : await Promise.all(times.map(async ([token, use]) => {
        const p = await read("plan", {kind:token === "slow" ? "camera" : "fade", duration:token, level:policy.level});
        return {token:"--motion-" + token, use, planned:p.durationMs + " ms", now:dispositions[p.disposition]};
      }));
      if (epoch !== session) return;
      if (!sample && !sampleError) await measure(inputs, false);
      if (epoch !== session) return;
      snapshot = {policy, timings, count}; signature = key; failure = undefined;
      await show();
    } catch (error) {
      if (epoch !== session || error.message === failure) return;
      failure = error.message;
      snapshot = signature = sample = sampleError = undefined;
      await show();
    } finally { reading = false; }
  }
  function start() {
    if (!timer) timer = setInterval(() => refresh().catch(() => {}), 250);
    return refresh();
  }
  function stop() {
    clearInterval(timer); timer = undefined; session++;
    snapshot = signature = undefined;
  }
  context.subscriptions.push(api.events.on("panelShown", e => { if (e.id === panel) return start(); }),
    api.events.on("panelHidden", e => { if (e.id === panel) stop(); }),
    api.commands.register("motion-inspector.open", async () => { await api.ui.showPanel(panel); await start(); }),
    api.commands.register(sampleCommand, measure));
  context.subscriptions.push({dispose:stop});
};

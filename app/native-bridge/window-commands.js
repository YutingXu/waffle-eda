"use strict";

(() => {
  const W = globalThis.AtriumWindowWorkspace;
  const names = ["list-windows", "move-tab-to-new-window", "merge-all-windows", "list-workspace-layouts",
    "save-workspace-layout", "restore-workspace-layout"];
  const fail = (code, message) => { throw Object.assign(Error(message), {code}); };

  function layoutName(value) {
    const name = value.normalize("NFC").trim();
    if (!name || /[\u0000-\u001f\u007f]/u.test(name)) fail("invalid_arguments", "Choose a printable workspace layout name.");
    return name;
  }

  function run(command, args, {project, members, initialWindow, active, record, newWindow, preserveWriter}) {
    if (record && (record.version !== W.version || record.project !== project || !Array.isArray(record.saved)))
      fail("invalid_layout", "The stored workspace record is invalid for this project.");
    let {layout, missing} = W.restore(record?.current, project, members, initialWindow, active, {preserveWriter});
    const saved = (record?.saved ?? []).map(entry => ({name:entry.name, layout:entry.layout}));
    if (command === "list-windows") return {layout, missing};
    if (command === "list-workspace-layouts") return {layouts:saved.map(entry => entry.name)};
    if (command === "save-workspace-layout" || command === "restore-workspace-layout") {
      const name = layoutName(args.name), index = saved.findIndex(entry => entry.name === name);
      if (command === "save-workspace-layout") {
        if (index < 0) saved.push({name, layout}); else saved[index] = {name, layout};
      } else {
        if (index < 0) fail("layout_missing", "This project has no workspace layout with that name.");
        ({layout, missing} = W.restore(saved[index].layout, project, members, initialWindow, active, {preserveWriter}));
      }
    } else layout = W.plan(layout, command, {...args, newWindow});
    return {layout, missing, next:{version:W.version, project, current:layout, saved}};
  }

  globalThis.AtriumWorkspaceCommands = Object.freeze({run});
  globalThis.AtriumButter.register("windows", Object.fromEntries(names.map(command => [command, (args, context) => {
    if (context.source === "mcp") {
      if (!context.services.native) fail("unsupported_surface", "Open a native Waffle project to plan workspace changes.");
      return run(command, args, context.services.native);
    }
    const client = globalThis.AtriumProjectWindowClient;
    if (!client?.run) fail("unsupported_surface", "Project windows need a native editor host.");
    return client.run(command, args, context);
  }])));
})();

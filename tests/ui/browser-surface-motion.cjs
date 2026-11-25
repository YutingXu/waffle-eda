"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
let chromium;
try { ({chromium} = require("playwright-core")); }
catch { console.log("SKIP surface motion: Playwright Core is unavailable."); process.exit(0); }
const app = path.resolve(__dirname, "../../app");

async function run() {
  const executablePath = process.env.CHROME;
  const browser = await chromium.launch({headless:true, ...(executablePath ? {executablePath} : {channel:"chrome"})});
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="opener">Open</button>
      <dialog id="surface" class="ui-dialog"><button>Close</button></dialog>
      <details id="file" class="work-menu"><summary>File</summary><div class="menu-items"><button>Save</button></div></details>
      <details id="edit" class="work-menu"><summary>Edit</summary><div class="menu-items"><button>Undo</button></div></details>
      <div id="popover" class="ui-popover" hidden><button>Options</button></div>
      <div id="document-tabs"></div><div id="canvas-stage"></div>
    `);
    for (const file of ["style.css", "editor/polish.css", "ui/controls.css"]) await page.addStyleTag({path:path.join(app,file)});
    for (const file of ["ui/motion.js", "ui/surface-motion.js"]) await page.addScriptTag({path:path.join(app,file)});
    const result = await page.evaluate(async () => {
      const dialog = document.getElementById("surface"), opener = document.getElementById("opener");
      const file = document.getElementById("file"), edit = document.getElementById("edit");
      const pop = document.getElementById("popover"), M = AtriumSurfaceMotion;
      const motion = element => element.getAnimations().find(effect => effect.constructor === Animation);
      const read = element => Number(getComputedStyle(element).opacity);
      const settle = () => new Promise(resolve => setTimeout(resolve, 250));
      let exits = 0, closedAt;
      dialog.addEventListener("close", () => { exits++; closedAt = performance.now(); });
      opener.focus();
      dialog.showModal();
      await Promise.resolve();
      const entrance = motion(dialog);
      const fromScale = entrance.effect.getKeyframes()[0].transform;
      entrance.currentTime = 35;
      const before = read(dialog);
      const open = dialog.open && dialog.contains(document.activeElement);
      dialog.close();
      const leave = motion(dialog), closeFocus = !dialog.open && document.activeElement === opener;
      const leaveFrom = Number(leave.effect.getKeyframes()[0].opacity);
      leave.currentTime = 45;
      const fading = read(dialog);
      dialog.showModal();
      await Promise.resolve();
      const reopened = motion(dialog), reopenFrom = Number(reopened.effect.getKeyframes()[0].opacity);
      await settle();
      const reopenedSafely = dialog.open && !dialog.inert && !dialog.hasAttribute("aria-hidden") &&
        exits === 0 && getComputedStyle(dialog).opacity === "1";
      const closingAt = performance.now();
      dialog.close();
      await new Promise(requestAnimationFrame);
      const nativeExit = {open:dialog.open, rendered:getComputedStyle(dialog).display !== "none", exits,
        inert:dialog.inert, hidden:dialog.getAttribute("aria-hidden")};
      await settle();
      const eventualClose = exits === 1 && getComputedStyle(dialog).display === "none";

      M.menu(file, true);
      const menuEntrance = motion(file.querySelector(".menu-items")).effect;
      const menuIn = menuEntrance.getTiming().duration;
      const menuScale = menuEntrance.getKeyframes()[0].transform;
      M.menu(file, false, true);
      M.menu(edit, true, true);
      const switched = !file.open && edit.open && !motion(edit.querySelector(".menu-items"));
      M.menu(edit, false);
      const list = edit.querySelector(".menu-items"), menuOut = motion(list).effect.getTiming().duration;
      const menuInert = list.inert;
      M.menu(edit, true);
      await settle();
      const menuReopened = edit.open && !list.inert;

      M.popover(pop, true);
      M.popover(pop, false);
      const popClosed = pop.hidden && pop.inert;
      M.popover(pop, true);
      await settle();
      const popReopened = !pop.hidden && !pop.inert;
      document.documentElement.dataset.motion = "off";
      M.popover(pop, false);
      const off = pop.hidden && !pop.inert && !motion(pop);
      return {open, closeFocus, before, leaveFrom, fading, reopenFrom, reopenedSafely, nativeExit, eventualClose, closeElapsed:closedAt-closingAt,
        menuIn, menuOut, fromScale, menuScale, switched, menuInert, menuReopened, popClosed, popReopened, off,
        durationIn:entrance.effect.getTiming().duration, durationOut:leave.effect.getTiming().duration};
    });
    assert.equal(result.open, true);
    assert.equal(result.closeFocus, true);
    assert.equal(result.durationIn, 200);
    assert.equal(result.durationOut, 150);
    assert.match(result.fromScale, /scale\(0\.97(?:, 0\.97)?\)/);
    assert.match(result.menuScale, /scale\(0\.97(?:, 0\.97)?\)/);
    assert.ok(Math.abs(result.before - result.leaveFrom) < .002, JSON.stringify(result));
    assert.ok(Math.abs(result.fading - result.reopenFrom) < .002, JSON.stringify(result));
    assert.equal(result.reopenedSafely, true);
    assert.deepEqual(result.nativeExit, {open:false, rendered:true, exits:0, inert:true, hidden:"true"});
    assert.ok(result.closeElapsed >= 125, JSON.stringify(result));
    for (const key of ["eventualClose", "switched", "menuInert", "menuReopened", "popClosed", "popReopened", "off"])
      assert.equal(result[key], true, key);
    assert.equal(result.menuIn, 120);
    assert.equal(result.menuOut, 80);

    await page.addScriptTag({path:path.join(app,"editor/workbench.js")});
    const workbench = await page.evaluate(() => {
      delete document.documentElement.dataset.motion;
      const menus = [...document.querySelectorAll(".work-menu")], [file, edit] = menus;
      file.open = edit.open = false;
      file.querySelector("summary").click();
      const entering = file.querySelector(".menu-items").getAnimations().length;
      edit.querySelector("summary").click();
      const states = menus.map(menu => [menu.open, menu.querySelector("summary").getAttribute("aria-expanded"),
        menu.querySelector(".menu-items").getAnimations().length]);
      AtriumWorkbench.dismiss();
      return {entering, states};
    });
    assert.ok(workbench.entering > 0);
    assert.deepEqual(workbench.states, [[false,"false",0],[true,"true",0]]);

    await page.evaluate(() => {
      const opener = document.getElementById("opener"), dialog = document.getElementById("surface");
      opener.onclick = () => dialog.showModal();
      dialog.querySelector("button").onclick = () => dialog.close();
    });
    const keyboardMenu = page.locator("#file summary");
    await keyboardMenu.focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await keyboardMenu.evaluate(summary => ({
      open:summary.parentElement.open,
      effects:summary.parentElement.querySelector(".menu-items").getAnimations().length,
    })), {open:true, effects:0});
    await page.keyboard.press("Escape");
    assert.equal(await keyboardMenu.evaluate(summary => summary.parentElement.open), false);
    await page.locator("#opener").focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.locator("#surface").evaluate(dialog => ({
      open:dialog.open, effects:dialog.getAnimations().length,
    })), {open:true, effects:0});
    await page.keyboard.press("Escape");
    assert.deepEqual(await page.locator("#surface").evaluate(dialog => ({
      open:dialog.open, effectCount:dialog.getAnimations().length, focused:document.activeElement.id,
    })), {open:false, effectCount:0, focused:"opener"});

    await page.locator("#opener").click();
    assert.equal(await page.locator("#surface").evaluate(dialog =>
      dialog.getAnimations().some(effect => effect.constructor === Animation)), true);
    await page.locator("#surface button").click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById("surface")).display === "none");
    await page.emulateMedia({reducedMotion:"reduce"});
    const reduced = await page.evaluate(async () => {
      delete document.documentElement.dataset.motion;
      const surface = document.getElementById("surface");
      surface.showModal();
      await Promise.resolve();
      const entrance = surface.getAnimations().find(effect => effect.constructor === Animation);
      const keys = entrance.effect.getKeyframes();
      entrance.currentTime = 50;
      const opacity = Number(getComputedStyle(surface).opacity);
      surface.close();
      return {scales:keys.some(key => Object.hasOwn(key,"transform")), fading:opacity > 0 && opacity < 1,
        closed:!surface.open, focused:document.activeElement.id};
    });
    assert.deepEqual(reduced, {scales:false, fading:true, closed:true, focused:"opener"});

    await page.emulateMedia({reducedMotion:"no-preference"});
    await page.addStyleTag({path:path.join(app,"ui/components.css")});
    await page.addScriptTag({path:path.join(app,"editor/nav-common.js")});
    const toast = await page.evaluate(async () => {
      const toast = AtriumToast.show("Design rule check complete", {ms:200});
      const transition = property => toast.getAnimations().find(effect => effect.transitionProperty === property);
      const tracks = (phase, properties) => properties.map(property => {
        const animation = transition(property);
        if (!animation) throw Error(`Missing toast ${phase} ${property} transition`);
        return animation;
      });
      const durations = animations => animations.map(animation => animation.effect.getTiming().duration);
      const sample = (animations, time) => {
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = time;
        }
        const style = getComputedStyle(toast);
        return {display:style.display, opacity:Number(style.opacity), y:new DOMMatrixReadOnly(style.transform).m42};
      };
      const properties = ["transform", "opacity"];
      const enter = tracks("entrance", properties), inMs = durations(enter);
      const reused = AtriumToast.show("Design rule check finished", {ms:200}) === toast &&
        properties.every((property, index) => transition(property) === enter[index]);
      const height = toast.getBoundingClientRect().height;
      const start = sample(enter, 0);
      for (const animation of enter) animation.finish();

      // Capture the exit in the same task as the timer's hidden change. A later frame may already
      // have flipped display to none and removed the completed CSS transition objects.
      await new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
          if (!toast.hidden) return;
          observer.disconnect();
          clearTimeout(timeout);
          resolve();
        });
        const timeout = setTimeout(() => {
          observer.disconnect();
          reject(Error("Toast did not expire"));
        }, 2000);
        observer.observe(toast, {attributeFilter:["hidden"]});
      });
      const leave = tracks("exit", [...properties, "display"]), outMs = durations(leave);
      const target = leave[0].effect.getKeyframes().at(-1).transform;
      const leaving = sample(leave, outMs[0] / 2);
      const end = sample(leave, outMs[0] - 1);
      for (const animation of leave) animation.finish();
      return {reused, height, inMs, outMs, start, leaving, end, target, still:document.activeElement.id,
        gone:getComputedStyle(toast).display === "none"};
    });
    assert.equal(toast.reused, true);
    assert.deepEqual(toast.inMs, [140, 140]);
    assert.deepEqual(toast.outMs, [80, 80, 80]);
    assert.ok(toast.height > 0);
    assert.equal(toast.start.display, "flex");
    assert.equal(toast.start.opacity, 0);
    assert.ok(Math.abs(toast.start.y - toast.height / 4) < .05, "toast rises by a quarter of its height");
    assert.match(toast.target, /translateY\(/);
    assert.equal(toast.leaving.display, "flex");
    assert.ok(toast.leaving.opacity > 0 && toast.leaving.opacity < 1, "toast fades while rendered during exit");
    assert.ok(toast.leaving.y > 0 && toast.leaving.y < toast.end.y, "toast sinks during exit");
    assert.equal(toast.end.display, "flex", "the toast is rendered until the 80 ms exit ends");
    assert.ok(Math.abs(toast.end.y - toast.height / 4) < .05, "toast sinks by a quarter of its height");
    assert.equal(toast.still, "opener");
    assert.equal(toast.gone, true);
    console.log("PASS dialog, menu, popover, and toast motion. Keyboard is instant and Reduced retains fading. Dialog close event at " +
      Math.round(result.closeElapsed) + " ms, with focus restored immediately.");
  } finally { await browser.close(); }
}

run().catch(error => { console.error(error); process.exit(1); });

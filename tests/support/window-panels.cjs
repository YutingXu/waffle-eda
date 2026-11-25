"use strict";
// Window › Panels, the way a user reaches every panel now that the right-edge icon rail is gone:
// open the Window menu, hover Panels, choose the panel. The item opens a closed panel, brings one
// behind a tab to the front, or closes (a core panel: collapses the side bar) the one in front.

const ITEM = target => '#sub-window-panels [data-dock-target="' + target + '"]';

async function openPanelsMenu(page, {touch = false} = {}) {
  const press = node => touch ? node.tap() : node.click();
  const menu = page.locator('.menubar details[data-menu="window"]');
  if (!await menu.evaluate(node => node.open)) await press(menu.locator(":scope > summary"));
  const sub = menu.locator("#sub-window-panels");
  await press(sub.locator(":scope > .submenu-trigger"));
  await sub.locator(":scope > .menu-items").waitFor();
  return sub;
}

// Choose a panel's Window › Panels item: a dock id ("library", "nets", "properties") or a data-action.
// {touch:true} taps instead of clicking, for touch profiles.
async function windowPanel(page, target, options = {}) {
  const sub = await openPanelsMenu(page, options);
  const item = sub.locator('[data-dock-target="' + target + '"], [data-action="' + target + '"]').first();
  await (options.touch ? item.tap() : item.click());
  await page.locator('.menubar details[data-menu="window"][open]').waitFor({state:"detached"}).catch(() => {});
}

// Whether the Panels item for this dock id shows its check (dock.js syncs it whenever the menu opens).
async function panelChecked(page, target) {
  await openPanelsMenu(page);
  const on = await page.locator(ITEM(target)).getAttribute("aria-checked");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  return on === "true";
}

// Bring a panel to the front without toggling it closed: its tab when one shows, else the menu.
async function showPanel(page, target, options = {}) {
  const how = await page.evaluate(id => {
    const panel = document.querySelector('[data-dock-panel="' + id + '"]');
    if (panel?.getClientRects().length && !panel.classList.contains("dock-inactive")) return "shown";
    const tab = document.querySelector('.dock-tabs:not([hidden]) [data-dock-tab="' + id + '"]');
    return tab?.getClientRects().length ? "tab" : "menu";
  }, target);
  const tab = page.locator('.dock-tabs:not([hidden]) [data-dock-tab="' + target + '"]');
  if (how === "tab") await (options.touch ? tab.tap() : tab.click());
  else if (how === "menu") await windowPanel(page, target, options);
}

module.exports = {ITEM, openPanelsMenu, windowPanel, panelChecked, showPanel};

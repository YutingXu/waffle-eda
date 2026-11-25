#!/usr/bin/env python3
"""Get set up (app/editor/welcome.js) in headless Chrome with Playwright.

On first launch, open Customise Waffle from the Welcome actions. Pick Altium (Coming from), Dark
(Theme) and mm (Units). Check that the choices and progress survive a restart, that Customise Waffle
and the Help action reopen the walkthrough, and that arrow keys move between steps. Page errors fail.

Usage: tests/editor/welcome-browser.py [--shots DIR]   (screenshots at 860×600 and 520×640, deviceScaleFactor 2)
Env: CHROME=/path/to/chrome when Playwright's own Chromium is not installed.
Exit status: 0 pass, 1 fail, 2 Playwright or a browser is missing.
"""
import os, shutil, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("welcome-browser: Playwright is not installed (pip install playwright)"); sys.exit(2)

SHOTS = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else None
URL = "file://" + os.path.join(ROOT, "app", "index.html")
problems = []


def check(ok, what):
    print(("ok    " if ok else "FAIL  ") + what)
    if not ok: problems.append(what)


def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, name + ".png"))


def launch(p, profile):
    opts = dict(viewport={"width": 860, "height": 600}, device_scale_factor=2)
    try:
        return p.chromium.launch_persistent_context(profile, **opts)
    except Exception:
        chrome = os.environ.get("CHROME") or "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        if not os.path.exists(chrome): print("welcome-browser: no Chromium; set CHROME"); sys.exit(2)
        return p.chromium.launch_persistent_context(profile, executable_path=chrome, headless=True, **opts)


def boot(ctx, errors):
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_selector("dialog.sp-dialog[open]", timeout=20000)
    return page


def main():
    profile = tempfile.mkdtemp(prefix="atrium-welcome-")
    errors = []
    try:
        with sync_playwright() as p:
            ctx = launch(p, profile)
            # ---- first launch
            page = boot(ctx, errors)
            home = page.locator("dialog.sp-dialog[open]")
            for label in ("New Project…", "Open…", "Import from Altium or KiCad…",
                          "Recover Unsaved Work…", "Try the Demo", "Continue to editor"):
                check(home.get_by_role("button", name=label, exact=True).is_visible(), "first launch offers " + label)
            check(home.locator(".sp-templates").is_visible() and not home.locator(".wl-panel").is_visible(),
                  "first launch opens the template and project actions")
            check(page.evaluate("AtriumNavHost.isStarter() && !AtriumNavHost.isDirty() && AtriumNavHost.project().documents.every(d => !d.items.length)"), "the initial workspace is blank and clean")
            ctx.set_offline(True)
            try:
                opener = home.get_by_role("button", name="Getting started", exact=True)
                guide = page.get_by_role("dialog", name="Getting started", exact=True)
                for _ in range(2):
                    opener.click()
                    guide.get_by_role("heading", name="Welcome and recent projects", exact=True).wait_for()
                    check(guide.get_by_text("run_output_job", exact=False).count() == 1,
                          "packaged guide shows the command text unchanged while offline")
                    check(guide.locator("article .ui-shortcut .shortcut-spoken").evaluate_all(
                        "nodes => nodes.some(node => node.textContent === AtriumKeymap.display('Mod+Shift+P', true))"),
                        "packaged guide renders the palette chord with the shared Shortcut")
                    page.keyboard.press("Escape")
                    guide.wait_for(state="hidden")
                    check(opener.evaluate("(node) => document.activeElement === node"),
                          "closing the guide restores the Welcome control")
            finally:
                ctx.set_offline(False)
            home.get_by_role("button", name="Customise Waffle…", exact=True).click()
            page.wait_for_selector(".wl-panel .wl-step", timeout=10000)
            check(not home.locator(".sp-templates").is_visible(), "the walkthrough takes the templates' place")
            before = page.evaluate("({theme: JSON.stringify(AtriumTheme.get()), prefs: localStorage.getItem('atrium.prefs'), keys: AtriumKeymap.preset()})")
            check(before["prefs"] is None and before["keys"] == "altium", "nothing is applied before a choice")
            check(page.get_attribute('.wl-step[data-step="from"] .wl-head', "aria-expanded") == "true", "the first step is open")
            page.wait_for_timeout(400)
            shot(page, "01-first-launch-dark")
            page.click('.wl-step[data-step="from"] label.wl-option:has(input[value="altium"])')
            got = page.evaluate("({keys: AtriumKeymap.preset(), wheel: AtriumPrefs.get('mouse.wheel')})")
            check(got == {"keys": "altium", "wheel": "altium"}, "Coming from Altium: Altium keys, the wheel scrolls")
            page.click('.wl-step[data-step="from"] .wl-next')
            check(page.get_attribute('.wl-step[data-step="theme"] .wl-head', "aria-expanded") == "true", "Next opens the theme step")
            page.wait_for_selector('.wl-step[data-step="theme"] .wl-option')
            page.click('.wl-step[data-step="theme"] label.wl-option:has(input[value="light"])')
            check(page.evaluate("[document.documentElement.dataset.theme, AtriumTheme.get().followSystem]") == ["light", False], "Light applies at once")
            page.wait_for_timeout(500)
            shot(page, "02-theme-light")
            page.click('.wl-step[data-step="theme"] label.wl-option:has(input[value="dark"])')
            check(page.evaluate("AtriumTheme.get().preset") == "dark", "back to Dark: changing it back undoes it")
            page.wait_for_timeout(500)
            shot(page, "03-theme-dark")
            page.click('.wl-step[data-step="units"] .wl-head')
            page.click('.wl-step[data-step="units"] label.wl-option:has(input[value="mm"])')
            state = page.evaluate("JSON.parse(localStorage.getItem('atrium.welcome.v1'))")
            check(all(state["done"].get(k) for k in ("from", "theme", "units")) and state["from"] == "altium", "state persisted: from, theme and units done")
            check(page.inner_text(".wl-count").startswith("3 of"), "progress shows 3 done")
            # A click on a one-decision step's choice opens the next step and scrolls it into view.
            page.wait_for_function("AtriumWelcome.state().open === 'mouse'", timeout=3000)
            check(page.evaluate("(() => { const h = document.querySelector('.wl-step[data-step=\"mouse\"] .wl-head').getBoundingClientRect(), c = document.querySelector('.sp-right').getBoundingClientRect(); return h.top >= c.top - 1 && h.bottom <= c.bottom; })()"),
                  "choosing the units moves on to Mouse and navigation, scrolled into view")
            # Keyboard: arrows move between step headings and only select (no automatic move).
            page.focus('.wl-step[data-step="units"] .wl-head')
            page.keyboard.press("ArrowDown")
            check(page.evaluate("document.activeElement.closest('.wl-step')?.dataset.step") == "mouse", "ArrowDown moves to the next step")
            page.focus('.wl-step[data-step="mouse"] input[value="zoom"]')
            page.keyboard.press("ArrowDown")
            page.wait_for_timeout(700)
            check(page.evaluate("[AtriumWelcome.state().open, AtriumPrefs.get('mouse.wheel')]") == ["mouse", "altium"], "arrow keys choose without moving on")
            for wheel in ("zoom", "altium"):
                if page.get_attribute('.wl-step[data-step="mouse"] .wl-head', "aria-expanded") != "true":
                    page.click('.wl-step[data-step="mouse"] .wl-head')
                page.click('.wl-step[data-step="mouse"] label:has(input[value="' + wheel + '"])')
                check(page.evaluate("AtriumWelcome.state().done.mouse && AtriumPrefs.get('mouse.wheel')") == wheel, "wheel choice alone completes Mouse and navigation: " + wheel)
                page.wait_for_function("AtriumWelcome.state().open === 'motion'", timeout=3000)
            shot(page, "04-mouse-dark")
            page.click('.wl-step[data-step="theme"] .wl-head')
            page.click('.wl-step[data-step="theme"] label.wl-option:has(input[value="ember"])')
            page.click('.wl-step[data-step="motion"] .wl-head')
            page.wait_for_function("!document.documentElement.hasAttribute('data-theme-fading')")
            page.evaluate("""window.motionWindowChanges = []; window.motionObserver = new MutationObserver(records => motionWindowChanges.push(...records.map(r => r.attributeName)));
                motionObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme', 'data-theme-id', 'data-theme-fading']})""")
            for motion in ("full", "reduce", "off", "system"):
                page.click('.wl-step[data-step="motion"] label:has(input[value="' + motion + '"])')
                check(page.evaluate("[AtriumTheme.get().motion, AtriumTheme.effectivePreset()]") == [motion, "ember"], "motion changes in the selected theme: " + motion)
            check(page.evaluate("motionWindowChanges.length") == 0, "motion never reapplies or cross-fades the window theme")
            page.evaluate("motionObserver.disconnect()")
            page.emulate_media(reduced_motion="reduce")
            page.wait_for_function("document.querySelector('.wl-motion-stage').dataset.level === 'reduce'")
            check(page.locator(".wl-motion-stage").get_attribute("data-level") == "reduce", "System preview follows reduced motion")
            page.click('.wl-step[data-step="motion"] button:has-text("Close Properties")')
            check(not page.is_visible(".wl-motion-stage .wl-mock-side"), "the preview closes its Properties panel")
            page.click('.wl-step[data-step="motion"] button:has-text("Open Properties")')
            check(page.is_visible(".wl-motion-stage .wl-mock-side"), "the preview reopens its Properties panel")
            page.click('.wl-step[data-step="performance"] .wl-head')
            page.click('.wl-step[data-step="ai"] .wl-head')
            check(page.evaluate("!!AtriumWelcome.state().done.performance"), "opening the next card accepts the displayed performance defaults")
            page.wait_for_timeout(300)
            check("never writes another app" in page.inner_text('.wl-step[data-step="ai"]'), "AI step: the privacy note")
            shot(page, "05-ai-dark")
            # Narrow window.
            page.set_viewport_size({"width": 520, "height": 640})
            page.click('.wl-step[data-step="theme"] .wl-head')
            page.wait_for_timeout(300)
            overflow = page.evaluate("(() => { const d = document.querySelector('dialog.sp-dialog'); return d.scrollWidth - d.clientWidth; })()")
            check(overflow <= 1, "narrow window: no sideways scroll")
            shot(page, "06-narrow-dark")
            page.click('.wl-step[data-step="theme"] label.wl-option:has(input[value="light"])')
            page.wait_for_timeout(500)
            shot(page, "07-narrow-light")
            page.click('.wl-step[data-step="theme"] label.wl-option:has(input[value="dark"])')
            page.set_viewport_size({"width": 770, "height": 478})
            column = page.locator(".sp-right")
            finish = page.get_by_role("button", name="Finish setup")
            finish.scroll_into_view_if_needed()
            check(column.evaluate("el => el.scrollTop > 0"), "Finish setup is reachable below the fold at the Mac minimum size")
            finish.click()
            check(page.is_visible(".sp-templates") and page.evaluate("AtriumNavHost.isStarter()"), "Finish setup returns to the home screen with a blank workspace")
            check(column.evaluate("el => el.scrollTop === 0"), "the home screen returns to the top of its templates")
            check(not page.evaluate("!!AtriumWelcome.state().done.ai"), "visiting the optional AI instructions does not claim a connection")
            page.set_viewport_size({"width": 860, "height": 600})
            done = page.evaluate("AtriumWelcome.progress().done")
            page.close()

            # ---- second launch
            page = boot(ctx, errors)
            page.wait_for_selector(".sp-templates .sp-card", timeout=10000)
            check(not page.is_visible(".wl-panel"), "second launch: the normal start page")
            home = page.locator("dialog.sp-dialog[open]")
            link = home.get_by_role("button", name="Customise Waffle…", exact=True)
            check(link.is_visible(), "Welcome offers Customise Waffle")
            check(str(done) + " " in link.locator(".sp-customise-detail").inner_text(), "the action shows the saved progress")
            check(page.evaluate("({keys: AtriumKeymap.preset(), wheel: AtriumPrefs.get('mouse.wheel'), theme: AtriumTheme.get().preset, units: AtriumPrefs.get('general.units')})")
                  == {"keys": "altium", "wheel": "altium", "theme": "dark", "units": "mm"}, "the choices survive a restart")
            page.wait_for_timeout(300)
            shot(page, "08-second-launch-dark")
            link.click()
            page.wait_for_selector(".wl-panel .wl-step")
            check(page.evaluate("document.activeElement.classList.contains('wl-head')"), "Customise Waffle opens the walkthrough and focuses it")
            check(page.get_by_role("button", name="Finish setup").count() == 1, "Get set up has one finish action")
            page.get_by_role("button", name="Finish setup").click()
            check(page.is_visible(".sp-templates") and not page.is_visible(".wl-panel"), "Finish setup brings the templates back")
            home.get_by_role("button", name="Try the Demo", exact=True).click()
            page.wait_for_function("AtriumNavHost.project().name === 'Sensor interface' && !AtriumStartPage.isOpen()")
            check(not page.evaluate("AtriumNavHost.isDirty()"), "Try the Demo opens a clean, editable Sensor interface project")
            page.evaluate("AtriumNavHost.act('customise-waffle')")
            page.wait_for_selector(".wl-panel .wl-step", timeout=10000)
            check(page.is_visible("dialog.sp-dialog[open] .wl-panel"), "Help › Customise Waffle reopens it")
            page.evaluate("AtriumTheme.setPreset('light')")
            page.wait_for_timeout(500)
            shot(page, "09-reopened-light")
            page.evaluate("AtriumTheme.setPreset('dark')")
            # Fab house: File › New applies the chosen preset as the start page's blank project does.
            page.click('.wl-step[data-step="fab"] .wl-head')
            page.wait_for_function("document.querySelector('.wl-step[data-step=\"fab\"] select')?.querySelector('option[value=\"jlcpcb-4l\"]')", timeout=10000)
            page.select_option('.wl-step[data-step="fab"] select', "jlcpcb-4l")
            check(page.evaluate("AtriumPrefs.get('start.fabPreset')") == "jlcpcb-4l", "Fab house: the preference is set")
            page.keyboard.press("Escape")
            page.evaluate("AtriumNavHost.act('new')")
            name = page.get_by_role("dialog", name="New project", exact=True).get_by_role("textbox")
            name.fill("Fab test")
            name.press("Enter")
            page.wait_for_function("AtriumNavHost.project().name === 'Fab test'", timeout=10000)
            got = page.evaluate("(() => { const b = AtriumNavHost.project().documents.find(d => d.kind === 'pcb'); return [b.fabPreset?.id, document.getElementById('status')?.textContent]; })()")
            check(got[0] == "jlcpcb-4l" and "JLCPCB 4-layer" in (got[1] or ""), "File › New applies the fab preset: " + str(got))
            with page.expect_download() as saved:
                page.evaluate("AtriumNavHost.act('save')")
            page.wait_for_function("!AtriumNavHost.isDirty()")
            archive = os.path.join(profile, "Fab test.zip")
            saved.value.save_as(archive)
            page.reload()
            home = page.locator("dialog.sp-dialog[open]")
            with page.expect_file_chooser() as chooser:
                home.get_by_role("button", name="Open…", exact=True).click()
            chooser.value.set_files(archive)
            opening = page.get_by_role("dialog", name="Open project ZIP", exact=True)
            opening.get_by_role("button", name="Open project", exact=True).click()
            page.wait_for_function("globalThis.AtriumPrefs && AtriumNavHost.project().name === 'Fab test'")
            check(not home.is_visible() and not page.evaluate("AtriumNavHost.isDirty()"),
                  "Welcome opens the downloaded native project as a clean workspace")
            page.evaluate("AtriumPrefs.set('general.startPage', 'always')")
            page.close()
            # Finder and the other desktop hosts set this before scripts run in a new file window.
            page = ctx.new_page()
            page.add_init_script("window.__atriumOpeningProject = true")
            page.goto(URL)
            page.wait_for_function("globalThis.AtriumPrefs && globalThis.AtriumNavHost")
            plan = page.evaluate("AtriumAutosave.boot()")
            check(plan.get("openingFile") and page.evaluate("AtriumNavHost.isStarter() && !document.querySelector('dialog[open]')"), "a file opened by the host takes precedence over recovery and Always show home")
            page.close()
            ctx.close()
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    check(not errors, "no page errors" + (": " + "; ".join(errors[:3]) if errors else ""))
    print("welcome-browser: " + ("ok" if not problems else "%d failed" % len(problems)))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())

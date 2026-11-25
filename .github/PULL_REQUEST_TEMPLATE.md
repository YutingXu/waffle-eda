## What and why

<!-- What does this change, and which issue does it address? -->

## How it was checked

- [ ] `scripts/test-jsc.sh` (or `node tests/run.cjs`) passes for the touched modules
- [ ] `scripts/click-through.sh` passes if menus or actions changed
- [ ] `scripts/startup-budget.sh --static` stays within budget if eager scripts changed
- [ ] `python3 scripts/gen-shortcuts.py --check` if `app/editor/keymap.js` changed
- [ ] `tests/automation/headless-parity.py` if a menu action was added (headless path or documented exception)
- [ ] Screenshots for visible UI changes (dark and light theme)

## Clean-room and licensing

- [ ] No code, text, screenshots, icons, libraries or fixtures copied from vendor software or documentation (CONTRIBUTING.md)
- [ ] Format work is based on: <!-- own files / public spec / open-source reader (name + licence) -->
- [ ] New third-party code is listed in THIRD_PARTY_NOTICES.md with its licence text
- [ ] Other companies' marks are used only descriptively (e.g. "Altium-style", "imports KiCad files")

## Security-sensitive areas

- [ ] This touches extensions, proposals, the MCP server or native hosts (needs two maintainer approvals; see GOVERNANCE.md)

By submitting, I agree my contribution is released under the MIT License.

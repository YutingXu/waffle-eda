# Translating Waffle EDA

Waffle's user interface can be translated by the community. English is the source language and
the fallback. A locale is one JSON file in `app/locales/`, and anything it leaves out is shown in
English. This page covers how translation works, how to contribute a locale, the glossary policy
for EDA terms, the review process, and how module owners make their own text translatable.

Waffle ships English and the pseudo-locale `en-XA`, which is for testing. Every other language
comes from contributors.

## How it works

| Piece | File | Notes |
|---|---|---|
| Eager shim | `app/i18n.js` | Under 1 KB. In English it only stores `define()` tables and fills in `{name}` placeholders. No catalogue loads and nothing watches the DOM. |
| Core | `app/i18n-core.js` | Lazy (`AtriumLazy.need("AtriumI18nCore")`). It provides ICU plurals and selects, Intl number, unit and date formatting, locale choice and switching. It replaces `AtriumI18n` when it loads and keeps the shim's definitions. |
| Shell translator | `app/i18n-dom.js` | Loaded only for a locale other than English. It translates rendered text by its English source (see below), retitles keyboard commands, and observes the DOM for text that modules add later. |
| Catalogues | `app/locales/<id>.json` | Translators edit these. `en.json` and `en-XA.json` are generated. |
| Loaders | `app/locales/<id>.js` | Generated from the JSON. The app loads scripts, not JSON, so it also works from `file://`. |
| Tooling | `scripts/i18n-extract.py` | Extracts the strings, generates the pseudo-locale and loaders, and runs the CI check. |

**Keys.** A key is `<namespace>.<slug of the English text>`, for example
`menu.new_project_more` → `New Project…`. The namespace tells you where the text appears:

| Namespace | Where the text appears |
|---|---|
| `menu` | Menu bar and submenus, including **Window → Panels** |
| `cmd` | Command titles in the command palette, keyboard-shortcut editor and cheat sheet. `cmd.<id>`, `cmd.<id>.pcb` and `cmd.<id>.schematic` are per-editor titles; `cmd.<id>.short` is the label in key-sequence hints. |
| `category` | Command categories |
| `shell` | Title bar, Active Bar, panel headings, rail and tooltips |
| `status` | Status-bar messages |
| `prefs` | Preferences |
| `start` | Start page and templates |
| `common` | Dialog buttons in every dialog: OK, Cancel, Apply, Close… |

Keys from a module's `define()` table, used through `t(key, params)`, are written by hand
(`bom.rows`).

To find out where a string is used:

```sh
python3 scripts/i18n-extract.py --where "New Project…"
```

**Matching rendered text.** `i18n-dom.js` inverts `en.json` for each namespace. A text node or a
`title`, `aria-label`, `placeholder` or `data-label` whose text is exactly an English source
string, inside a scope that uses that namespace, becomes the locale's string. The scopes are
`SCOPES` in `i18n-dom.js` plus each `AtriumI18n.scope()` call. This needs no code change in the
module, but it only works for whole strings. Concatenated text such as `"Grid: " + value` must
use `t()`.

**Switching.** Preferences › General › Language offers System default, English and every locale
in `app/locales/`. The pseudo-locale is listed but "System" never picks it.
- **Switches at once:** the menus, status bar, start page, Preferences and command titles.
- **Switches the next time it is shown:** text that modules have already built with `t()`.
- **After a restart:** everything.

The Preferences page says so when the language changes.

## Contributing a locale

1. Copy `app/locales/en.json` to `app/locales/<id>.json`, where `<id>` is a BCP 47 tag such as
   `de`, `fr`, `pt-BR` or `zh-Hans`.
2. Set the metadata:

   ```json
   "@locale": "de", "@name": "German", "@native": "Deutsch"
   ```

   For a right-to-left script, add `"@dir": "rtl"`.
3. Translate the values. Never change the keys. Delete any entry you have not translated rather
   than leaving English in it: a missing key falls back to English and counts as untranslated
   in the coverage report.
4. Run `python3 scripts/i18n-extract.py`. It writes your locale's loader (`<id>.js`) and adds
   the locale to the list in `i18n-core.js` and `i18n.js`.
5. Run `python3 scripts/i18n-extract.py --check` and `--coverage`, then open Waffle and choose
   your language in Preferences › General.
6. Open a pull request with the JSON and the regenerated files. Say which coverage you reached.
   Partial locales are welcome.

### Message syntax

Waffle uses a subset of ICU MessageFormat:

```
Hello {name}
{count, plural, =0 {No rows} one {# row} other {# rows}}
{kind, select, pcb {track} other {wire}}
{value, number}   {value, number, integer}   {value, number, percent}
{width, unit, mm}  {when, date, short}  {when, time}
```

- **Placeholders.** Keep every `{placeholder}` name exactly as in English. The check fails on a
  placeholder that is missing, extra or renamed.
- **Plurals.** Use the plural categories your language needs (`zero`, `one`, `two`, `few`,
  `many`, `other`; see the CLDR plural rules). `other` is required. `#` is the formatted number.
- **Apostrophes.** Write the typographic apostrophe `’`. ICU's `'` quoting is not supported.
- **Shortcuts.** Keyboard hints in parentheses, such as `(Ctrl+M)` or `(P, V)`, name keys. Leave
  them as they are.
- **Ellipsis.** Keep `…` on labels that open a dialog. Waffle's menu rules depend on it.

## Glossary policy

Electronics design has a settled international vocabulary, and many engineers know the English
term better than any translation. Follow these rules, in this order:

1. **Use what engineers in your language use at work.** If datasheets, fabricator websites and
   local forums say "Via", keep "Via".
2. **Follow the IPC standard term** (IPC-T-50 and the localized IPC editions) where your language
   has one in common use.
3. **Leave these untranslated** unless rule 1 clearly says otherwise: via, pad, net, netlist,
   footprint (or the IPC term "land pattern"), Gerber, Excellon, ODB++, IPC-2581, STEP, BOM, DRC,
   ERC, ECO, ratsnest, polygon pour, teardrop, fanout, stack-up, rigid-flex, diff pair.
4. **Never translate** file formats and extensions (`.PcbDoc`, `.kicad_pcb`), product names
   (Waffle, KiCad, Altium Designer®), units (mm, mil, oz, Ω), layer names that come from a
   design (Top Layer, Mechanical 1), designators (R1, U3) or anything a user typed.
5. **One term, one translation.** Keep a glossary table at the top of your pull request and use
   it consistently. Reviewers check it first.
6. **Match the English capitalisation style of your language.** Menus are Title Case in English.
   Use your platform's convention (sentence case in German, French and most other languages).

## Review process

- **Who reviews.** Each locale has at least one listed reviewer who is a native speaker and
  works with EDA tools. Add yourself to `MAINTAINERS` under "Locales" when you take on a
  language. A locale with no active reviewer for six months is marked unmaintained, but it
  keeps shipping.
- **What CI checks.** `i18n-extract --check` runs in CI (`scripts/ci-local.sh static` and the
  Linux job). It catches keys English no longer has, broken braces and placeholders that don't
  match. It does not judge wording.
- **What reviewers check.**
  - the glossary table and its consistent use;
  - placeholders and plurals read naturally;
  - nothing is truncated in the app (take a screenshot of the menus, Preferences and the start
    page);
  - shortcuts and file formats are untouched.
- **Merging.** One reviewer approval merges a locale change (GOVERNANCE.md, day-to-day rule).
  A locale's first pull request needs the reviewer plus one maintainer.
- **When English changes.** A changed English string gets a new key. The old translation then
  shows up as an unused key, so the check fails until it is removed or translated again. The
  person changing the English runs the script. Translators pick up new keys from the coverage
  report.

## Testing with the pseudo-locale

Choose **Pseudo-locale (testing)** in Preferences › General › Language, or run this in the
console:

```js
AtriumI18n.setLocale("en-XA")
```

Every string the pseudo-locale translates appears accented, about 35% longer, and in
`[brackets]`. That shows three kinds of problem:

- **Hard-coded text.** Anything still in plain English is not translatable yet.
- **Truncation.** Text cut off before the `]` is truncated.
- **Concatenation.** A sentence split across several bracketed pieces is concatenated.

To list the shell text that has no catalogue entry:

```js
AtriumI18nDOM.audit()
```

With `localStorage["atrium.dev"] = "1"`, each missing key is logged to the console once.

## For module owners: making a module translatable

The first pass covered the shell: menus, command titles, status bar, start page, Preferences
and dialog buttons. Other modules convert one at a time. To see what remains in each module:

```sh
python3 scripts/i18n-extract.py --coverage
```

The report shows strings converted, plain literals remaining, and concatenation fragments.

1. **Static strings: no code change.** Add the file to `SOURCES` in `scripts/i18n-extract.py`,
   either as `"literals"` (every prose-like string literal) or as a regular expression for the
   calls that carry UI text. Then register the module's DOM root once it is built:

   ```js
   globalThis.AtriumI18n?.scope(".bom-dialog", ["bom"]);
   ```

   Mark a literal that must not be translated with an `// i18n-ignore` comment on its line.
2. **Dynamic strings: use `t()`.** Replace each concatenation with a message:

   ```js
   const t = globalThis.AtriumI18n.define({
     "bom.rows": "{count, plural, one {# row} other {# rows}}",
     "bom.exported": "Exported {file}"
   });
   status.textContent = t("bom.rows", {count: rows.length});
   ```

   The shim fills in `{name}` placeholders. Plurals, selects and Intl formats need the core, so a
   module that uses them adds `"AtriumI18nCore"` to its `deps` in `lazy.js`. An eager file that
   may run headless without `i18n.js` guards the call. `workbench.js` does it this way:

   ```js
   I ? I.t("status.grid", {value: v}) : "Grid: " + v
   ```
3. **Numbers, units and dates:** use `AtriumI18n.number(n)`, `unit(0.25, "mm")`,
   `date(d, "short")` and `ago(d)` from the core. Never build `"1,234"` by hand.
4. **Layout:**
   - Never size a control to its English text. Use `min-width:0` with `text-overflow:ellipsis`,
     `white-space:nowrap` on single-line labels, and flexible widths.
   - Use logical properties: `margin-inline-start`, `padding-inline`, `inset-inline-end`,
     `text-align:start`.
   - Check the module in `en-XA`.
5. Run `python3 scripts/i18n-extract.py`, commit `en.json`, `en-XA.json` and the loaders with
   your change, and check that `--check` passes.

Right-to-left: setting `"@dir": "rtl"` on a locale sets `<html dir="rtl">`. The shell's chrome
uses logical properties where that was cheap: the menu bar, status bar, project tree and command
centre. The canvas, the panels and many dialogs are not RTL-ready yet.

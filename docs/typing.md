# Type checking without a build step

Waffle's runtime stays plain JavaScript. Each `app/*.js` file is a `"use strict"` IIFE that sets
one `globalThis.AtriumX`, loaded by `<script>` tags (`app/index.html`) or by `app/lazy.js`.
TypeScript's compiler checks those same files in place, with `tsc --noEmit`. The types live in
`.d.ts` files and JSDoc comments, so nothing is compiled, bundled or emitted, and the app that
ships is byte-for-byte the code that was checked.

```sh
scripts/typecheck.sh            # check; fails on any error types/baseline.json does not allow
scripts/typecheck.sh --update   # record the current error counts (read every new error first)
python3 types/gen-globals.py --add   # declare new module globals in types/globals.d.ts
python3 tests/maintenance/types-model.py    # model.d.ts vs app/model.js and the VS Code JSON schema
```

CI runs `scripts/typecheck.sh` in the `static` step on macOS (`scripts/ci-local.sh static`) and
on Linux (`scripts/ci-linux.sh static`). A check takes about 3 seconds.

## Why there is no build step

- The app loads its files straight from disk. WKWebView, WebKitGTK and WebView2 open `file://`
  pages, and `lazy.js` injects `<script src>` tags with no fetch or `import()`. A compile step
  would add a second artefact that could drift from the source, and a toolchain that every
  contributor, the MCP headless runner and the JavaScriptCore test shim would need.
- Startup bytes are budgeted (`scripts/startup-budget.sh`). Types in `.d.ts` files cost nothing at
  run time.
- TypeScript reads JavaScript natively. `checkJs` gives most of the value of TypeScript (unknown
  names, misspelt members, wrong arity, DOM misuse, mismatched shapes across modules) without
  changing a line of the runtime.
- Node is only a check-time tool. `scripts/typecheck.sh` installs the pinned Node
  (`scripts/ci/install-node.sh`, SHA-256 checked) and TypeScript (`scripts/ci/package-lock.json`,
  integrity checked) under `~/.cache/atrium-ci`, or uses the ones in the Linux CI image.

## What is where

| File | Role |
|---|---|
| `types/tsconfig.json` | Compiler options, and `files`: the declarations plus every checked module |
| `types/baseline.json` | The ratchet: `checked` files, `expected` error counts, `ignoredCodes` |
| `types/globals.d.ts` | Every `globalThis.AtriumX` global, the native bridge `AtriumHostAPI`, the hand-typed core APIs (`AtriumModelAPI`, `AtriumLazyAPI`, `AtriumIOAPI`, `AtriumConnectivityAPI`) |
| `types/model.d.ts` | The data model: `Project`, documents (schematic, pcb, panel, drawing), every item kind, library definitions, nets, `Rules`, `Stackup` |
| `types/gen-globals.py` | Reads each module's exported member names; writes them to a temporary `.d.ts` on every check |
| `types/typecheck.py` | Runs tsc and judges the output against the baseline |
| `scripts/typecheck.sh` | Finds or installs Node and TypeScript, then runs `types/typecheck.py` |
| `tests/maintenance/types-model.py` | `model.d.ts` agrees with `app/model.js` and `integrations/vscode/schema/waffle.schema.json` |
| `tests/maintenance/typing-regressions.cjs` | Tests for the bugs the type check found |

## How the globals are typed

Load order varies: `index.html` loads the eager modules, `lazy.js` the rest on first use, and the
headless runners, workers and tests load their own subsets. The declarations therefore never
depend on which file defines a global or when it loads. Each global is declared once, as a
`var`, in `types/globals.d.ts`. Checking any subset of files sees the same types.

- **Most globals** are `AtriumGen<"AtriumX">`. `types/gen-globals.py` reads the object each
  module returns (`return {a, b, c}` or `return Object.freeze({...})`) and lists its members,
  each typed `any`. The list is regenerated on every check, so it never goes stale. It is
  enough to catch `AtriumBOM.normalizeView` when the member is `normaliseView`. A module whose
  export cannot be read (a spread, a variable) stays `any`.
- **Core modules** have a hand-written interface (`declare var Waffle: AtriumModelAPI`). The
  generated check makes sure the interface and the module export exactly the same member
  names, even when the module itself is not checked. The bridge check makes sure every member
  of `window.AtriumHost` in `native/bridge.js` is in `AtriumHostAPI`.
- **Presence is not typed.** Every global is declared as always present, because the checker
  cannot know the load order. Code still guards lazy modules at run time with
  `globalThis.AtriumX?.` or `AtriumLazy.need()`, and the checker's "this condition is always
  true" report on such guards (TS2774) is ignored.
- **A new module** is declared automatically by the generated file, so it never breaks the
  check. `scripts/typecheck.sh` prints a note until you add its line to `globals.d.ts`
  (`python3 types/gen-globals.py --add`).

## Compiler settings, and why

`strict` is on, except for two settings:

- **`strictNullChecks` is off.** Without annotations, strict null checks type `[]` as `never[]`
  and `let best = null` as `null`. On the first 30 modules, 1,265 errors with it on fell to 121
  with it off, and every report sampled from the difference was a false positive. The `.d.ts` files are still
  written null-aware (`Box | null`, optional members), ready for a strict tier.
- **`noImplicitAny` is off.** Eager modules cannot carry JSDoc, because every comment byte counts
  against the startup budget. Their parameters stay untyped, and the `.d.ts` files type the
  module boundaries instead.

`useUnknownInCatchVariables` is off (`catch (e) { e.message }` is the house style).
`skipLibCheck` is off, so our own `.d.ts` files and the generated export checks are checked.

## The ratchet (`types/baseline.json`)

- `checked` lists the files under type checking. **The list may only grow.** A module that is
  deleted or merged into another may leave it; `scripts/typecheck.sh` prints a note so the entry
  can be removed. `types/tsconfig.json` `files` must list the same modules.
- `expected` holds, per file and error code, how many errors are tolerated. **Counts may only
  fall.** Every count was read when it was recorded: they are false positives of checking
  unannotated JavaScript. The core files carry a `why`. When a file has fewer errors than
  allowed, the check prints a note so the count can be lowered.
- `ignoredCodes` are never counted: TS2774 (runtime presence guards, above) and TS2810
  (`new Promise(r => ... r())` with no value).
- The check fails on an error beyond the expected count, on a `checked` or `tsconfig.json`
  mismatch, on a `.d.ts` error (including the export checks), and on a `tests/maintenance/types-model.py`
  failure. Compared with the baseline at `TYPECHECK_BASE_REF` (default `HEAD`), it also fails
  when a file left `checked` or an `expected` count grew. Without git, or without the file at
  that ref, the comparison is skipped with a note.

## Adding types to a module

1. **Check it.** Add the file to `checked` in `types/baseline.json` and to `files` in
   `types/tsconfig.json`, then run `scripts/typecheck.sh`.
2. **Read every error.** Fix real bugs, each with a test (see `tests/maintenance/typing-regressions.cjs`).
   Behaviour must not change otherwise.
3. **Type the boundary.**
   - **Eager module** (listed in `app/index.html`): no JSDoc in the file. Write
     `interface AtriumXAPI` in a `types/*.d.ts` file and change its line in `globals.d.ts` to
     `declare var AtriumX: AtriumXAPI;`. Builders that unannotated JavaScript widens (a literal
     `kind: "part"` becomes `string`) return `Built<T, "kind">`.
   - **Lazy module**: JSDoc is fine. Put `@typedef`s at the top of the file and `@param` /
     `@returns` on the exported functions. Mark item builders with
     `/** @type {ViaItem} */ ({...})`. Prefer `.d.ts` types when the shape is shared.
4. **Record what remains.** Run `scripts/typecheck.sh --update`. Add a `why` for the file when
   the errors are not obvious.

Conventions:

- Lengths are millimetres, Y points down, angles are degrees.
- `Point` and `Box` are `number[]`, not tuples, because JavaScript array literals are never
  inferred as tuples.
- A field the validator requires is required in `model.d.ts`; everything else is optional.
  Items and documents allow extra fields (`[extra: string]: any`), because modules add their
  own.
- Do not add `// @ts-check`: the `files` list is the switch, and in an eager file the pragma
  costs bytes. Do not add `// @ts-ignore` either. Record the count in the baseline instead.
- Do not reformat code to please the checker. Use annotations and minimal edits.

## Not checked yet

Mostly the DOM-heavy UI modules (`editor.js`, `workbench.js`, `shell.js`, `print.js`, `dock.js`,
`palette.js`...). They build objects incrementally and pass DOM nodes through untyped helpers,
so most of their reports are false positives until helpers like `el()` are typed.

# Library management: a proposal

20 November 2026 · design proposal, no code changes

**Recommendation.** Each component is a single, versioned record that you place in one step. A
team library is a plain folder of small JSON files. You keep it in git, and Waffle never asks you
to set up a search path. Every project embeds a frozen copy of each component it uses, so it opens
the same way years later. When the library moves ahead, Waffle shows a visual diff and asks before
it changes the project. Waffle adopts Horizon EDA's identity rules (references by stable ID, never
by name) but keeps the Altium vocabulary. A heavy Altium user should recognise a component, a
symbol and a footprint without learning about units, entities and padstacks.

## 1. What Waffle has today

The groundwork is already in place. The weak spots are where libraries live, how they are shared
and how they scale.

| Area | What exists | Where |
|---|---|---|
| Definition ("def") | Symbol, footprint, parameters and an optional `model3d` in one record. Placed parts reference `def` by ID. | `project.library[]`, `app/library-panel.js` |
| Project library | Embedded in the `.atrium` file. Every component a design uses is in the file. | `app/model.js` |
| Reusable library | `.atrlib`, one JSON file (`format: "atrium-library", version: 1`). It removes fields that look like credentials when it reads or writes. | `libraryFile` / `readLibraryFile` |
| Provenance link | `def.libraryRef = {library, name, id, hash}`, where the hash is a 52-bit FNV content fingerprint (`defHash`). | `fromLibrary`, `libraryStatus` |
| Update from library | Status (changed upstream, changed locally, same or missing), a text diff (`diffDefs`), `updateParts` re-wiring, and the MCP tool `update_parts_from_library` | `library-panel.js` |
| Library sources | Kept per browser in `localStorage` (`atrium.libraries.v1`) **as a cached copy of every def**. The desktop host can re-read a file by absolute path (16 MB cap, `.atrlib`/`.json` only). | `sourceStore`, `native/macos/HostState.swift` |
| Families | Family › chip model › exact package. Each package is a separate def, and families never change a placed part's `def`. | `app/component-families.js`, `app/library-families-ui.js` |
| Catalogue | Category tree, parametric facets, Unicode folding, a lazy per-def index. Search takes about 1 ms per keystroke at 5,000 defs. | `app/catalogue.js` |
| Content | 42 starter parts (no MPNs), generic parts with deterministic hashed IDs, the IPC-7351B footprint wizard, and a symbol wizard that reads CSV, `.kicad_sym` and SchLib | `starter-library.js`, `generic-parts.js`, `footprint-wizard.js`, `symbol-wizard.js` |
| Import | Altium `.SchLib`/`.PcbLib` (binary and ASCII) and KiCad `.kicad_sym` (symbols only). There is no IntLib, DbLib, `.kicad_mod`/`.pretty` or EAGLE `.lbr` import. | [Importing](../importing.md) |
| BOM | Columns similar to ActiveBOM: MPN, supplier, supplier part number and lifecycle. It reads an offline JLC CSV and calls opt-in supplier APIs. Keys stay in `localStorage`. Alternates come from `def.related`. | `app/bom.js`, `app/bom-optimiser.js`, `app/related-parts.js` |
| Diff and merge | AtriumDiff has a `library` category (`library.symbol`, `library.footprint` and the designators affected). Merge3 matches `library/<id>`. | [Diff](../../app/history/diff.js), [folder format](../format-2.md) |

**Current pain points:**

1. **One file per library.** A team `.atrlib` is one large JSON array. Two students who add
   different parts cause a git conflict on the same file, and a review shows a 4,000-line diff.
2. **Library sources live in browser storage.** The full defs are cached in `localStorage`, which
   holds about 5 MB. A few embedded STEP models fill it. A second computer does not know your
   libraries.
3. **3D models are inline text.** `footprint.model3d.stepText` holds the whole STEP file in every
   def that uses it, in every project and in every library copy.
4. **Names do some of the linking.** IDs are mostly stable, but `legacyName` and the
   name-matching paths for SchLib/PcbLib still exist. That is the same class of bug as Altium's
   "footprint not found".
5. **No revisions people can read.** "Library changed" is a yes/no answer from a hash. Nobody can
   say "you have rev 3, the library has rev 5" or see why.
6. **The diff is text only.** `diffDefs` lists the changes. It does not draw the old pads over the
   new ones.

## 2. What goes wrong elsewhere

| Tool | Model | What hurts in practice |
|---|---|---|
| **Altium SchLib + PcbLib** | Symbols and footprints in separate files. A symbol names its footprint by *name*, plus an optional library. Installed libraries, project libraries and search paths all resolve that name. | Results depend on resolution order. One footprint name exists in three libraries. Moving a folder breaks every link. The "Footprint not found" dialog appears. |
| **Altium IntLib** | A compiled, read-only package of the above | You decompile it to edit and recompile to publish, so the source and the compiled copy drift apart. Nobody can tell which IntLib a board used. |
| **Altium DbLib / SVNDbLib** | A database row (Access, Excel or ODBC) points to a symbol and a footprint in SchLib/PcbLib files. The SVN variant puts those files under SVN. | Parameters, symbol and footprint live in three systems. ODBC drivers are Windows-only. Spreadsheet edits never show up in a diff. The group's "library person" becomes a single point of failure. |
| **Altium Workspace (A365)** | Managed components with item revisions, lifecycle states, Part Choices and "Update from Libraries" | It is conceptually the best Altium option, but it needs the cloud and a licence. Revision schemes and lifecycle are heavy for a five-person lab. You cannot use it offline or put it in your own git, and students lose access when they graduate. |
| **KiCad** | `sym-lib-table` and `fp-lib-table` (global and per project) of nicknames. The symbol's Footprint field holds a `Lib:Name` string. The schematic embeds symbol copies and the board embeds footprint copies. 3D models are found through paths such as `${KICAD9_3DMODEL_DIR}`. | Nicknames collide and differ between machines. The symbol and footprint pairing happens late and is easy to get wrong. Missing 3D models from bad environment-variable paths are the most common complaint. "Atomic or not" is an open argument. Embedded caches save old projects but make updates confusing. |
| **EAGLE / Fusion** | `.lbr` device sets: gates, packages, pin-to-pad connects and "technologies". Fusion moved these to managed libraries in the cloud. | Device sets are a good model; they match Waffle families well. The cloud move made offline work and versioning awkward. |
| **Horizon EDA** | A *pool* is a folder of JSON files with UUIDs: unit (pins), symbol (graphics), entity (gates), package (footprint and 3D), padstack and part (entity + package + pad map + MPN). Parts can inherit from a base part. SQLite indexes the pool, and git with pull requests manages it. Each project has its own pool cache. | The model is clean, references never break and merges work well. It has five concepts before you place a resistor, which is a steep start for Altium users. |
| **LibrePCB** | Similar to Horizon: component, symbol, package and device, with UUIDs, versions and a project copy. | Same strengths, same learning curve |

**What Waffle takes from these tools:**

- From Horizon and LibrePCB: UUID references, one file per element, git-native libraries and an
  index rebuilt from files.
- From KiCad: the project embeds what it uses.
- From EAGLE: device sets, which Waffle already has as families.
- From Altium Workspace: revisions, lifecycle, and update with impact analysis.

**What Waffle leaves out:**

- Search paths and name resolution
- Compiled libraries
- SQL databases as the source of truth
- The cloud as a requirement

## 3. Data model

### Identity, revisions and content

Everything addressable has a **stable ID** (a UUID). Every saved state also has a **content
hash**, the SHA-256 of a canonical JSON form. Pure content addressing for components would be
wrong: each edit would change the ID and break every reference. Content addressing *is* right for
large, immutable blobs such as STEP files.

| Thing | Identity | Version | Notes |
|---|---|---|---|
| Component | UUID | `rev` (integer, +1 on each library save) + `hash` | The unit you place and the BOM line |
| Symbol | UUID | `rev` + `hash` | Several components can share one symbol |
| Footprint | UUID | `rev` + `hash` | Several components can share one footprint. Wizard footprints keep their spec. |
| 3D model | SHA-256 of the bytes | (immutable) | Stored once, referenced as `{sha256, name, offset, rotation}` |
| Family | UUID (exists) | follows the library | Unchanged |

The `rev` number exists for people ("rev 3 → rev 5"). The hash is what Waffle compares. Two
libraries that disagree on `rev` but share a hash are equivalent.

### A component, concretely

```jsonc
// components/opa2333-soic8-<uuid>.json
{
  "id": "6f1c…", "rev": 5, "name": "OPA2333 · SOIC-8",
  "symbol":    {"id": "a2e9…", "hash": "…"},              // dual op-amp, 2 gates + power
  "footprint": {"id": "91bd…", "hash": "…"},              // SOIC127P600X175-8N (wizard spec kept)
  "pinMap": null,                                         // null = pin number equals pad number
  "parameters": {"Value": "OPA2333", "Supply": "1.8–5.5 V"},
  "manufacturer": "", "mpn": "",                          // only the user or a lookup the user ran fills these
  "datasheet": "",
  "state": "released",                                    // draft | review | released | deprecated
  "verified": {"by": "…", "date": "2026-11-12", "against": "datasheet rev D, fig. 41"},
  "related": [],                                          // alternates / associated hardware (exists)
  "source": {"kind": "altium-schlib", "file": "Analog.SchLib", "sha256": "…", "entry": "OPA2333"}
}
```

These are the opinionated decisions in that record:

- **Components are atomic.** A placed part is always a complete binding of symbol, footprint and
  pin map, with an MPN or a generic marking. Waffle does not offer KiCad-style late binding of a
  footprint by string. Generic parts and placeholders (§14) are the deliberate exception: their
  value and ratings stay on the placed part, and a placeholder is *resolved* to an atomic
  component later.
- **One component is one package.** This rule already holds for families. A chip with three
  packages is three components in one family, and one symbol can serve all of them.
- **An explicit pin map, only when needed.** A `pinMap` covers cases such as SOT-23 transistors
  (BCE versus EBC) or a symbol reused across packages with different pad numbering. When numbers
  match, the field is absent, which keeps files small and compatible.
- **Lifecycle is not supply status.** `state` records whether the *library entry* is
  trustworthy. EOL and NRND are *manufacturer* facts that come from supplier data at BOM time. They
  are never stored in the library. Altium tends to blur the two.
- **"Verified" is a record, not proof.** It says who checked the footprint against which drawing.
  Health checks and the BOM display it. Only a person in the UI can set it (see §9).

### In the project file

The `.atrium` project keeps its **inline snapshots**, so each def still carries its full symbol
and footprint. That preserves single-file projects, the merge driver's `library/<id>` keys,
readability by older builds and the "never break data" rule. The only additions are minor-version
fields, which older readers keep unchanged:

- `libraryRef` gains `rev` and `symbol`/`footprint` sub-references `{id, rev, hash}`. It keeps the
  existing `library`, `id` and `hash`.
- **3D blobs are stored once per project.** A new top-level `project.blobs = {<sha256>: {name,
  base64 | stepText}}` replaces repeated `stepText` in each def's `model3d`. An older build sees a
  `model3d` without text, draws the bounding box it already draws and keeps the blob table on save.
  It loses nothing, and the 3D view degrades only in that older build. Undo already keeps STEP text
  in a side table. This change applies the same idea on disk.

This counts as a **minor** bump under [format versioning](../format-versioning.md): optional fields only, plus a
corpus file. Waffle does not move to a reference-only project format, which would need a major
bump and would make old projects depend on a library being present.

## 4. Where libraries live

Waffle has four tiers, always listed in this order. The order is for display only. Resolution
never depends on it, because every reference names a library ID and a component ID.

| Tier | Location | Writable | Typical use |
|---|---|---|---|
| **Project** | Inside the `.atrium` file | Yes | The frozen copies a design uses, and one-off parts |
| **Personal** | `~/Documents/Waffle/Libraries/Personal.atrlib/` (Windows: `%USERPROFILE%\Documents\…`; Linux: `$XDG_DOCUMENTS_DIR/…`) | Yes | Your own parts, before you propose them to the group |
| **Team (git)** | Any cloned repository, registered once in **Library sources** (for example `~/src/lab-library/`) | Yes, through git | The group's shared, reviewed library |
| **Built-in** | Shipped with the app: starter and generic parts | No | Getting started. You copy a part into Personal to edit it. |
| *Downloads (quarantine)* | App data cache, for example `~/Library/Application Support/Waffle/downloads/` | No | Permissively licensed third-party data, kept outside every repository until you adopt it (§7) |

Library sources move out of `localStorage` and into a small settings file in the app's data
folder. That file holds only `{id, name, path}`, never cached defs. The desktop host needs one new
capability: to list and read files under a library root the user has granted, and to write there
for writable libraries. On macOS this uses security-scoped bookmarks, the same mechanism as the
current library file list. The browser build keeps single-file `.atrlib` bundles, and uses the File
System Access API where it is available.

### The library folder format

```
lab-library.atrlib/
  library.json            {format: "atrium-library-dir", formatVersion: "1.0", id, name, licence, description}
  components/<slug>-<id>.json
  symbols/<slug>-<id>.json
  footprints/<slug>-<id>.json
  models/<sha256>.step    (or a Git LFS pointer; Waffle only needs the hash)
  families.json
  .atrium-index.json      optional, generated, git-ignored
```

Each element is one file, so two students who add different parts never conflict. A pull request
that edits one footprint shows one small file. A `<slug>-<id>` filename stays readable in
`git log` and stays unique when two people both add "LM358". Single-file `.atrlib` version 1 stays
as the interchange **bundle**: Waffle still reads it, writes it through Export, and can unpack it
into a folder. The folder format follows the same minor/major policy as projects and has its own
compatibility corpus.

## 5. Versioning and safe updates

The project always holds a snapshot, so **an update is a choice to pull, never something that
happens to you**. Both sides of every comparison are on the machine: the project's embedded copy
and the library's current file. The diff never needs library history or a network.

### Status

On project open, Waffle compares each def's `libraryRef` with the index of the registered
sources. This runs once, after loading and when the app is idle, and again after the library's
git HEAD changes. It never runs on each render.

| Status | Meaning | Shown as |
|---|---|---|
| Current | Project hash equals the library hash | (nothing) |
| Update available | The library moved ahead (rev 3 → rev 5); the project copy is untouched | A blue dot in the Library panel, plus a count in the panel header |
| Edited here | The project copy changed; the library did not | A pencil icon. **Save to library…** offers rev 6. |
| Diverged | Both changed | An amber icon. The diff shows three columns: base, project and library. |
| Source missing | The library is not registered on this machine | A grey icon. The design still works. |

The Library panel shows one quiet notice per project: *"4 components have library updates ·
Review…"*. Following the user's preferences, there is no modal dialog and no hover pop-up.

### The update dialog

The current `showDiff` text list grows into a visual review that reuses AtriumDiff's `library`
category and canvas overlays:

1. **Symbol:** old and new drawn on top of each other, with added pins in green and removed pins
   in red, followed by a pin table showing number, name, type and gate.
2. **Footprint:** a pad overlay, a courtyard outline and a 3D bounding box if one changed.
   Numbers stand out where pads moved more than 0.01 mm.
3. **Parameters and sourcing:** a table, with MPN changes highlighted.
4. **Impact:** the placed designators that use the component, which pins would lose a net
   connection, which pads have routed copper attached, and a
   DRC and ERC preview of the result.
5. **Choice:** *Update all*, *Update selected designators* or *Keep project copy*. The update is
   one undo step and is recorded in the History panel with "rev 3 → rev 5".

"Update all" updates every out-of-date component in one batch, but each line of the diff stays
inspectable.

**Library history** belongs to git. Waffle reads it read-only through the existing
`native/git_head.py` binding, so **Compare with rev 2** and *who changed this pad* use the
existing file-history and blame features, scoped to the component's file. Waffle never commits on
your behalf. The user commits with their usual tool, which fits a research group's workflow.

## 6. Provenance, licences and deduplication

Every symbol, footprint and 3D model records where it came from:

```jsonc
"source": {"kind": "wizard" | "generic" | "altium-schlib" | "altium-pcblib" | "altium-intlib" | "kicad" | "eagle" | "download" | "manual" | "ai",
           "file": "…", "sha256": "…", "entry": "…", "licence": "CC0-1.0", "url": "…", "date": "…", "tool": "atrium 0.6.0"}
```

- **Wizard footprints keep their spec**, so a later wizard fix can offer "regenerate rev 4 with
  the corrected IPC table" as an ordinary update with a diff.
- **Imports keep the source file's SHA-256.** A re-import of the same SchLib is recognised as
  "nothing new".
- **AI-created assets** are `kind: "ai"` and always start as `state: "draft"`.

**Deduplication.** Footprints are compared by a *geometry hash*: pads with their numbers, sizes,
shapes and drills, plus the courtyard, rounded to 1 µm and sorted, without names or silk text.
Symbols are compared by a pin-set hash. On import or save, an exact match offers to link to the
existing asset ("This footprint is identical to `SOIC127P600X175-8N` in *Lab*. Use it?"). A match
on geometry alone, with different silk, is a health-check note, never an automatic merge. The
catalogue's existing removal of std/starter duplicates becomes a special case of this mechanism.

## 7. Downloads, kept untrusted

Waffle never invents supplier part numbers and never fetches data from a source whose licence is
not permissive. When it does download:

- **Allowlist by SPDX licence.** CC0-1.0, CC-BY-4.0, MIT, BSD and Apache-2.0 are allowed by
  default. **Open question:** KiCad's official libraries are CC-BY-SA-4.0 with a design exception.
  Waffle should not download them automatically until the project decides that the exception is
  acceptable. A user can always import their *own* local copy.
- **Quarantine.** Downloads go to the app-data downloads folder, never into a repository. The
  sandboxed import worker parses them under the existing size budget and with text scrubbing. They
  are read-only.
- **Adopt.** **Copy to Personal/Team** creates draft components with `source.kind: "download"`,
  the licence and the URL. They stay drafts until a person verifies them.

## 8. Search

The catalogue's facets and query syntax already work well. The change is to let them search
**every source at once** without loading every geometry:

- **A compact index per library.** Each component gets one row: ID, rev, hash, name, category,
  value, package, pin count, mounting, MPN, manufacturer, state, verified, has-3D and family.
  Waffle builds it from the files and caches it in IndexedDB, keyed by the git tree hash (or by
  modification times when git is absent). A `git pull` invalidates only the changed files.
- **New facets and terms:** `lib:lab`, `state:released`, `verified:yes`, `has:3d`, `mpn:`,
  `mfr:`, `updates:yes` and `unused:yes`.
- **Previews load lazily**, as they do now. Geometry is read only for the selected or visible row.
- **Target:** 50,000 components with a median of 2 ms and a worst case of 16 ms per keystroke. If
  JavaScript cannot reach that, the index scan is a natural Rust/WASM kernel, but the JavaScript
  version comes first and is measured first.

## 9. Health checks

The checks extend `validateDef` and `checkFootprint`. They are cached by content hash and re-run
only for elements whose hash changed. They run in the panel, in a **Library › Check Library…**
report and headlessly for CI.

| Check | Level | Notes |
|---|---|---|
| A pin has no pad, or a pad has no pin (except mechanical pads or EPs mapped through `pinMap`) | Error | This is the most expensive mistake to find on a real board |
| Duplicate pin numbers in one gate; a gate without power pins | Error | ERC already covers part of this |
| The footprint has no courtyard; silk overlaps pads; pads short | Error or warning | Comes from `checkFootprint` |
| No 3D model; the model's bounding box does not match the courtyard or lies off-centre | Warning | Catches a common KiCad pain early |
| A wizard table value marked unverified (⚑) | Warning | Already tracked in the wizard |
| A released component without an MPN (non-generic) or without a datasheet | Warning | Generic parts say "needs sourcing" |
| `verified` is missing on a released component | Warning | |
| A downloaded asset without a licence, or with a licence that is not allowed | Error | |
| Special strings that will reach fabrication outputs literally | Warning | Review the manufacturing text before export |
| A symbol or footprint that no component uses; a near-duplicate geometry | Info | |
| A newer spec exists for a wizard footprint | Info | Offers to regenerate |

**Release gate.** Moving a component to `released` requires zero errors. For warnings you can
either fix them or enter a short reason when you accept them. Waffle writes that reason into the
file, so a reviewer can see it in the git diff.

## 10. Team sharing through git

This is the intended setup for a research group:

1. The group creates `lab-library` on its GitHub or GitLab host. **Library › New Team Library…**
   writes `library.json`, a `.gitattributes` file (`*.step` through LFS is optional) and a CI
   template.
2. Each member clones it and registers it once in **Library sources**.
3. To add a part, a member works in Personal or directly on a branch of the team library, then
   opens a pull request.
4. **CI.** `waffle library check` (health checks; it fails on errors) and `waffle library diff
   origin/main...HEAD --images` run on the existing self-hosted runners and post the symbol and
   footprint overlays as PR comments. Reviewers see the pads without opening Waffle.
5. After a `git pull`, every project that uses the library shows "updates available" the next time
   it opens.

Git conflicts are rare, because each component has its own file. A conflict within one component
goes to the existing three-way merge view (`AtriumMerge3`). Extending the merge driver to
`components/*.json`, `symbols/*.json` and `footprints/*.json` is a small addition. A
`CODEOWNERS` file on `components/` lets a lab manager approve released parts, if the group wants
that.

## 11. Import and migration

| Source | Today | Proposal |
|---|---|---|
| Altium SchLib + PcbLib | Imported | Pair them into **atomic components** through the symbol's footprint model reference, matched by name *only within the files you selected*. List ambiguous and unmatched entries in an import report. Record `source` with the file hash. |
| Altium IntLib | — | An IntLib is a compound file holding compressed SchLib and PcbLib streams. The existing OLE reader should unpack it into the path above. Verify against redistributable samples. |
| Altium DbLib / SVNDbLib | — | **Migration wizard:** read the `.DbLib` text mapping (table, key and the fields for symbol, footprint and parameters). Then accept an **Excel or CSV export** of the database, and the SchLib/PcbLib files or the SVN checkout. Waffle does not support ODBC. The output is one component per row with its parameters, MPN and manufacturer. This is likely the most valuable migration for a group that uses DbLib. |
| Altium 365 Workspace | — | No API access. Document the export route: save or export to SchLib/PcbLib or IntLib, then use the import paths above. |
| KiCad `.kicad_sym` | Symbols only (symbol wizard) | Keep it, plus the paths below |
| KiCad `.pretty` / `.kicad_mod` | — | Import footprints. Parse `sym-lib-table` and `fp-lib-table` to find libraries, then join symbols to footprints through their `Lib:Name` Footprint field into atomic components. Ask once how `${KICAD*_3DMODEL_DIR}` should map, and remember the answer. |
| EAGLE `.lbr` | — | Device sets map directly to family › chip › package, with connects becoming `pinMap`. This is a later phase. |
| Waffle `.atrlib` v1 and localStorage sources | Supported | Unpack into a folder library automatically, offered once. Keep the original file. |

Every migration ends with a report, like the design import report. It lists counts, duplicates
linked, ambiguous pairs and missing 3D models. **Every imported component starts as `draft`.** You
can release a batch after the health checks pass.

## 12. MCP and AI

The catalogue and `update_parts_from_library` already work headless. The proposal completes a
consistent set of tools:

| Tool | Mode | Purpose |
|---|---|---|
| `library_search` | read | Query across all sources (`find` syntax plus the new facets) |
| `library_get` | read | One component with its symbol, footprint and provenance |
| `library_status` | read | Project defs against their sources: current, update available, diverged or missing |
| `library_diff` | read | A structured diff and an optional rendered overlay (PNG) |
| `library_check` | read | Health checks for a component, a library or the project |
| `library_update_parts` | edit (proposal) | Returns the impact report. Applies only with `--allow-write`, as one undo step. |
| `library_import` | edit (proposal) | A sandboxed child process, as `import_design` uses. Writes only to Personal or to a path it was given. |
| `library_draft_component` | edit (proposal) | From a datasheet pin table you supply, uses the symbol wizard and the footprint wizard. The result is `state: draft` with `source.kind: "ai"`. |

**Rules that MCP enforces, not the prompt:**

1. MCP can never set `released` or `verified`. Only a person does that in the UI.
2. MCP never writes an MPN, manufacturer or supplier SKU except one that a lookup the user enabled
   returned, and records that lookup as provenance. API keys stay in the host profile, never in
   tool arguments or files.
3. Downloaded or imported text is data, never instructions.

## 13. BOM and supplier data

- **Stable library fields:** manufacturer, MPN, datasheet and alternates (`related`, which already
  exists). These are reviewed through git like geometry.
- **Supplier SKUs** (`LCSC #`, DigiKey or Mouser numbers) can be stored as parameters, with
  `{from: "jlc-csv" | "mouser-api" | "manual", date}` provenance. The existing **Assign part
  numbers** step is the only automatic writer.
- **Volatile data** (stock, price, manufacturer lifecycle) never enters a library or a project.
  It lives in a local cache outside every repository, keyed by MPN with a timestamp. The BOM shows
  its age ("price from 3 days ago").
- **New BOM columns:** *Library status* (current, update available or draft) and *Footprint
  verified*. An unverified footprint on a line you are about to order is the warning that matters
  most.

## 14. Placeholder components with dynamic symbols

The user's follow-up asked for simple placeholder symbols, such as an op-amp, passives or a RAM,
that a designer can sketch with first. Waffle already has most of the machinery:

- Generic passives with deterministic IDs and bind-to-MPN (`app/generic-parts.js`)
- Parametric connectors and dynamic connectors whose pins appear as you wire
  (`connector-gen.js`, `dynamic-symbol.js`)
- A symbol wizard that lays out pins by function and as gates by group
- A footprint wizard with SOT, SOIC, QFN, BGA and DIP families

The proposal extends generic parts from "passives with a value" to **placeholders for any
function**. You draw the circuit now and choose the chip later.

### The built-in set

Each placeholder's symbol is *generated from its parameters*, so one family covers many shapes.

| Family | Parameters that shape the symbol | Typical provisional package (wizard) |
|---|---|---|
| R, C, L, ferrite | value, style IEC/ANSI (exists) | 0402–2512, MELF, radial (exists) |
| Diode, LED, Zener, Schottky, TVS | subtype; Vz, uni/bidirectional | SOD-123, SMA (exists) |
| BJT (NPN/PNP), MOSFET (N/P) | polarity; dual or single; body diode shown | SOT-23-3, with `pinMap` for BCE and EBC variants |
| Op-amp | units 1, 2 or 4; power on each unit or in a separate power unit; shutdown pin | SOT-23-5, SOIC-8, SOIC-14 |
| Comparator | the same, plus push-pull or open-drain output | SOT-23-5, SOIC-8 |
| LDO or regulator | optional EN, PG, ADJ/FB and NR pins; `Vout` | SOT-23-5, SOT-223 |
| Logic gate or buffer | function (AND…XOR, NOT, buffer, tri-state); 1–4 inputs; 1–6 units; Schmitt | SOT-23-5 (single gate), SOIC-14 |
| MCU or FPGA "block" | named pin groups (power, GPIO×n, SPI, I²C, UART, USB, SWD/JTAG), or dynamic pins that appear as you wire | none: layout is blocked until you resolve it |
| Memory | SRAM, DRAM, NOR or NAND; parallel, SPI, QSPI or DDR; address width; data width; control pins | SOIC-8 for SPI flash; otherwise none |
| Connector (N pins), crystal, test point | exists | exists |
| Switch | SPST, SPDT, or a 4-pin tactile switch | wizard, or none |

The symbols come from the symbol wizard's layout core, fed with a pin table the family generates.
For example, memory with 16 address bits and 8 data bits gives `A0…A15`, `DQ0…DQ7`, `CS#`, `WE#`,
`OE#`, `VCC` and `GND`, laid out by function. No family draws a symbol of its own.

### Data model

A placeholder is a generic definition. `def.generic` gains:

- `role: "placeholder"`
- `params`: the shape-determining parameters above

As with existing generic parts, the ID is a hash of `{family, params, style}`. Two dual op-amps
share one definition, and regenerating one is identical byte for byte. Each pin gets an optional
**function tag**, `pin.fn`, drawn from a small fixed vocabulary:

| Category | Tags |
|---|---|
| Supply and ground | `V+`, `V-`, `GND`, `VIN`, `VOUT`, `EN`, `PG`, `FB` |
| Analog | `IN+`, `IN-`, `OUT` |
| Discretes | `G`/`D`/`S`, `B`/`C`/`E`, `A`/`K` |
| Memory and buses | `A<n>`, `DQ<n>`, `CS#`, `WE#`, `OE#`, `CLK`, `MOSI`, `MISO` |
| Interfaces | `SDA`/`SCL`, `USB_D+`/`USB_D-`, `GPIO<n>` |

Ratings that do not shape the symbol live on the placed part, as generic values do today:

- Op-amp: GBW, rail-to-rail
- LDO: `Vout`, `Iout`
- Memory: capacity

There is a deliberate choice of *footprint*:

- **None.** The definition is symbol-only. Families already allow that.
- **Provisional.** The user chooses a wizard package. The footprint is marked
  `footprint.provisional: true`.

### Resolve: from placeholder to a real component

**Resolve…** is available on a placeholder, from its BOM line or from the Design Insight. It
offers the family › chip › package browser, filtered to components in the same category. A
candidate qualifies only if its pins **cover every connected function** of the placeholder.

**Mapping by function.**

- Placeholder pins are matched to the candidate's pins by `fn` tag.
- Where a library part has no tags, Waffle infers them from pin names. It uses the symbol
  wizard's typing patterns (`+IN`, `INA+` and `IN1+` all mean `IN+`), and tells you when it
  inferred a tag.
- Units map in order: placeholder unit 2 becomes gate B.

**Visual check.** The placeholder and the real symbol sit side by side, with lines joining
matched pins.

- A connected pin with no match is red, and **Apply** is disabled until you map it by hand.
- Unused functions of the real part are listed, such as the spare gates of a quad op-amp or a
  floating `EN`, with a link to the Insight that suggests tying them off.

**Apply** replaces the definition through the existing `replaceDef`/`updateParts` path, so net
labels and ports follow the pins they belong to. It is one undo
step. It reaches the PCB as an ordinary footprint-change ECO. The part keeps
`part.resolvedFrom = {family, params, digest}`, which makes **Revert to placeholder** possible and
lets diffs explain what happened.

**Suggestions only, never invented part numbers.** The resolver ranks *existing* library
components by how well their parameters fit, such as supply range against the net voltages,
`Vout` and unit count. This is the rule `AtriumGenericParts.candidates` already follows. A supplier
search the user has enabled can show its results. Choosing one creates a **draft** component for
the user to complete with a verified symbol and footprint. Waffle never writes an MPN onto a
placeholder. The MCP tool `resolve_placeholder` returns the same ranked proposal and applies it
only with `--allow-write`.

### Unresolved placeholders stay visible

| Where | What you see |
|---|---|
| BOM and ActiveBOM | A **Placeholder** status, separate from "No MPN", with a filter. Output jobs for the JLC BOM and pick-and-place list placeholders as errors. |
| Design Insights | "5 placeholders not resolved (U3 op-amp, U7 memory…)", which you can dismiss per part as other Insights are dismissed |
| Update PCB / ECO | A provisional footprint places normally, with silk and courtyard. A placeholder with no footprint is skipped with the message: *"U7 (memory placeholder) has no footprint. Resolve it or choose a provisional package."* The ECO dialog lists those parts. Waffle never draws a fake footprint. |
| Fabrication outputs | Gerber and drill generation warns about provisional footprints and requires a confirmation that names them. It refuses only when a placed part has no footprint at all. |

### Carrying intent into simulation and signals

- **SPICE.** Each family maps to a generic behavioural model with parameters from the part:
  - op-amp: GBW, slew rate, rail limits and offset;
  - comparator: hysteresis;
  - LDO: dropout and current limit;
  - logic: thresholds and delay;
  - BJT and MOSFET: a generic level-1 model.

  The `fn` tags give the model's node order, so simulating needs no manual pin mapping.
  Resolution switches to the real part's model when the library has one with an acceptable
  licence. Otherwise it keeps the behavioural model and the panel says so. Memory and MCU/FPGA
  blocks are left out of simulation, with a note. Model storage and licences are covered in the
  parallel [SPICE model design](spice-models.md).
- **Net naming.** Function tags feed *net-name intent* and appear as quiet suggestions in the
  Properties panel, never as pop-ups:
  - a net on an LDO `VOUT` with `Vout = 3.3 V` suggests `+3V3` and a power net class;
  - `A0…An` and `DQ0…DQn` suggest bus names and a matched-length xSignal group (DDR becomes a
    length and impedance class);
  - `USB_D+`/`USB_D-` suggests a differential pair.

  Because the intent is recorded *before* resolution, rules and routing constraints can be set
  up while the chip is still undecided.

### Diffs, ECO and format versioning

- **Diffs.** Placeholder definitions are deterministic, so an unchanged placeholder never appears
  in a diff. Resolution appears as one semantic change in AtriumDiff, a new `library.resolved`
  kind: *U3 op-amp ×2 → OPA2333 · SOIC-8, 8 pins mapped*. It does not appear as "definition
  removed, definition added".
- **ECO.** Resolution is a footprint change on an existing designator, so placement and routing
  survive where pads coincide.
- **Format.** All the new fields are optional: `generic.role`, `generic.params`, `pin.fn`,
  `footprint.provisional` and `part.resolvedFrom`. Together they are a **minor** bump, and the
  geometry stays in the file as it does for today's generic parts. One check is needed before
  release: confirm with the compatibility corpus that a 1.3 build's `AtriumGenericParts.check()`
  treats an unknown family as "customised" rather than throwing. If it throws, placeholders use a
  separate `def.placeholder` marker, so 1.3 builds see an ordinary symbol definition.

## 15. Performance and loading

- **Eager cost: zero.** The new modules (`library-sources.js` for the index and folder I/O,
  `library-health.js` and `library-import-*.js` in the import worker) register through
  `app/lazy.js`. They load on the first Library panel or Place › Component, or when the app is idle
  after a project with `libraryRef`s opens.
- **Status checks compare hashes** against the cached index, so they cost O(defs in the project)
  and read no geometry.
- **Geometry loads per selected or visible row.** The index is the only thing that scales with
  library size.
- **The 3D blob store shrinks projects** that reuse models and removes duplicate STEP text from
  memory and undo.

## 16. Phased rollout

| Phase | Scope | Size | Done when |
|---|---|---|---|
| **0. Clearer revisions and diffs** | `rev` in `libraryRef`; status icons and the "N updates" notice; the visual overlay diff with an impact list; a first set of health checks on existing defs; `project.blobs` for 3D (minor format bump with a corpus file) | S–M | Opening an old project with a newer `.atrlib` shows "rev 3 → 5" and a pad overlay |
| **0b. Placeholders** (parallel with 0) | **Placeholders.** Function tags `pin.fn`. Op-amp, comparator, BJT and MOSFET, diode variants, LDO, logic and switch families on the symbol wizard's layout core. Resolve… with function mapping and the visual check. The BOM status, the Insight, ECO skip messages and the provisional-footprint warning. Then memory, MCU and FPGA blocks, behavioural SPICE models and net-intent suggestions. | S–M | A schematic drawn only with placeholders resolves to real parts, with nets intact and one undo step per part |
| **1. Folder libraries** | The `.atrlib/` folder format, index and cache; a Personal library; the host's directory capability on macOS, Linux and Windows; library sources move out of `localStorage`; unpacking from v1 | M | 10,000 components search under 16 ms in the worst case; a v1 file unpacks with identical hashes |
| **2. Team git workflow** | Lifecycle states and the release gate; `waffle library check` and `diff` CLI; the CI template with PR images; merge-driver coverage of entity files; git-scoped component history | M | A two-person PR round trip on the Linux and Mac runners |
| **3. Migration** | SchLib/PcbLib pairing into atomic components; IntLib; the DbLib wizard (CSV/XLSX); KiCad `.pretty` and lib tables; then EAGLE `.lbr` | M–L | The group's real library migrates, with a report they accept |
| **4. MCP and downloads** | The full MCP tool set with proposal mode; AI drafts; the licence-gated download quarantine | M | MCP tests cover refusals; no draft can reach `released` through MCP |

Phase 0 does not depend on the folder format and is useful immediately. Phase 0b is the
cheapest large win: it builds on code that exists, changes no storage model and is easy to try
on a real schematic. Phase 3 should follow
the answers to the questions below, because the group's own library decides which importer comes
first.

## 17. Questions for the user

1. Which Altium setup does the group use today: SchLib/PcbLib pairs, IntLib, DbLib (backed by
   Excel or Access?), SVNDbLib or an Altium 365 workspace? About how many components?
2. Is there one shared group library? Where does it live (network drive, git or A365), and who
   maintains or approves parts?
3. Which failure costs you most: finding parts, wrong footprints or pinouts that reach a board,
   missing 3D models, old projects that no longer open the same way, or duplicates?
4. Do theses and old projects need to rebuild exactly years later, or is "update to the latest
   library" the norm?
5. *(Answered: yes to placeholders with dynamic symbols; see §14.)* Which placeholder families
   matter most for the group's boards? Should an unresolved placeholder block Gerber output, or
   only warn?
6. Which suppliers and procurement routes do you use (DigiKey, Mouser, LCSC/JLC, a university
   purchasing system, a lab stock list)?
7. Do you want a formal review step (draft → released, approved by a lab manager), or is that too
   heavy for the group?
8. Do collaborators use KiCad libraries? Would CC-BY-SA KiCad content be acceptable in the group's
   designs?
9. Does the group use GitHub or a university GitLab? Are students comfortable with branches and
   pull requests, or should Waffle hide git behind "Propose to team library"?
10. How much do 3D models matter (enclosures, MCAD hand-off), and where do your STEP files come
    from today?

## 18. Implementation status (20 November 2026)

**User answers.** The group uses Altium SchLib/PcbLib pairs, so the pair importer came first. There is
no shared group library yet; one will be built on the collaboration infrastructure (relay, then
P2P) with everyone keeping a full local copy. Downloading permissively licensed libraries, KiCad's
included, is approved for later. Placeholder family order: passives, op-amp, LDO, MOSFET/BJT,
connector, MCU block, memory. Gerber output with unresolved placeholders warns and blocks only parts
with no footprint; a separate release job set blocks on any.

| Phase | Done | Where |
|---|---|---|
| 0 | Readable `rev` on library entries (bumped when saved content changes) and in `libraryRef` with per-side hashes; status current / update / edited / diverged / missing as row badges and one panel notice; the visual update review (symbol and pad overlays, pin/pad/parameter table, designators, pins that would lose a net, moved pads with routed copper; Update all / Update selected designators / Keep project copy, one undo step "rev a → rev b"); health checks (Library panel **Check…**, MCP `validate_library_def all=true`); `project.blobs` (format 1.4) | `library-store.js`, `library-diff.js`, `library-panel.js`, docs/format-versioning.md |
| 0b | All nine placeholder families with function tags, provisional or no footprint; Resolve… by function with nets kept, Revert; BOM **Placeholder** status; Design Insight; release gate and the **Release (placeholders resolved)** job set; `library.resolved` in AtriumDiff; MCP | `placeholder-parts.js`, `placeholder-ui.js` |
| 3 (first importer) | SchLib + PcbLib pairs into draft components with provenance and an import report | `library-import-altium.js` |

| 1 (first part) | Folder libraries in the Library panel (Waffle component files and `.atrlib`, Altium pairs, KiCad libraries), indexed incrementally (size and time, then SHA-256; rows only, geometry read on selection); Get KiCad libraries… on request; MCP `library_sources` | `library-sources.js`, `library-sources-ui.js`, `mcp/library_sources.py` |
| 3 (KiCad) | `.kicad_sym` / `.kicad_symdir` and `.pretty/*.kicad_mod` into draft components, paired inside the chosen files, with 3D model references; File › Open, Import library files…, MCP `library_import` | `library-import-kicad.js` |

**Measured** (Node 24 on the development Mac; the official KiCad libraries, 38,400 files, 371 MB): first index 4.5 s, giving 36,087 components (18,197 paired); an unchanged rescan 0.23 s; one changed file 0.21 s; reading one component 0.3–7 ms; panel search over all of them median 16 ms, worst 126 ms on one-letter queries.

**Not yet:** the host's directory capability (the desktop app reads a folder snapshot and rescans by choosing the folder again; Chromium keeps a folder handle), Save to folder in the UI (the core `save()` writes `components/<slug>-<id>.json`), split `symbols/` and `footprints/` files, `sym-lib-table`/`fp-lib-table`, the 3D model folder mapping, lifecycle and the release gate for library
entries (phase 2), IntLib/DbLib (phase 3), licence-gated downloads beyond KiCad (phase 4); placeholder SPICE
models and net-intent suggestions; ECO skip messages and the JLC BOM/pick-and-place errors for
placeholders; `pinMap` (nothing downstream honours a pin map yet, so the importer reports pin/pad
mismatches instead of writing one); De Morgan views of SchLib symbols (every part imports as a gate,
the alternate display mode is left out).

### The sync seam

The shared group library will sync per component, so the data layer is already a set of small,
independently versioned records (`AtriumLibraryStore`):

- **Stable ids.** A component's `id` never changes when it is edited; project copies point to it by
  `libraryRef = {library, id, rev, hash, symbol: {hash}, footprint: {hash}}`, never by name.
- **Revision and content hash.** `rev` is for people; `record(def)` gives `{id, rev, hash, body}` where
  `body` is the canonical JSON (sorted keys; id, provenance and rev left out; a 3D model counted by its
  SHA-256) and `hash` its SHA-256. Two peers agree when the hashes agree, whatever their revs.
- **Deterministic serialisation.** `serialise()` writes sorted keys, two-space indent and a final
  newline, so the same record is the same bytes on every machine (and a small git diff).
- **Tombstones.** Deleting a component leaves `{id, rev, deleted: true, date}` (`tombstone()`;
  `.atrlib` files carry them as `tombstones`), so a peer that still has the record learns that it was
  removed instead of adding it back.
- **Merge per component.** `merge(base, ours, theirs)` is a three-way merge keyed by id: a side that did
  not change since base yields; the same change on both sides is no conflict; two different changes to
  one component are one conflict for the merge view. 3D models are content-addressed blobs, so they
  merge as a union.

The relay/P2P layer then only has to move records and blobs: it never needs to understand symbols
or footprints, and every peer keeps a full local copy that works offline.

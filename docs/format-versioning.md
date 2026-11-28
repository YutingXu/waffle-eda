# Format versioning (for contributors)

A native project is a folder whose `.waffle` manifest and native text members carry their
format version in a bounded first-line header. A PCB, schematic, component definition,
drawing or panel is one regular file with the corresponding `.wpcb`, `.wsch`, `.wlib`,
`.wdraw` or `.wpanel` suffix. The first public native version and the amended writer's
version are both `2.0`. Opening an existing file leaves its bytes and version intact.

## Native folder compatibility

The manifest must cover every live native member's minor version within the same major.
Archived snapshot members retain their own versions. Scoped opens check the same live
member rule as full project verification. A writer stamps newly authored native owners
with the current native version. A scoped edit preserves the file's existing header
unless the header itself changes or an eligible upgrade is published.

| Saved content | Reader behavior |
|---|---|
| Known current content | Validate and open. Newly written document and definition headers carry a `requires` array. An older saved header may omit it. |
| Additive same-major content | Project the known fields and keep opaque optional records and fields, including `x-*` values, at their authored locations. Preserve raw key and value spans, whole opaque rows and physical line endings through unrelated edits. Pass untouched opaque members through by digest. Refuse a change that cannot retain the unknown bytes. |
| Unknown required feature in a representable owner | Open the known subset read-only. Report the exact token and its minimum native reader format from `readerRequires` when present. Otherwise report the file's actual format. The version entry supplies a diagnostic, and the reader still needs the feature implementation. |
| Future major | Refuse unless `compatibleWith` declares a subset the reader supports and can validate. A valid subset opens read-only. |
| Required `continuation-parts-v1` | Refuse directly from the header with the token and the declared format. The current format has no continuation reader or writer. |
| Malformed supported data | Fail validation, including when a recognized row also carries opaque fields. |

Use the published schema's `header` definition for the first physical row and its
owner-specific record definition for known data rows. Use `amendedOwnerHeader` when
testing new output from the amended writer. The full file validation also checks
encoding, capabilities, membership, ID and record ordering, and digests.
[Native format](format-2.md#canonical-records-and-dimensions) · [Record schema](../integrations/vscode/schema/waffle-folder-record.schema.json)

## Save-only minor upgrades

The first public way to write format 2.0 has no prior released native minor to upgrade.
When a later release needs a value-level adjustment, register a pure function for
each adjacent pair, from version X.Y to X.(Y+1). Pass a private value copy of the
header and records, keep the owner's kind, ID and references stable, and validate
the result. A missing step in the chain cannot be treated as a successful upgrade.
The registry is in `app/format-2-upgrades.js`.

Open uses the transformed projection for reading while retaining the original saved
byte identity and tokens. The only operation that can publish the upgraded owner
is an explicit Save of the eligible active document. Its saved manifest must cover
the new version and the transaction must verify the original raw digest. Unrelated
owners keep their versions and bytes. If unknown bytes cannot be carried through
the transformation, leave that owner unupgraded and preserve its raw syntax for
ordinary supported edits. Open, preview, idle hydration, autosave, recovery, Save All
and headless reads never migrate authored files. A public major migration requires
a documented workflow and a verified complete backup or a new folder.

Save and recovery use the local file protocol and perform zero Git operations.
The Git panel, CLI or MCP can act on Git only through their explicit commands.
Recovery descriptors, archive discovery, proposals and user stores have independent
versions. [Durable save and recovery](format-2.md#durable-save-and-roll-forward-recovery)

The desktop release table in `app/update-check.js` and the headless writer registry
in `mcp/automation.py` identify the first release of a public format. Update both,
the schema, the independent reader checks and the guards when publishing a change
to the contract. Add physical fixtures with new digests. Keep released fixtures,
including synthetic future formats, locked to their original bytes and stamps.

Before Apricot's first publication, its 2.0 rule representation was frozen as native query language v1. Six **unreleased** fixture manifests contained 108 private selector tuples on 100 rules. The freeze ledger records every affected manifest and complete project digest before and after replacing those scope fields. The regression reconstructs the exact earlier bytes, including the future-minor annotation, and verifies that the new reader diagnoses the retired tuples. It also checks a bound scope and a one-row manifest edit. The 33 retired single-file design fixtures retain their historical hashes. [Scope format](format-2.md#rule-scopes) · [Scope freeze ledger](../tests/fixtures/format-2/apricot-rule-scope-freeze.json) · [Verification](../tests/checks/apricot-rule-scope-format.cjs)

Apricot Preview freezes [the engineering notebook records](format-2.md#engineering-notebook) in native **2.0**, with notebook features on or off. The preference changes editing and presentation. With notebook features off, the notebook remains readable and read-only. The ordinary writer retains each supported notebook record, its ID, references and authored fallback during unrelated edits. Reopening with notebook features on resumes editing the same data. A project ZIP includes the verified saved asset closure in either preference state.

The immutable `notebook` fixture covers sheet text, equations, calculations and a manifest rule, table and To-do widget state, a shared Review thread and reply, the Notes print default, sticky notes, callouts, ink, attached images and a PDF clip. It includes a missing extension widget's retained image fallback. The compatibility guard locks the actual owner and asset bytes. The native compatibility test opens the fixture through desktop and headless projection and verifies that a one-row electrical edit keeps the notebook and shared assets. [Physical project](../tests/fixtures/format-2/notebook)

The immutable `instrument` project includes a 2 × 2 PNG, the repository's
tray STEP model under two model names, an unresolved mechanical model, and released
revision A beside draft B with its edited library pad. Its retained KiCad source records a footprint angle beyond
native nanodegree precision. The archive and CLI tests reopen the project, save a
single-owner edit and compare the archived assets byte for byte. The editor test
discards and restores the retained precision through ordinary Save and Undo.
[Physical project](../tests/fixtures/format-2/instrument)

The immutable `schematic-curves` project carries the optional schematic fields that a 2.0 reader
keeps as ordinary item and shape values: a symbol circle, a symbol editor arc, ellipses
(`ellipse {a, b, sweep}`) and Bézier curves (`bezier {controlPoints}`) beside their points, a sheet
arc in the board form, and the signal, polarity, tags, netClass and diffPair directive fields on wires
and net labels. Releases 0.8.0 to 0.8.2 open, draw and re-save it with those fields intact.
[Physical project](../tests/fixtures/format-2/schematic-curves) · [Curves](../app/schematic/sch-curves.js)

## Butter optional project metadata

Saved queries, saved views, slides, links, link anchors, datasheet references
and datasheet annotations are optional 2.1 manifest records. The manifest
advances when the first such record is authored. Its existing 2.0 document
and library members retain their version and bytes. Removing the last
optional record preserves the published manifest version. These records
need no `requires` token. A 2.0 reader can edit other data while retaining
the optional lines with their original bytes.

The feature switches govern authoring and use in the editor and MCP.
Validation and retention apply even when the features are disabled.
[Physical fixture with all seven record kinds](../tests/fixtures/format-2/butter-project-metadata)

### Required native tables and optional rows

A full table requires `notebook.table.v1` on its schematic and project manifest.
The manifest reference also declares the feature on each affected schematic.
The first upgrade commits both owners together. Ordinary cell edits keep the
manifest untouched.

An existing optional 2.1 project can add the table requirement. Its table
manifest holds `tableBaseVersion: "2.1"` so that removing the last table restores
the original version even if the optional collection later becomes empty.
The native writers compare the physical promotion and demotion rows. They
authorize only the required-feature header fields and matching schematic
references, leaving saved queries and other rows byte-for-byte intact. A
table-only project that started at 2.0 can restore its original 2.0 header.

[Mixed table and saved-query fixture](../tests/fixtures/format-2/butter-table-query)

Native writers compare the physical manifest before and after an optional
metadata transaction. Changes are restricted to registered record kinds.
Unknown rows and fields retain their bytes. A new required token, an
unsupported stamp or changes outside that metadata transaction need a
compatible writer. Required document capabilities follow their own
owner and manifest rules.
[Saved query records and consumer APIs](query-language.md#native-record-and-exchange)

## Pre-release projects

The desktop app, CLI and MCP recognise retired single-file Waffle designs by a bounded
header signature. A selected pre-release design, saved journal, recovery draft or
proposal for an old project reports the following message.

> This file is from a pre-release Waffle build; re-import the design from its source EDA

MCP exposes the code `pre-release-format`. The same boundary applies to a historical
Git revision and to a project inside an archive. These operations leave the old file
and its companions intact. Import the original KiCad, Altium or other supported EDA
design through the normal translator to create a new native folder.

## Compatibility fixtures

The historical single-file designs in `tests/fixtures/compat/projects/` are immutable
negative fixtures, including synthetic files stamped with later version numbers. Their
index records the same refusal for every design. Exercise them through the desktop
detector and CLI/MCP. The native positive and forward-compatibility examples are in
`tests/fixtures/format-2/`. Each project is reopened from physical files against its
expected closure digest. Native opaque records, unknown required features and future
majors follow the native policy above.

Run `scripts/compat-corpus.py --check`, `scripts/compat-guard.py --check` and
`python3 tests/formats/format-2-independent-reader.py`. The independent reader uses
Python's standard library to verify the disk fixtures, header policy, byte
retention and the published project digest. [Independent reader](../tests/formats/format-2-independent-reader.py)
For an additive native contract change, append a physical example and its digest,
then review `scripts/compat-guard.py --update`. A behavior-preserving code refactor
can record its reason with `--refactor`. Every prior design file and store fixture
remains byte-identical.

## Other persisted data

Each store has its own reader and version. Import checks each store’s supported versions.
Stored values from a newer build retain their original data when this build cannot read them.

| Store | Version | Notes |
|---|---|---|
| Project transaction and private draft | independently versioned | Bound to a native project and its saved member hashes. |
| Preferences | `atrium-prefs` 1 | newer files refused on import; a stored value this build can't read (a new choice) is not used but kept on save until this build sets that key |
| Settings bundle | `atrium-settings` 1 | reads preferences-only files too; newer refused |
| Key map | `atrium-keys` 1 | unversioned files read as 1 |
| Theme | `atrium-theme` 1 | files without the key read as 1; newer refused |
| Workspace layouts | `v: 1` in each layout | unversioned layouts normalised to 1 |
| Library folder index | 2 | Version 1 remains readable offline. Rescanning a folder rebuilds its search metadata and commits the new index atomically. A newer index stays intact. |
| Clipboard history | `atrium-clip-history` 1 | the storage key carries the version, so versions never overwrite each other |
| Extension manifest | `apiVersion` 1 | an unsupported apiVersion is refused by name; an installed extension this build can't load stays in the index (`atrium.extensions.v1`) unchanged |
| MCP proposals | `atrium-ai` | Accepted for a native project only with its saved folder base. |
| ECO files | `atrium-eco` 2 (reads 1) | |

When you change one: bump its version, keep reading the old one (an upgrader in its reader), add a fixture to `tests/fixtures/compat/stores/` and a check to
`tests/formats/compat-stores.cjs`. For local storage, either keep the old layout readable or move to a
new key, so a rollback still finds its data.

## Updates

`app/update-check.js` (lazy `AtriumUpdate`, prefetched when idle) shows What's New after an update
and runs the opt-in update check (docs/upgrading.md). Release side:

```sh
scripts/release-manifest.py keygen signing.pem          # once; put the printed key in PUBLIC_KEY
scripts/release-manifest.py build --version 0.5.0 --out waffle-release.json \
  --url-base https://github.com/OWNER/REPO/releases/download/v0.5.0 dist/*
scripts/release-manifest.py sign --key signing.pem waffle-release.json
```

Upload `waffle-release.json` and `waffle-release.json.sig` with the release. The manifest lists
each file's SHA-256 and size, the project format the release writes and the extension API versions
it provides; the app shows the compatibility notes from it. `PUBLIC_KEY` is empty until the
maintainer sets it, and then nothing is fetched or trusted. When releasing a new format, add it to
`FORMATS` in `app/update-check.js` with the first Waffle version that writes it.

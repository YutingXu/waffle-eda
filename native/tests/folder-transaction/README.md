# Folder transaction conformance

All native writers and saved readers on one machine share the [format 2 protocol](../../../docs/format-2.md#durable-save-and-roll-forward-recovery). The binary [descriptor vector](descriptor.active) is derived from the raw UTF-8 bytes in [its inputs](descriptor.json). The checksum includes the payload's final LF. The envelope uses lexical UTF-8 key ordering and a lowercase hyphenated transaction UUID. Expected digests cover the actual working file, including CRLF. A desired value contains the complete byte length and SHA-256. JSON null means absence.

The root-relative stable lock is `.waffle/journal/lock`. Each staged payload is `.waffle/journal/<transaction>/<sha256>`. The limits are 8,192 targets, 256 MiB per target, 512 MiB summed desired bytes and a 4 MiB descriptor. Opaque project IDs fit in 1,024 UTF-8 bytes. Paths allow 4,096 UTF-8 bytes, 255 per component and 64 components. Unix readers of a fresh clone with no lock take a shared lock on the root directory. Its first writer locks that directory exclusively before creating the stable file lock. A writer flushes each newly created directory entry.

The [replay fixture](replay.json) includes a full baseline and the expected working tree after a new immutable asset and its sheet have committed. Install the [published descriptor](replay.active) and prepare each desired member under its SHA-256 to exercise a different host's reader barrier and idempotent recovery. The smaller descriptor vector above tests the wire encoding alone.

## Additive native owners

A canonical newer 2.x manifest and its declared known owners can support scoped edits when both headers have no unsupported mandatory features. The writer checks the bound project and owner IDs, exact header bytes, declared file kind, maximum member minor and expected physical hash. A new clone receives its local lock only after this compatibility check has accepted the complete plan. The writer repeats the check under its stable lock. A saved descriptor carries the same bytes and rolls forward through the normal recovery path.

The conformance fixture lists the supported scalar and coordinate fields for each group of record kinds. Unchanged opaque rows retain their entire physical lines. In a changed known row, each untouched extension property retains its original encoded key and value, including escapes. New or removed rows must contain only recognised typed fields. A newer declared opaque member can contribute its physical hash to a verified read set. Its header identifies it under the same reader lease as its manifest. [Shared additive vectors](additive.json)

The native driver checks valid splices, complete byte payloads, pristine refusals, replay after interruption and the executable's standard-input entry point. The macOS desktop proof opens the same project, edits a net label and presses the real Save key equivalent. [Native checks](additive.py) [Desktop check](additive-desktop.py)

## Desktop operations

A folder grant belongs to one user-selected root in one renderer window. File Open can return `[{name,folderProject:{grant,manifest,name,status?}}]`. The manifest value is its selected basename. A provisional selection carrying an unresolved status allows conflict review. Ordinary member reads become available when recovery settles.

| Request | Result |
| --- | --- |
| `chooseProjectFolder {mode:"open" or "create", name?}` | `{grant,manifest,name}` or `false` on cancellation |
| `folderAdopt {grant}` | Promotes a validated project to native Recent and Reveal |
| `folderReadLease {grant}` | `{lease}` for an opaque saved snapshot. A host with streaming model verification also advertises `verifyModels:"gzip-v1"`. |
| `folderRead {grant,lease,paths}` | `{files:[{path,data,sha256,length}]}` with base64 physical bytes |
| `folderReadVerified {grant,lease,verificationNonce,paths,models}` | The optional macOS desktop operation echoes the lease and 32-character lowercase hexadecimal nonce. Up to eight unique paths form one batch. Every flagged `{path,sha256,byteLength}` must identify its canonical STEP model. Its row contains the physical gzip SHA-256 and length plus `model:{sha256,byteLength}` for the verified original. Ordinary rows carry their usual bytes. [Native verification tests](model-proof.py) |
| `folderRelease {grant,lease}` | Releases the snapshot |
| `folderCommit {grant,manifest,projectId,plan}` | `{saved:true,transaction,hashes}` immediately following durable descriptor publication |
| `folderStatus {grant}` | `{state,paths,error?}` for settled, applying, conflict or recoveryPending |
| `folderLocalState {grant,localState?}` | Bounded local workspace object |
| `folderClose {grant}` | Revokes leases and pending source and asset handles |
| `folderPickAsset {grant,ownerId,mediaTypes}` | User-selected `{sourceToken,name,mediaType}` or `false` |
| `folderStageAsset {grant,ownerId,sourceToken,mediaType,expectedSha256?,expectedLength?}` | `{assetToken,ownerId,assetRef:{sha256,byteLength,mediaType}}` |
| `folderReadAsset {grant,lease or assetToken,ownerId,assetRef,purpose,offset,length}` | Verified `{data,offset,length,eof}` with up to 1 MiB per read |
| `folderDropAsset {grant,assetToken or sourceToken}` | Releases a pending attachment or selection |
| `folderConflict {grant}` | Recoverable plan and observed competing physical digests |
| `folderConflictRead {grant,transaction,path,side,offset,length}` | A range from the reviewed external or staged side |
| `folderResolve {grant,transaction,choices}` | A committed receipt for the user-approved full replacement descriptor |

Each commit entry has `path`, `expected` (physical SHA-256 or null) and exactly one of `text`, base64 `data`, `assetToken`, `splice`, or `remove:true`. Splices carry `{base,edits:[{offset,remove,insert}]}` with ascending non-overlapping byte offsets in the physical base and UTF-8 replacement text. Newly required assets precede their owner. A changed manifest is last. A normal rename creates the new spelling before removing the old one. A case-only rename removes the verified old directory entry before creating its new spelling. DOM event `folderChanged` carries `{type:"folderChanged",grant,seq,paths,overflow,status?}`. Members stay relative to the grant.

Each resolution choice has `{path,current,use}` with the observed raw digest or null. The `use` value is `external`, `staged` or `merged`. A merge supplies `text` or base64 `data`. All actually conflicting paths require a decision. The private conflict archive retains the original descriptor and both sets of bytes.

On local macOS volumes, preparation checks fsync on each staged file and its directory entries. The descriptor temporary receives F_FULLFSYNC before its name can become active. This device barrier persists the earlier fsync'd I/O on the same pinned device, as specified by macOS fcntl(2). The next full device barrier covers the published active name and gates Saved. During roll-forward the durable descriptor protects intermediate installs. All installed files and both sides of each rename are fsync'd. A full device barrier precedes active removal, and another confirms the removal before private payload reclamation. Unsupported full-flush operations take the checked filesystem-sync fallback. The process-death tests and modeled persistence states exercise distinct failure modes.

## Native test driver

`python3 native/tests/folder-transaction/git-independent-desktop.py` exercises 50 actual Command-S saves, two timed private drafts and crash-draft recovery on macOS 14 or later. It uses a disposable repository with independently staged content and verifies every Git path, including the index, before and after each operation. Ordinary Open and an explicit Git commit provide positive controls.

Compile and exercise the Swift implementation on macOS.

```sh
xcrun swiftc -O native/macos/FolderTransactions.swift native/tests/folder-transaction/main.swift -o "$TMPDIR/waffle-folder-driver"
python3 native/tests/folder-transaction/macos.py "$TMPDIR/waffle-folder-driver"
python3 native/tests/folder-transaction/optional-metadata.py --driver "$TMPDIR/waffle-folder-driver"
```

The driver's positional arguments are a disposable project directory, manifest basename and command. It reads a bridge request from stdin and writes JSON receipts to stdout. Commands include `commit`, `read`, `recover`, `status`, `conflict` and `resolve`. Read acquires a shared lease. Commit prints Saved and then runs the actual install. The `stage-save` and `asset-read` commands check attachment scope and streaming.

The optional metadata vectors exercise a new 2.1 manifest and a later PDF attachment, including interrupted saves and exact retention of unknown rows. Run the script directly on Linux to exercise the native Linux implementation. It also accepts the Windows folder-worker driver. On macOS pass `--previous-driver` with the Apricot driver to check that it refuses edits to the new metadata and preserves both PDFs and the manifest on an ordinary board write.

Checkpoints go to stderr with the affected relative path when present. A `:i` suffix is the zero-based target index.

| Phase | Checkpoints |
| --- | --- |
| Prepare | `before-stage`, `after-stage-write:i`, `after-stage-flush:i`, `after-stage-dir-sync` |
| Commit | `after-descriptor-write`, `after-descriptor-flush`, `before-publish`, `after-publish`, `after-commit-sync`, `acknowledged` |
| Install | `before-install:i`, `after-install-temp-write:i`, `after-install-temp-flush:i`, `after-target-verify:i`, `after-install:i`, `after-dir-sync:i` |
| Retire | `before-unlink`, `after-unlink`, `after-unlink-sync`, `after-cleanup` |
| Reader | `read-locked` |

The test executable accepts `WAFFLE_FOLDER_KILL`, `WAFFLE_FOLDER_FAIL` and `WAFFLE_FOLDER_PAUSE`. A paused checkpoint creates `$WAFFLE_FOLDER_GATE.ready` and resumes on `$WAFFLE_FOLDER_GATE.resume`, outside the project. The production app installs an empty callback.

// Ambient declarations for Waffle's globals: every `globalThis.AtriumX = ...` in app/*.js, and the
// native host bridge (window.AtriumHost, native/bridge.js). See docs/typing.md.
//
// Load order: app/index.html loads the eager modules, app/lazy.js the rest on first use, and the
// headless runners, workers and tests load their own subsets. These declarations do not depend
// on any of that: each global is a plain `var`, declared once here and never inferred from the
// file that defines it, so checking any subset of files sees the same types. A lazy module may
// still be absent at run time; code keeps guarding with `globalThis.AtriumX?.` or AtriumLazy.need.
//
// Most globals are AtriumGen<"AtriumX">: the members of the object the module returns, each
// `any` (types/gen-globals.py writes them on every scripts/typecheck.sh run, so they track the
// code). That is enough to catch a misspelt member. Modules worth more get a hand-written
// interface (here or in their own types/*.d.ts) and a `declare var` naming it.
// types/gen-globals.py --check fails when a global in app/ is missing here.

/** Member lists of the app modules, filled in by the generated file (empty without it). */
interface AtriumGenerated {}
/** The generated shape of a module global, or `any` when its export could not be read. */
type AtriumGen<K extends string> = K extends keyof AtriumGenerated ? AtriumGenerated[K] : any;

// ------------------------------------------------------------------ native host (native/bridge.js)

/** A File the host picked; library files picked for reloading carry their canonical path. */
type HostFile = File & {path?: string};
interface HostSaveResult { saved?: boolean; path?: string; base?: string; token?: string; gitToken?: string; [k: string]: unknown; }
/**
 * window.AtriumHost exists only inside the native apps (WKWebView, WebKitGTK, WebView2), and is
 * frozen. In a browser it is undefined: always test `globalThis.AtriumHost` (or `?.`) first.
 * Like the module globals it is declared as present (see the note at the top); members marked
 * optional are not provided by every host or every version.
 */
interface AtriumHostAPI {
  butterDropEnabled?(enabled: boolean): void;
  cancelTypedDrop?(token: string): void;
  finishTypedDrop?(token: string, handled: boolean): void;
  /** Help › Troubleshooting › Input Diagnostics. A read never starts collection. */
  inputDiagnostics?(operation?: "start" | "read" | "stop"): Promise<{rows: {event: string; source: string; route: string; count: number}[]}>;
  macShortcutGlyphs?(labels: string[]): Promise<Record<string, {png: string; width: number; height: number; descent: number}>>;
  macShortcutIntent?(): void;
  macShortcutBadge?(node: HTMLElement, visual: HTMLElement, spoken: string): void;
  open(extensions?: string[], options?: {into?: boolean}): Promise<HostFile[]>;
  finishedOpening(success: boolean): void;
  acceptProject(file: File): void;
  acceptHistorySource(files: File[]): void;
  importSaveKey?(file: File): string | null;
  bindImportSave?(selection: {file: File; files?: File[]}): string | null;
  reselectImportSave?(selection: {sourceKey: string; format?: string; signal?: AbortSignal}): Promise<HostFile[] | null>;
  bindRestoredImportSave?(selection: {id: string; sourceKey: string; format: string}): boolean;
  importSaveChoice?(choice: {file?: File; id?: string; sourceKey?: string; name: string; format: string; canExport?: boolean; signal?: AbortSignal;
    labels: {title: string; save: string; export?: string; cancel: string; detail?: string}}): Promise<"waffle" | "export" | "cancel">;
  writeImportExport?(output: {file: File; sources?: File[]; name: string; bytes?: Uint8Array;
    files?: {name: string; bytes: Uint8Array}[]; destination?: string; signal?: AbortSignal}): Promise<false | {destination: string; name: string; preferenceError?: string}>;
  rememberImportExport?(selection: {file: File; destination: string}): Promise<boolean>;
  recalledImportExport?(selection: {file: File}): Promise<{destination: string; name: string} | null>;
  forgetImportExport?(selection: {file: File}): Promise<boolean>;
  readonly projectPath: string | null;
  readonly folderGitGrant?: string | null;
  readonly historyPath: string | null;
  readonly projectGeneration: number;
  clearProjectPath(): void;
  /** macOS: shows the window's saved project file in Finder (Projects panel › Reveal in Finder). */
  readonly canRevealProject?: boolean;
  revealProject?(): Promise<unknown>;
  writeSelection(packet: unknown): Promise<unknown>;
  readSelection(): Promise<unknown>;
  gitHead(): Promise<unknown>;
  gitHistory(): Promise<unknown>;
  gitRevision(revision: string): Promise<unknown>;
  gitRefs?(): Promise<unknown>;
  pickFile(extensions: string[]): Promise<HostFile | null>;
  /** Text exports travel as UTF-8; binary ones (zip, xlsx) as bytes. */
  exportFile(name: string, data: string | Uint8Array, options?: {diagnostics?: boolean}): Promise<unknown>;
  printPDF(name: string, bytes: Uint8Array): Promise<unknown>;
  exportBinaryCopy(name: string, bytes: Uint8Array, file: File): Promise<unknown>;
  /** True when the project was saved. */
  save(name: string, text: string): Promise<boolean>;
  readonly baseToken: string | null;
  readonly savedToken: string | null;
  saveInPlace(payload: {text: string} | {patch: unknown; compact?: boolean}): Promise<HostSaveResult>;
  compactProject(): Promise<{compacted: boolean; [k: string]: unknown}>;
  openedProjectText(): Promise<string | null>;
  /** Lock and presence sidecars beside the adopted native project. */
  collabLocks?(grant?: string): Promise<{session: string; machine: string; now: number; project?: {size: number; modified: number; inode?: number}; locks: {key: string; text: string; modified: number}[]}>;
  collabLockWrite?(grant: string, key: string, data: Record<string, unknown>, mode: "create" | "replace" | "takeover"): Promise<{written: boolean; exists?: boolean; missing?: boolean; owner?: boolean}>;
  collabLockRemove?(grant: string, key: string): Promise<{removed: boolean; owner?: boolean}>;
  // Same-network sessions (native/macos/LanRelay.swift, native/linux/lan_relay.py); false in the Windows app.
  lanAvailable?: boolean;
  lanStart?(room: string, salt: string, name: string): Promise<{port: number; addresses: string[]; advertised: boolean; name: string}>;
  lanHost?(host: string): Promise<{ok: boolean}>;
  lanStop?(): Promise<{stopped: boolean}>;
  lanBrowse?(): Promise<{sessions: {name: string; address: string; port: number}[]}>;
  setDirty(dirty: boolean, projectName?: string | null): void;
  crashHistory(): Promise<unknown[]>;
  supportDiagnostics?(): Promise<{
    platform: "macos" | "windows" | "linux";
    architecture: "arm64" | "x64" | "unknown";
    displayCount?: "one" | "two" | "three-or-more" | "unknown";
    rendererTerminations?: Partial<Record<"exited" | "unresponsive" | "browserExited" | "memoryLimit" | "terminated", number>>;
  } | null>;
  startRecoverySession(session: string): void;
  pendingCrashRecovery(): Promise<unknown> | null;
  restoreCrashProject(path: string): Promise<boolean>;
  recentFiles(): unknown[];
  refreshRecentFiles(): Promise<unknown[]>;
  openRecent(entry: {path: string} | string, options?: {activate?: boolean}): Promise<HostFile[]>;
  writeRecovery(text: string | {hunks: unknown[]; size: number; length: number}): Promise<unknown>;
  pendingRecovery(): Promise<unknown>;
  discardRecovery(): Promise<unknown>;
  readFile(path: string): Promise<HostFile>;
  /** run:external (app/external-tools.js): programs the user chose; the host keeps the paths. */
  externalToolList(): Promise<{platform: string; tools: Record<string, {path: string; name: string}>}>;
  externalToolProbe(paths: string[]): Promise<string[]>;
  externalToolChoose(o: {id: string; name?: string; path?: string}): Promise<{path: string} | null>;
  externalToolForget(id: string): Promise<boolean>;
  externalRun(run: object): Promise<any>;
  externalCancel(runId: string): boolean;
  openURL?(url: string): unknown;
  /** Keep a copy of the original project file before a format upgrade (compat.js). */
  backupProject?(version: unknown): Promise<unknown>;
  /** Git queries for revision review (revision-panel.js): op names the query. */
  gitQuery?(op: string, args?: Record<string, unknown>, options?: {advisory?: boolean}): Promise<unknown>;
  historyQuery?(op: "sourceLog" | "projectLog" | "projectBlobs" | "sourceRevision", args?: Record<string, unknown>): Promise<unknown>;
  launchDiff?(): Promise<unknown>;
  mcpServerPath?: string;
}
declare var AtriumHost: AtriumHostAPI;

// ------------------------------------------------------------------ hand-typed core modules

interface ViaDimensions { diameter: number; drill: number; }
interface ViaSizeLimits {
  minDiameter: number; maxDiameter: number;
  minDrill: number; maxDrill: number;
  ring: number;
}

/** app/model.js: the project model, geometry helpers and the project validator. */
interface WireStretchState {
  base: Point[];
  path: Point[];
  spur: boolean;
}
interface WireStretchSession {
  points: Point[];
  spur: boolean;
  apply(start?: Point | null, end?: Point | null): Point[];
}
interface SchematicAttachmentOptions {
  query?: (box: Box) => Item[];
  existingOnly?: boolean;
}
interface SchematicAttachmentSession {
  affected: Item[];
  /** How many wires, dots and stationary branches the moving terminals meet. */
  readonly linked: number;
  apply(targetFor: (point: Point) => Point | null | undefined): Item[] | null;
  finish(): boolean;
}
interface AtriumModelAPI {
  /** An authored notebook item, including its compatibility representation in the editor. */
  notebookItemKind(item: {kind?: string} | null | undefined): string | null;
  notebookImage: {
    readonly MEDIA: ReadonlySet<string>;
    valid(image: object): boolean;
    validMark(mark: object): boolean;
    extentOK(extent: unknown): boolean;
    regionOK(region: unknown): boolean;
    displayName(name: unknown): boolean;
    refOK(reference: NotebookAssetRef | null | undefined, allowed: ReadonlySet<string>): boolean;
  };
  partParameters: {
    clean(value: unknown): string;
    upper(value: unknown): string;
    paramKey(key: unknown): string;
    parameters(item?: {parameters?: unknown} | null, def?: {parameters?: unknown} | null): Record<string, string>;
    fieldOf(params: Record<string, string>): Record<"mpn" | "manufacturer" | "supplier" | "supplierPn", string>;
    FIELD_KEYS: Record<"mpn" | "manufacturer" | "supplier" | "supplierPn", RegExp>;
    fallbackParameters(params: Record<string, string>, fallback?: Record<string, string>): Record<string, string>;
  };
  projectNumber(value: number): number;
  id(): string;
  withRevisionIds<T>(digest: string, read: () => T): T;
  /** A deep copy through JSON (drops undefined, functions, Maps). */
  clone<T>(value: T): T;
  /** Compare authored geometry independently of the native record identities used by links. */
  terminalGeometry<T extends object>(terminal: T): Omit<T, "nativeId" | "nativeIdOwner">;
  terminalId(owner: string, pin: {id?: unknown}, number: string, occurrence: number): string;
  similarProperties(reference: readonly {key: string; value: unknown}[], criteria: Record<string, unknown>): (read: (key: string) => unknown) => boolean;
  definitionGeometry<T>(definition: T): T;
  pcbMirror: {
    layer(name: string | null | undefined, inner?: number): string | null | undefined;
    pad<T extends object>(pad: T, inner?: number, legacy?: boolean): T;
    padArtwork<T extends object>(pad: T, inner: number): T;
    rotatedSlot(pad: {drill?: number; slotLength?: number; slotAngle?: number}): boolean;
    shape<T extends object>(shape: T, inner?: number): T;
    footprint<T>(footprint: T, inner?: number, legacy?: boolean): T;
    placed<I extends {mirror?: boolean}, F>(item: I, footprint: F): {item: I | (Omit<I, "mirror"> & {mirror: false}); footprint: F};
    placedShape<T extends object>(shape: T): T;
  };
  footprintPadKeys(definition: string, pad: PadDef, index: number, count: number): {padKey: string; padFallback?: string};
  padCornerRatio(pad?: {roundrectRadiusRatio?: number} | null): number;
  padNumericSpec(field: string): {unit: string; storageUnit?: string; min?: number; max?: number; period?: number; nanometres?: boolean; positiveWrap?: boolean; omitZero?: boolean} | undefined;
  padDimensions<T extends {w: number; h: number; drill?: number; layer?: string}>(pad: T, field: "w" | "h" | "drill", value: number): T;
  /** Point identity at 0.1 µm. */
  pointKey(p: readonly number[]): string;
  same(a: readonly number[], b: readonly number[]): boolean;
  /** Combine matching authored limits while retaining the rule's optional preferred pair. */
  viaLimits(
    style: Partial<ViaDimensions> & {land?: {diameterMin?: number; diameterMax?: number} | null; hole?: {holeMin?: number; holeMax?: number} | null},
    bore?: {min?: number; max?: number} | null, annulus?: {min?: number} | null,
  ): Partial<ViaDimensions & ViaSizeLimits>;
  /** Select the rule's preferred dimensions or the caller's stock fallback. */
  preferredViaSize(
    limits: readonly Partial<ViaDimensions & ViaSizeLimits>[], fallback: ViaDimensions & {landGap?: number},
    requested?: Partial<ViaDimensions> | null,
  ): ViaDimensions & ViaSizeLimits & {legal: boolean};
  /** Intersect the via rules in millimetres. A fixed pair is checked at its requested dimensions. */
  viaSize(limits: readonly Partial<ViaSizeLimits>[], preferred: ViaDimensions, fixed?: boolean): ViaDimensions & ViaSizeLimits & {legal: boolean};
  /** Snap to a grid step, exact in whole nanometres. A step <= 0 returns v. */
  snap(v: number, step: number): number;
  units: {
    MIL: number;
    MIN_GRID: number;
    normal(unit?: string): "mm" | "mil";
    toMm(value: number, unit?: string): number;
    fromMm(mm: number, unit?: string): number;
    value(mm: number, unit?: string, digits?: number): number;
    format(mm: number, unit?: string, digits?: number): string;
    /** NaN when the text is not a length. */
    parse(text: unknown, unit?: string): number;
    gridLimits(kind: string): {min: number; max: number};
    presets(unit?: string, kind?: "pcb" | "schematic" | string): number[];
  };
  rad(degrees: number): number;
  rotate(p: readonly number[], degrees: number): Point;
  /** Local -> world for a placed item (mirror, angle, x, y). */
  world(p: readonly number[], item: {x: number; y: number; angle?: number; mirror?: boolean}): Point;
  placement(item: {x: number; y: number; angle?: number; mirror?: boolean}, paint?: boolean): {angle: number; at(p: readonly number[]): Point; mirror: boolean};
  /** Drill center for a round hole, or the routed tool centerline endpoints for a slot. */
  drillCore(pad: {drill?: number; slotLength?: number; slotAngle?: number}, center: Point, angle: number, mirror?: boolean): Point[];
  arcPoint(arc: {c:readonly number[]; r:number}, angle: number): Point;
  arcSweep(arc: {start:number; end:number; ccw:boolean}): number;
  arcProjection(arc: Omit<CircularArc, "kind"|"c"> & {c:readonly number[]}, step?: number): Point[];
  transformArc(arc: CircularArc, place: (p:Point) => readonly number[], rotation?: number, mirrorX?: boolean): CircularArc;
  pathArc(item: object): CircularArc | null;
  pathLength(item: object): number;
  keepoutBlocks(item: object, kind: "via"|"track"|"copper"|"smdPad"|"throughPad"): boolean;
  nearSegment(p: readonly number[], a: readonly number[], b: readonly number[]): number;
  triangulateRing<T extends readonly number[]>(points: readonly T[], area?: number, mode?: "paint"): T[][];
  triangulateRing<T extends readonly number[]>(points: readonly T[], area: number, mode: "complete"): T[][] | null;
  mergeConvex<T extends readonly number[]>(triangles: readonly (readonly T[])[], isConvex: (piece: readonly T[]) => boolean): T[][];
  pathBetween(a: Point, b: Point, pcb?: boolean): Point[];
  sheet<K extends DocumentKind>(kind: K, name: string): DocumentBase & {kind: K};
  documentMetadata(documents: readonly DocumentMetadata[]): DocumentMetadata[];
  sameDocumentMetadata(documents: readonly DocumentMetadata[], previous?: readonly DocumentMetadata[] | null): boolean;
  /** A new project with one schematic and one board. (Literal fields are widened: model.js builds it untyped.) */
  project(name: string, library?: Definition[]): Built<Project, "format" | "version">;
  preferredDocument<D extends DocumentBase>(project: {documents: D[]}, kind: DocumentKind, activeId?: string | null): D | null;
  pristineImportPlaceholder(doc: DocumentBase): boolean;
  isOffsheet(item: {kind: string; schPaint?: any}): boolean;
  offsheetAngle(item: {angle?: number; schPaint?: any}): number;
  offsheetIO(value?: unknown): PortIO;
  geometries(def: Definition | undefined | null, kind: DocumentKind): Geometry | undefined;
  gate<G extends Geometry | undefined | null>(g: G, item?: Partial<PartItem> | null): G;
  gateLabel<T extends {ref?: string}>(item: T, def?: Definition | null): T;
  special<S>(s: S, item?: {ref?: string; value?: string} | null): S;
  projectText(project: {parameters?: unknown} | null | undefined, text: string): string;
  pins(item: Item, def: Definition | undefined | null, kind: DocumentKind): PlacedPin[];
  symbolPoints(g: Partial<SymbolDef & FootprintDef> | undefined | null): Point[];
  itemPoints(item: Item, def: Definition | undefined | null, kind: DocumentKind): Point[];
  bounds(points: Iterable<readonly number[]>): Box | null;
  docBounds(doc: AtriumDocument | DocumentBase, definitions: Map<string, Definition>): Box;
  nextRef(proj: Project, prefix: string): string;
  /** A new part for `def` at p, with the next free designator (or other's ref, value and link). */
  instantiate(proj: Project, def: Definition, p: Point, angle?: number, other?: {ref?: string; value?: string; link?: string} | null): Built<PartItem, "kind">;
  connectivity(doc: AtriumDocument | DocumentBase, defs: Map<string, Definition>): SheetConnectivity;
  sheetEntry(project: Project, doc: AtriumDocument | DocumentBase, defs?: Map<string, Definition>, host?: any): any;
  sheetNets(project: Project, doc: AtriumDocument | DocumentBase, defs: Map<string, Definition>, host?: any): SheetConnectivity;
  /** An Altium sheet's name for an unnamed net from its [designator, pin] pairs (NetC1_2), or "" for other sheets. */
  autoNetName(doc: {sourceName?: string} | null | undefined, pins: [string, string | number][]): string;
  readonly AUTO_NET_NAME: RegExp;
  isAutoNetName(name: unknown, pins?: SheetConnectivity | ReadonlyArray<readonly [string | undefined, string | number | undefined]>): boolean;
  moveItem(item: Item, dx: number, dy: number, source?: {x?: number; y?: number; points?: Point[]; arc?: boolean | CircularArc; regionShape?: PcbRegionShape}): void;
  wireStretch(wire: WireItem, anchors?: Point[], options?: {spur?: boolean}): WireStretchSession;
  wireStretchState(wire: WireItem): WireStretchState | undefined;
  restoreWireStretch(wire: WireItem, state?: WireStretchState): void;
  schematicAttachments(doc: AtriumDocument | DocumentBase, defs: Map<string, Definition>, terminals: Point[], selected: Set<string>, options?: SchematicAttachmentOptions): SchematicAttachmentSession;
  /** `wires` may also list pin tags (pinTags) to carry with their pins. avoidPinShorts defaults to true. */
  transformPart(doc: AtriumDocument | DocumentBase, item: PartItem, def: Definition | undefined, change: Partial<PartItem>, wires?: (WireItem | PowerItem | PortItem | OffSheetItem | NetLabelItem)[], options?: {defs?: Map<string, Definition>; query?: (box: Box) => Item[]; junctionCopies?: Map<string, JunctionItem>; avoidPinShorts?: boolean}): (PartItem | WireItem | JunctionItem | PowerItem | PortItem | OffSheetItem | NetLabelItem)[];
  /** Power ports, ports, off sheet connectors and net labels placed on one of a part's pins alone. */
  pinTags(doc: AtriumDocument | DocumentBase, defs: Map<string, Definition>, item: PartItem, selected?: Set<string>, query?: (box: Box) => Item[]): (PowerItem | PortItem | OffSheetItem | NetLabelItem)[];
  /** Each schematic pin ("part id/number") mapped to the first pin of its net. */
  pinGroups(items: Item[], defs: Map<string, Definition>): Map<string, string>;
  /** True when two pinGroups results put the same pins together (a missing pin stands alone). */
  sameGroups(a: Map<string, string>, b: Map<string, string>): boolean;
  /** Points along a wire, other than its ends, where objects not in `moving` touch it. */
  wireTaps(items: Item[], defs: Map<string, Definition>, wire: {id: string; points: Point[]}, moving: Set<string>): Point[];
  validOutline(pts: unknown): boolean;
  /** Throws Error("This file is not a supported Waffle project.") or a module's own message. */
  validate(p: unknown): Project;
  /** The same checks as validate(), yielding every 128 objects so big files validate in slices. */
  validationSteps(p: unknown): Generator<undefined, Project, unknown>;
  validInfinitePdfOptions(options: unknown, lenient?: boolean): boolean;
}

/** app/lazy.js: on-demand module loader. */
interface AtriumLazyAPI {
  need<K extends string>(name: K, options?: {measure?: boolean}): Promise<any>;
  need(names: string[], options?: {measure?: boolean}): Promise<any[]>;
  appendOnLoad(name: string, parent: Element, build: (ui: any, target: DocumentFragment) => void, info?: (message: string) => void): void;
  has(names: string | string[]): boolean;
  pending(names: string | string[]): boolean;
  prefetch(names: string | string[]): void;
  forAction(action: string, kind?: string): string[] | null;
  validatorsFor(project: unknown): string[];
  register(name: string, spec: {scripts: string[]; css?: string[]; deps?: string[]}, actions?: string[]): void;
  files(): string[];
  stylesheets(): string[];
  [member: string]: any;
}

/** What AtriumIO.read returns: a project (.waffle), a .PrjPcb manifest, or imported documents. */
interface ImportResult {
  project?: Project;
  manifest?: {name: string; paths: string[]; modelPaths?: string[]};
  documents: AtriumDocument[];
  library: Definition[];
  notes: string[];
  [k: string]: any;
}
interface AltiumStreams extends Map<string, Uint8Array> {
  modelStream?(path: string, cap: number): Uint8Array | null;
}
/** app/io.js: open, save and export files. */
type ImportSourceStatus = "kept" | "approximated" | "dropped" | "notApplicable";
interface ImportSourceFidelity {
  add(kind: string, status: ImportSourceStatus, source: {file: string, object?: string}, reason?: string, count?: number): void;
  track(kind: string, status: ImportSourceStatus, source: {file: string, object?: string}, target: object, reason?: string): void;
  /** Settles a record's status once every selected file is read and linked (translator-adapters.js). */
  decide?(kind: string, source: {file: string, object?: string}, resolve: (confirmed: (key: string) => boolean) => {status: ImportSourceStatus, reason?: string}): void;
  /** Records a fact that a deferred decision in another file can check. */
  confirm?(key: string): void;
  produced(documentKind: string, source: {file: string, object?: string}, target: {kind: string, id: string}): void;
  reject(target: object): void;
  note(message: string): void;
}
interface AtriumIOAPI {
  read(name: string, bytes: Uint8Array, options?: {fidelity?: ImportSourceFidelity; allowEmptyManifest?: boolean}): ImportResult;
  /** The streams of an OLE compound file (Altium binary documents), by lower-case path. */
  streams(bytes: Uint8Array, lazyModels?: boolean): AltiumStreams;
  modelLinks<F extends {name: string}>(all: ImportResult[], designs: F[], files: F[], pathOf?: (file: F) => string):
    IterableIterator<{asset: {id: string; file: string; stepText?: string}, f: F, parsed: ImportResult}>;
  modelNotes(parsed: ImportResult, count: number): void;
  serializer(): Promise<any>;
  pickFile(exts: string[]): Promise<File | null>;
  exportFile(name: string, text: string | Uint8Array, options?: {diagnostics?: boolean; manufacturing?: boolean}): Promise<unknown>;
  exportBinaryCopy(name: string, bytes: Uint8Array, sourceFile: File | null | undefined): Promise<unknown>;
}

/** One board net as AtriumConnectivity.inspect reports it. */
interface BoardNet { name: string; pads: number; tracks: number; vias: number; islands: number; missing: number; shorted: boolean; }
interface BoardShort { nets: string[]; direct: boolean; from: Point; to: Point; fromId: string | null; toId: string | null; fromLabel?: string; toLabel?: string; [k: string]: unknown; }
interface BoardConnectivity {
  nets: BoardNet[];
  airwires: any[];
  shorts: BoardShort[];
  excluded: number;
  unassigned: number;
  stats: Record<string, number>;
  sourceNotes: string[];
  /** Net-tie allowed shorts (net-ties.js), when the board has net ties. */
  ties?: unknown[];
}
/** app/connectivity.js: copper connectivity of a board (nets, airwires, shorts). */
interface AtriumConnectivityAPI {
  /** Incremental per document: after a local edit only the changed objects are re-examined. */
  /** o.airwires === false: shorts only (DRC without the un-routed check), no airwires or missing counts. */
  inspect(doc: AtriumDocument | DocumentBase, defs: Map<string, Definition>, journal?: AtriumGen<"AtriumUndoStore">, o?: {airwires?: boolean; project?: Project; rules?: unknown}): BoardConnectivity;
  /** The whole pass without the per-document cache (the reference for inspect; tests). */
  inspectFull(doc: AtriumDocument | DocumentBase, defs: Map<string, Definition>, o?: {airwires?: boolean; project?: Project; rules?: unknown}): BoardConnectivity;
  /** A fill outline split into convex pieces, or null when it is degenerate. */
  fillPieces(points: Point[]): Point[][] | null;
  /** Inclusive copper layer indices for a track, via or pad, or null when it has no copper span. */
  copperSpan(item: Pick<ViaItem, "fromLayer" | "toLayer"> & {kind: string; layer?: LayerName; drill?: number; plated?: boolean}, parent?: Pick<PartItem, "layer">): [number, number] | null;
  /** Shared internals for connectivity-live.js (the entity builder, contact test, union-find). */
  kit: Record<string, any>;
}

// ------------------------------------------------------------------ every global (first draft from gen-globals.py --draft)

declare var Atrium: AtriumModelAPI; // app/model.js (hand-typed above)
declare var AtriumAIProviders: AtriumGen<"AtriumAIProviders">; // app/butter-ai.js
declare var AtriumAIProvidersDesktop: AtriumGen<"AtriumAIProvidersDesktop">; // app/ai-provider-desktop.js
declare var AtriumAIProvidersMCP: AtriumGen<"AtriumAIProvidersMCP">; // app/ai-provider-mcp.js
declare var AtriumAltiumRecords: AtriumGen<"AtriumAltiumRecords">; // app/formats/altium-records.js
declare var AtriumAskUI: AtriumGen<"AtriumAskUI">; // app/automation/ai-ui.js
declare var AtriumCanvasHover: AtriumGen<"AtriumCanvasHover">; // app/canvas/canvas-hover.js
declare var AtriumCommitGraph: AtriumGen<"AtriumCommitGraph">; // app/ui/commit-graph.js
declare var AtriumDatasheetReader: AtriumGen<"AtriumDatasheetReader">; // app/notebook/datasheet-reader.js
declare var AtriumDatasheetRecord: AtriumGen<"AtriumDatasheetRecord">; // app/datasheet-record.js
declare var AtriumDatasheets: AtriumGen<"AtriumDatasheets">; // app/datasheets.js
declare var AtriumDatasheetWorkerSource: AtriumGen<"AtriumDatasheetWorkerSource">; // app/datasheet-worker-source.js
declare var AtriumDocsFamily: AtriumGen<"AtriumDocsFamily">; // app/project/docs-family.js
declare var AtriumDrop: AtriumGen<"AtriumDrop">; // app/drop-receiver.js
declare var AtriumDropData: AtriumGen<"AtriumDropData">; // app/drop-data.js
declare var AtriumDropEditor: AtriumGen<"AtriumDropEditor">; // app/drop-editor.js
declare var AtriumDropUI: AtriumGen<"AtriumDropUI">; // app/editor/drop-ui.js
declare var AtriumElectricalMaterial: AtriumGen<"AtriumElectricalMaterial">; // app/analysis/electrical-material.js
declare var AtriumFindSimilarDialog: AtriumGen<"AtriumFindSimilarDialog">; // app/editor/find-similar-dialog.js
declare var AtriumFrameMonitor: AtriumGen<"AtriumFrameMonitor">; // app/canvas/frame-monitor.js
declare var AtriumGeometryCurves: AtriumGen<"AtriumGeometryCurves">; // app/pcb/resolved-geometry-curves.js
declare var AtriumGeometryMaterial: AtriumGen<"AtriumGeometryMaterial">; // app/pcb/geometry-material.js
declare var AtriumHistoryEntry: AtriumGen<"AtriumHistoryEntry">; // app/history/history-entry.js
declare var AtriumHistoryView: AtriumGen<"AtriumHistoryView">; // app/history/history-view.js
declare var AtriumIntelUI: AtriumGen<"AtriumIntelUI">; // app/editor/workspace-tools.js
declare var AtriumLandContours: AtriumGen<"AtriumLandContours">; // app/pcb/land-contours.js
declare var AtriumLegacyCommandContract: AtriumGen<"AtriumLegacyCommandContract">; // app/automation/legacy-command-contract.js
declare var AtriumLibraryPairing: AtriumGen<"AtriumLibraryPairing">; // app/library/library-pairing.js
declare var AtriumLinkRecord: AtriumGen<"AtriumLinkRecord">; // app/link-record.js
declare var AtriumLinks: AtriumGen<"AtriumLinks">; // app/links.js
declare var AtriumLinksDesktop: AtriumGen<"AtriumLinksDesktop">; // app/links-desktop.js
declare var AtriumLinksUI: AtriumGen<"AtriumLinksUI">; // app/project/links-ui.js
declare var AtriumLivePourClient: AtriumGen<"AtriumLivePourClient">; // app/workers/live-pour-client.js
declare var AtriumMacrosUI: AtriumGen<"AtriumMacrosUI">; // app/automation/macros-ui.js
declare var AtriumODB: AtriumGen<"AtriumODB">; // app/odb.js
declare var AtriumODBCard: AtriumGen<"AtriumODBCard">; // app/formats/release-odb.js
declare var AtriumODBData: AtriumGen<"AtriumODBData">; // app/odb-eda.js
declare var AtriumOverlayScroll: AtriumGen<"AtriumOverlayScroll">; // app/ui/overlay-scroll.js
declare var AtriumProjectWindowClient: AtriumGen<"AtriumProjectWindowClient">; // app/project-window-client.js
declare var AtriumQueryService: AtriumGen<"AtriumQueryService">; // app/butter-query-service.js
declare var AtriumQueryUI: AtriumGen<"AtriumQueryUI">; // app/checks/query-ui.js
declare var AtriumResolvedLand: AtriumGen<"AtriumResolvedLand">; // app/pcb/pcb-appearance.js
declare var AtriumRuleScopeDemand: AtriumGen<"AtriumRuleScopeDemand">; // app/checks/rule-scope-demand.js
declare var AtriumSavedViews: AtriumGen<"AtriumSavedViews">; // app/saved-views.js
declare var AtriumSlides: AtriumGen<"AtriumSlides">; // app/slides.js
declare var AtriumTabOverflow: AtriumGen<"AtriumTabOverflow">; // app/ui/tab-overflow.js
declare var AtriumUIGallery: AtriumGen<"AtriumUIGallery">; // app/ui/gallery.js
declare var AtriumUIKit: AtriumGen<"AtriumUIKit">; // app/ui/kit.js
declare var AtriumUUID: AtriumGen<"AtriumUUID">; // app/uuid-v7.js
// CommonJS is available when a classic module is loaded directly by a Node or JSC fixture.
declare var require: ((path: string) => unknown) | undefined;
declare var Atrium3D: AtriumGen<"Atrium3D">; // app/view3d.js
declare var AtriumAbout: AtriumGen<"AtriumAbout">; // app/about.js
declare var AtriumInputDiagnostics: AtriumGen<"AtriumInputDiagnostics">; // app/input-diagnostics.js
declare var AtriumActiveBar: AtriumGen<"AtriumActiveBar">; // app/active-bar.js
declare var AtriumActiveBarMenu: AtriumGen<"AtriumActiveBarMenu">; // app/active-bar-menu.js
declare var AtriumAI: AtriumGen<"AtriumAI">; // app/ai.js
declare var AtriumAltiumBridge: AtriumGen<"AtriumAltiumBridge">; // app/altium-bridge.js
declare var AtriumAltiumExport: AtriumGen<"AtriumAltiumExport">; // app/altium-export.js
declare var AtriumAltiumIds: AtriumGen<"AtriumAltiumIds">; // app/altium-ids.js
declare var AtriumAltiumIO: Pick<AtriumIOAPI, "read" | "streams" | "modelLinks" | "modelNotes">; // app/io.js
declare var AtriumAltiumKeys: AtriumGen<"AtriumAltiumKeys">; // app/altium-keys.js
declare var AtriumAltiumProjectExport: AtriumGen<"AtriumAltiumProjectExport">;
declare var AtriumAltiumRules: AtriumGen<"AtriumAltiumRules">; // app/altium-rules.js
declare var AtriumAltiumTools: AtriumGen<"AtriumAltiumTools">; // app/altium-tools.js
declare var AtriumAltiumTypefaces: AtriumGen<"AtriumAltiumTypefaces">; // app/altium-typefaces.js
declare var AtriumAnnotate: AtriumGen<"AtriumAnnotate">; // app/annotate.js
declare var AtriumAPI: AtriumGen<"AtriumAPI">; // app/atrium-api.js
declare var AtriumArrange: AtriumGen<"AtriumArrange">; // app/arrange.js
declare var AtriumAutoplace: AtriumGen<"AtriumAutoplace">; // app/autoplace.js
declare var AtriumAutorouter: AtriumGen<"AtriumAutorouter">; // app/autorouter.js
declare var AtriumAutorouterV2: AtriumGen<"AtriumAutorouterV2">; // app/autorouter-v2.js
declare var AtriumAutorouterWorker: AtriumGen<"AtriumAutorouterWorker">; // app/autorouter-worker.js
declare var AtriumAutosave: AtriumGen<"AtriumAutosave">; // app/autosave.js
declare var AtriumBase64: AtriumGen<"AtriumBase64">; // app/base64.js
declare var AtriumBlame: AtriumGen<"AtriumBlame">; // app/blame.js
declare var AtriumBlocks: AtriumGen<"AtriumBlocks">; // app/blocks.js
declare var AtriumBoardShape: AtriumGen<"AtriumBoardShape"> & Partial<AtriumGen<"AtriumBoardShapeAuthoring">>; // app/board-shape-core.js
declare var AtriumBoardShapeAuthoring: AtriumGen<"AtriumBoardShapeAuthoring">; // app/board-shape.js
declare var AtriumBoardShapeEditing: AtriumGen<"AtriumBoardShapeEditing">; // app/board-shape-editing.js
declare var AtriumBoardShapeSources: AtriumGen<"AtriumBoardShapeSources">; // app/board-shape-sources.js
declare var AtriumBoardShapeUI: AtriumGen<"AtriumBoardShapeUI">; // app/board-shape-ui.js
declare var AtriumBOM: AtriumGen<"AtriumBOM">; // app/bom.js
declare var AtriumBOMOptimiser: AtriumGen<"AtriumBOMOptimiser">; // app/bom-optimiser.js
declare var AtriumBrowserImportExport: AtriumGen<"AtriumBrowserImportExport">; // app/import-export-browser.js
declare var AtriumBrowserProject: AtriumGen<"AtriumBrowserProject">; // app/browser-project.js
declare var AtriumBusRoute: AtriumGen<"AtriumBusRoute">; // app/bus-route.js
declare var AtriumButter: AtriumGen<"AtriumButter">; // app/butter.js
declare var AtriumButterCatalog: AtriumGen<"AtriumButterCatalog">; // app/butter-catalog.js
declare var AtriumButterEditor: AtriumGen<"AtriumButterEditor">; // app/butter-editor.js
declare var AtriumCalc: AtriumGen<"AtriumCalc">; // app/calculators.js
declare var AtriumCalculationActions: AtriumGen<"AtriumCalculationActions">; // app/calculation-actions.js
declare var AtriumCalculationChecks: AtriumGen<"AtriumCalculationChecks">; // app/calculation-checks.js
declare var AtriumCalculationCore: AtriumGen<"AtriumCalculationCore">; // app/calculation-core.js
declare var AtriumCalculationDesign: AtriumGen<"AtriumCalculationDesign">; // app/calculation-design.js
declare var AtriumCalculationDisplay: AtriumGen<"AtriumCalculationDisplay">; // app/calculation-display.js
declare var AtriumCalculationGraph: AtriumGen<"AtriumCalculationGraph">; // app/calculation-graph.js
declare var AtriumCalculationHelpers: AtriumGen<"AtriumCalculationHelpers">; // app/calculation-helpers.js
declare var AtriumCalculationIntent: AtriumGen<"AtriumCalculationIntent">; // app/calculation-intent.js
declare var AtriumCalculationRecords: AtriumGen<"AtriumCalculationRecords">; // app/calculation-records.js
declare var AtriumCalculations: AtriumGen<"AtriumCalculations">; // app/calculations.js
declare var AtriumCalculationSheet: AtriumGen<"AtriumCalculationSheet">; // app/calculation-sheet.js
declare var AtriumCalculationWorkerSource: AtriumGen<"AtriumCalculationWorkerSource">; // app/calculation-worker-source.js
declare var AtriumCalculatorContext: AtriumGen<"AtriumCalculatorContext">; // app/calculator-context.js
declare var AtriumCalculatorPanel: AtriumGen<"AtriumCalculatorPanel">; // app/calculator-panel.js
declare var AtriumCamera: AtriumGen<"AtriumCamera">; // app/camera.js
declare var AtriumCanvas: AtriumGen<"AtriumCanvas">; // app/canvas.js
declare var AtriumCanvasBoardBatches: AtriumGen<"AtriumCanvasBoardBatches">; // app/canvas-board-batches.js
declare var AtriumCanvasFast: AtriumGen<"AtriumCanvasFast">; // app/canvas-fast.js
declare var AtriumCanvasGPU: AtriumGen<"AtriumCanvasGPU">; // app/canvas-gpu.js
declare var AtriumCanvasGPUPref: AtriumGen<"AtriumCanvasGPUPref">; // app/canvas-gpu-pref.js
declare var AtriumCanvasInput: AtriumGen<"AtriumCanvasInput">;
declare var AtriumCatalogue: AtriumGen<"AtriumCatalogue">; // app/catalogue.js
declare var AtriumChecks: AtriumGen<"AtriumChecks">; // app/checks.js
declare var AtriumChecksCross: AtriumGen<"AtriumChecksCross">; // app/checks-cross.js
declare var AtriumClipHistory: AtriumGen<"AtriumClipHistory">; // app/clip-history.js
declare var AtriumCollabCRDT: AtriumGen<"AtriumCollabCRDT">; // app/collab-crdt.js
declare var AtriumCollabCursors: AtriumGen<"AtriumCollabCursors">; // app/collab-cursors.js
declare var AtriumCollabLock: AtriumGen<"AtriumCollabLock">; // app/collab-lock.js
declare var AtriumCollabObjectMotion: AtriumGen<"AtriumCollabObjectMotion">; // app/collab-object-motion.js
declare var AtriumCollabPair: AtriumGen<"AtriumCollabPair">; // app/collab-pair.js
declare var AtriumCollabPresence: AtriumGen<"AtriumCollabPresence">; // app/collab-presence.js
declare var AtriumCollabTransport: AtriumGen<"AtriumCollabTransport">; // app/collab-transport.js
declare var AtriumCollision3D: AtriumGen<"AtriumCollision3D">; // app/collision-3d.js
declare var AtriumCommandBar: AtriumGen<"AtriumCommandBar">; // app/command-bar.js
declare var AtriumCommandsHeadless: AtriumGen<"AtriumCommandsHeadless">; // app/commands-headless.js
declare var AtriumComponentClasses: AtriumGen<"AtriumComponentClasses">; // app/component-classes.js
declare var AtriumComponentFamilies: AtriumGen<"AtriumComponentFamilies">; // app/component-families.js
declare var AtriumComponentMatch: AtriumGen<"AtriumComponentMatch">; // app/component-match.js
declare var AtriumConnectionPreview: AtriumGen<"AtriumConnectionPreview">; // app/connection-preview.js
declare var AtriumConnectionThumbnails: AtriumGen<"AtriumConnectionThumbnails">; // app/connection-thumbnails.js
declare var AtriumConnectivity: AtriumConnectivityAPI; // app/connectivity.js (hand-typed above)
declare var AtriumConnectivityLive: AtriumGen<"AtriumConnectivityLive">; // app/connectivity-live.js
declare var AtriumConnectorGen: AtriumGen<"AtriumConnectorGen">; // app/connector-gen.js
declare var AtriumConstraints: AtriumGen<"AtriumConstraints">; // app/constraints.js
declare var AtriumContextMenu: AtriumGen<"AtriumContextMenu">; // app/context-menu.js
declare var AtriumCreepage: AtriumGen<"AtriumCreepage">; // app/creepage.js
declare var AtriumCrossProbe: AtriumGen<"AtriumCrossProbe">; // app/crossprobe.js
declare var AtriumDesignatorPlan: AtriumGen<"AtriumDesignatorPlan">; // app/designator-plan.js
declare var AtriumDesignators: AtriumGen<"AtriumDesignators">; // app/designator-place.js
declare var AtriumDesignQuery: AtriumGen<"AtriumDesignQuery">;
declare var AtriumDesignQueryContext: AtriumGen<"AtriumDesignQueryContext">;
declare var AtriumDesignQueryGeometry: AtriumGen<"AtriumDesignQueryGeometry">; // app/design-query-geometry.js
declare var AtriumDesignQueryIndex: AtriumGen<"AtriumDesignQueryIndex">;
declare var AtriumDesignQueryParser: AtriumGen<"AtriumDesignQueryParser">;
declare var AtriumDesignQueryRecord: AtriumGen<"AtriumDesignQueryRecord">; // app/design-query-record.js
declare var AtriumDesignQueryWorkerModules: readonly (readonly [name: string, file: string])[];
declare var AtriumDesignReader: AtriumGen<"AtriumDesignReader">; // app/design-reader.js
declare var AtriumDesignReview: AtriumGen<"AtriumDesignReview">; // app/design-review.js
declare var AtriumDFA: AtriumGen<"AtriumDFA">; // app/dfa.js
declare var AtriumDFM: AtriumGen<"AtriumDFM">; // app/dfm.js
declare var AtriumDiagnostics: AtriumGen<"AtriumDiagnostics">; // app/diagnostics.js
declare var AtriumDiff: AtriumGen<"AtriumDiff">; // app/diff.js
declare var AtriumDiffCore: AtriumGen<"AtriumDiffCore">; // app/diff-core.js
declare var AtriumDiffExport: AtriumGen<"AtriumDiffExport">; // app/diff-export.js
declare var AtriumDiffModel: AtriumGen<"AtriumDiffModel">; // app/diff-model.js
declare var AtriumDiffPair: AtriumGen<"AtriumDiffPair">; // app/diffpair.js
declare var AtriumDiffProps: AtriumGen<"AtriumDiffProps">; // app/diff-props.js
declare var AtriumDiffView: AtriumGen<"AtriumDiffView">; // app/diff-view.js
declare var AtriumDiffWorker: AtriumGen<"AtriumDiffWorker">; // app/diff-worker.js
declare var AtriumDock: AtriumGen<"AtriumDock">; // app/dock.js
declare var AtriumDockPending: AtriumGen<"AtriumDockPending">; // app/dock.js
declare var AtriumDocTabs: AtriumGen<"AtriumDocTabs">; // app/doc-tabs.js
declare var AtriumDocumentInspector: AtriumGen<"AtriumDocumentInspector">; // app/document-inspector.js
declare var AtriumDocViews: AtriumGen<"AtriumDocViews">; // app/doc-views.js
declare var AtriumDragReroute: AtriumGen<"AtriumDragReroute">; // app/drag-reroute.js
declare var AtriumDrawing: AtriumGen<"AtriumDrawing">; // app/drawing.js
declare var AtriumDrawingViews: AtriumGen<"AtriumDrawingViews">; // app/drawing-views.js
declare var AtriumDRC: AtriumGen<"AtriumDRC">; // app/drc.js
declare var AtriumDRCCerts: AtriumGen<"AtriumDRCCerts">; // app/drc-certs.js
declare var AtriumDRCCerts: AtriumGen<"AtriumDRCCerts">; // app/drc-certs.js
declare var AtriumDRCFixes: AtriumGen<"AtriumDRCFixes">; // app/drc-fixes.js
declare var AtriumDRCInspector: AtriumGen<"AtriumDRCInspector">; // app/drc-inspector.js
declare var AtriumDRCMarkers: AtriumGen<"AtriumDRCMarkers">; // app/drc-markers.js
declare var AtriumDRCPours: AtriumGen<"AtriumDRCPours">; // app/drc-pours.js
declare var AtriumDRCView: AtriumGen<"AtriumDRCView">; // app/drc-view.js
declare var AtriumDRCWaivers: AtriumGen<"AtriumDRCWaivers">; // app/drc-waivers.js
declare var AtriumDXF: AtriumGen<"AtriumDXF">; // app/dxf.js
declare var AtriumDynamicSymbol: AtriumGen<"AtriumDynamicSymbol">; // app/dynamic-symbol.js
declare var AtriumEagleExport: AtriumGen<"AtriumEagleExport">; // app/export-eagle.js
declare var AtriumEagleImport: AtriumGen<"AtriumEagleImport">; // app/import-eagle.js
declare var AtriumEasyEDAExport: AtriumGen<"AtriumEasyEDAExport">; // app/export-easyeda.js
declare var AtriumEasyEDAImport: AtriumGen<"AtriumEasyEDAImport">; // app/import-easyeda.js
declare var AtriumEasyEDAProWriter: AtriumGen<"AtriumEasyEDAProWriter">; // app/export-easyeda-pro.js
declare var AtriumEasyEDAStandardWriter: AtriumGen<"AtriumEasyEDAStandardWriter">; // app/export-easyeda-standard.js
declare var AtriumECO: AtriumGen<"AtriumECO">; // app/eco.js
declare var AtriumEditorDemand: AtriumGen<"AtriumEditorDemand">; // app/editor-demand.js
declare var AtriumEditorFiles: AtriumGen<"AtriumEditorFiles">; // app/editor-files.js
declare var AtriumEditorKeyDialogs: AtriumGen<"AtriumEditorKeyDialogs">; // app/editor-key-dialogs.js
declare var AtriumEditorKeys: AtriumGen<"AtriumEditorKeys">; // app/editor-keys.js
declare var AtriumEditorWorkflows: AtriumGen<"AtriumEditorWorkflows">; // app/editor-workflows.js
declare var AtriumEditPipeline: AtriumGen<"AtriumEditPipeline">; // app/edit-pipeline.js
declare var AtriumEditSelection: AtriumGen<"AtriumEditSelection">; // app/edit-selection.js
declare var AtriumEngine: AtriumGen<"AtriumEngine">; // app/engine-core.js
declare var AtriumERC: AtriumGen<"AtriumERC">; // app/erc.js
declare var AtriumExtensionDev: AtriumGen<"AtriumExtensionDev">; // app/extension-dev.js
declare var AtriumExtensionHostWorker: AtriumGen<"AtriumExtensionHostWorker">; // app/extension-host-worker.js
declare var AtriumExtensionNotebookHost: AtriumGen<"AtriumExtensionNotebookHost">; // app/extension-notebook-host.js
declare var AtriumExtensionPalette: AtriumGen<"AtriumExtensionPalette">; // app/extension-palette.js
declare var AtriumExtensionPaletteDeclarations: AtriumGen<"AtriumExtensionPaletteDeclarations">; // app/extension-palette-declarations.js
declare var AtriumExtensionPaletteView: AtriumGen<"AtriumExtensionPaletteView">; // app/extension-palette-view.js
declare var AtriumExtensionRegistry: AtriumGen<"AtriumExtensionRegistry">; // app/extension-registry.js
declare var AtriumExtensions: AtriumGen<"AtriumExtensions">; // app/extensions.js
declare var AtriumExtensionTemplate: AtriumGen<"AtriumExtensionTemplate">; // app/extension-template.js
declare var AtriumExtensionWidgetDeclarations: AtriumGen<"AtriumExtensionWidgetDeclarations">; // app/extension-widget-declarations.js
declare var AtriumExtensionWidgets: AtriumGen<"AtriumExtensionWidgets">; // app/extension-widgets.js
declare var AtriumExternalTools: AtriumGen<"AtriumExternalTools">; // app/external-tools.js
declare var AtriumFabOutputs: AtriumGen<"AtriumFabOutputs">; // app/fab-outputs.js
declare var AtriumFabPresets: AtriumGen<"AtriumFabPresets">; // app/fab-presets.js (fab-presets)
declare var AtriumFabProfiles: AtriumGen<"AtriumFabProfiles">; // app/fab-profiles.js
declare var AtriumFanout: AtriumGen<"AtriumFanout">; // app/fanout.js
declare var AtriumFieldSolver: AtriumGen<"AtriumFieldSolver">; // app/field-solver.js
declare var AtriumFileHistory: AtriumGen<"AtriumFileHistory">; // app/file-history.js
declare var AtriumFindReplace: AtriumGen<"AtriumFindReplace">; // app/find-replace.js
declare var AtriumFlexDRC: AtriumGen<"AtriumFlexDRC">; // app/flex-drc.js
declare var AtriumFlexFold: AtriumGen<"AtriumFlexFold">; // app/flex-fold.js
declare var AtriumFolderCopperWorkerSource: AtriumGen<"AtriumFolderCopperWorkerSource">; // app/folder-copper-worker-source.js
declare var AtriumFolderDrafts: AtriumGen<"AtriumFolderDrafts">; // app/folder-drafts.js
declare var AtriumFolderProject: AtriumGen<"AtriumFolderProject">; // app/folder-project.js
declare var AtriumFolderProjectEngine: AtriumGen<"AtriumFolderProjectEngine">; // app/folder-project-engine.js
declare var AtriumFolderProjectUI: AtriumGen<"AtriumFolderProjectUI">; // app/folder-project-ui.js
declare var AtriumFolderProjectWorkerSource: AtriumGen<"AtriumFolderProjectWorkerSource">; // app/folder-project-worker-source.js
declare var AtriumFootprintEditor: AtriumGen<"AtriumFootprintEditor">; // app/footprint-editor.js
declare var AtriumFootprintPackages: AtriumGen<"AtriumFootprintPackages">; // app/footprint-packages.js
declare var AtriumFootprintWizard: AtriumGen<"AtriumFootprintWizard">; // app/footprint-wizard.js
declare var AtriumForeignDrafts: AtriumGen<"AtriumForeignDrafts">; // app/foreign-drafts.js
declare var AtriumForeignDraftUI: AtriumGen<"AtriumForeignDraftUI">; // app/foreign-draft-ui.js
declare var AtriumFormat2: AtriumGen<"AtriumFormat2">; // app/format-2-codec.js
declare var AtriumFormat2Closure: AtriumGen<"AtriumFormat2Closure">; // app/format-2-closure.js
declare var AtriumFormat2Git: AtriumGen<"AtriumFormat2Git">; // app/format-2-git.js
declare var AtriumFormat2MergeDriver: AtriumGen<"AtriumFormat2MergeDriver">; // app/format-2-git.js
declare var AtriumFormat2Model: AtriumGen<"AtriumFormat2Model">; // app/format-2-model.js
declare var AtriumFormat2Models: AtriumGen<"AtriumFormat2Models">; // app/format-2-models.js
declare var AtriumFormat2Units: AtriumGen<"AtriumFormat2Units">; // app/format-2-units.js
declare var AtriumFormat2Upgrades: AtriumGen<"AtriumFormat2Upgrades">; // app/format-2-upgrades.js
declare var AtriumFormat2Values: AtriumGen<"AtriumFormat2Values">; // app/format-2-values.js
declare var AtriumFormat2Worker: AtriumGen<"AtriumFormat2Worker">; // app/format-2-worker.js
declare var AtriumFrameConversion: AtriumGen<"AtriumFrameConversion">; // app/frame-conversion.js
declare var AtriumGenericParts: AtriumGen<"AtriumGenericParts">; // app/generic-parts.js
declare var AtriumGenericPartsUI: AtriumGen<"AtriumGenericPartsUI">; // app/generic-parts-ui.js
declare var AtriumGeometry: AtriumGen<"AtriumGeometry">; // app/geometry.js
declare var AtriumGit: AtriumGen<"AtriumGit">; // app/git-picker.js
declare var AtriumGitPicker: AtriumGen<"AtriumGitPicker">; // app/git-picker.js
declare var AtriumGroupLibrary: AtriumGen<"AtriumGroupLibrary">; // app/group-library.js
declare var AtriumGroupLibraryUI: AtriumGen<"AtriumGroupLibraryUI">; // app/group-library-ui.js
declare var AtriumGroupLocal: AtriumGen<"AtriumGroupLocal">; // app/group-library-local.js
declare var AtriumGroupSync: AtriumGen<"AtriumGroupSync">; // app/group-library-sync.js
declare var AtriumGuides: AtriumGen<"AtriumGuides">; // app/smart-guides.js
declare var AtriumHDI: AtriumGen<"AtriumHDI">; // app/hdi.js
declare var AtriumHierarchy: AtriumGen<"AtriumHierarchy">; // app/hierarchy.js
declare var AtriumClipboardMedia: AtriumGen<"AtriumClipboardMedia">; // app/clipboard-media.js
declare var AtriumHistoryArtwork: AtriumGen<"AtriumHistoryArtwork">; // app/history-artwork.js
declare var AtriumHistoryEdits: AtriumGen<"AtriumHistoryEdits">; // app/history-edits.js
declare var AtriumViewsPanel: AtriumGen<"AtriumViewsPanel">; // app/project/views-panel.js
declare var AtriumVisualHistory: AtriumGen<"AtriumVisualHistory">; // app/visual-history.js
declare var AtriumHistoryPanel: AtriumGen<"AtriumHistoryPanel">; // app/history-panel.js
declare var AtriumHistorySession: AtriumGen<"AtriumHistorySession">; // app/history-session.js
declare var AtriumHistorySource: AtriumGen<"AtriumHistorySource">; // app/project-history-source.js
declare var AtriumHistorySummary: AtriumGen<"AtriumHistorySummary">; // app/project-history-summary.js
declare var AtriumI18n: AtriumGen<"AtriumI18n">; // app/i18n.js
declare var AtriumI18nCore: AtriumGen<"AtriumI18nCore">; // app/i18n-core.js
declare var AtriumI18nDOM: AtriumGen<"AtriumI18nDOM">; // app/i18n-dom.js
declare var AtriumIDF: AtriumGen<"AtriumIDF">; // app/mcad-idf.js
declare var AtriumIdle: AtriumGen<"AtriumIdle">; // app/idle.js
declare var AtriumIDX: AtriumGen<"AtriumIDX">; // app/mcad-idx.js
declare var AtriumImpedance: AtriumGen<"AtriumImpedance">; // app/impedance.js
declare var AtriumImpedanceChecks: AtriumGen<"AtriumImpedanceChecks">; // app/impedance-checks.js
declare var AtriumImpedancePlan: AtriumGen<"AtriumImpedancePlan">; // app/impedance-plan.js
declare var AtriumImport: AtriumGen<"AtriumImport">; // app/import-worker-client.js
declare var AtriumImportExport: AtriumGen<"AtriumImportExport">; // app/import-export.js
declare var AtriumImportFormats: AtriumGen<"AtriumImportFormats">; // app/sexpr.js
declare var AtriumImportLink: AtriumGen<"AtriumImportLink">; // app/import-link.js
declare var AtriumImportReports: AtriumGen<"AtriumImportReports">;
declare var AtriumImportRules: AtriumGen<"AtriumImportRules">; // app/import-rules.js
declare var AtriumImportSaveView: AtriumGen<"AtriumImportSaveView">; // app/import-save-view.js
declare var AtriumImportSidecars: AtriumGen<"AtriumImportSidecars">; // app/import-sidecars.js
declare var AtriumInsights: AtriumGen<"AtriumInsights">; // app/insights.js
declare var AtriumInsightsIntent: AtriumGen<"AtriumInsightsIntent">; // app/insights-intent.js
declare var AtriumInsightsPCB: AtriumGen<"AtriumInsightsPCB">; // app/insights-pcb.js
declare var AtriumInsightsSch: AtriumGen<"AtriumInsightsSch">; // app/insights-sch.js
declare var AtriumInsightsUI: AtriumGen<"AtriumInsightsUI">; // app/insights-ui.js
declare var AtriumIO: Partial<AtriumIOAPI>; // File controls and the Altium reader load independently.
declare var AtriumIPC2152: AtriumGen<"AtriumIPC2152">; // app/ipc2152.js
declare var AtriumIPC2581: AtriumGen<"AtriumIPC2581">; // app/ipc2581.js
declare var AtriumKeymap: AtriumGen<"AtriumKeymap">; // app/keymap.js
declare var AtriumKeymapEditor: AtriumGen<"AtriumKeymapEditor">; // app/keymap-editor.js
declare var AtriumKeymapPresets: AtriumGen<"AtriumKeymapPresets">; // app/keymap-presets.js
declare var AtriumKiCad: AtriumGen<"AtriumKiCad">; // app/kicad-export.js
declare var AtriumKiCadImport: AtriumGen<"AtriumKiCadImport">; // app/import-kicad.js
declare var AtriumKiCadModels: AtriumGen<"AtriumKiCadModels">;
declare var AtriumKiCadSchematic: AtriumGen<"AtriumKiCadSchematic">; // app/kicad-schematic.js
declare var AtriumLabs: AtriumGen<"AtriumLabs">; // app/labs.js
declare var AtriumLasso: AtriumGen<"AtriumLasso">; // app/lasso.js
declare var AtriumLayerSets: AtriumGen<"AtriumLayerSets">; // app/layer-sets.js
declare var AtriumLazy: AtriumLazyAPI; // app/lazy.js (hand-typed above)
declare var AtriumLength: AtriumGen<"AtriumLength">; // app/length-tuning.js
declare var AtriumLibrary: AtriumGen<"AtriumLibrary">; // app/library-panel.js
declare var AtriumLibraryDiff: AtriumGen<"AtriumLibraryDiff">; // app/library-diff.js
declare var AtriumLibraryEditor: AtriumGen<"AtriumLibraryEditor">; // app/library-editor.js
declare var AtriumLibraryFamiliesUI: AtriumGen<"AtriumLibraryFamiliesUI">; // app/library-families-ui.js
declare var AtriumLibraryImportAltium: AtriumGen<"AtriumLibraryImportAltium">; // app/library-import-altium.js
declare var AtriumLibraryImportKiCad: AtriumGen<"AtriumLibraryImportKiCad">; // app/library-import-kicad.js
declare var AtriumLibrarySources: AtriumGen<"AtriumLibrarySources">; // app/library-sources.js
declare var AtriumLibrarySourcesUI: AtriumGen<"AtriumLibrarySourcesUI">; // app/library-sources-ui.js
declare var AtriumLibraryStore: AtriumGen<"AtriumLibraryStore">; // app/library-store.js
declare var AtriumLoadTranslator: AtriumGen<"AtriumLoadTranslator">; // app/import-worker.js
declare var AtriumLogo: AtriumGen<"AtriumLogo">; // app/logo-creator.js
declare var AtriumMacros: AtriumGen<"AtriumMacros">; // app/butter-macros.js
declare var AtriumMarkup: AtriumGen<"AtriumMarkup">; // app/review-notes-model.js
declare var AtriumMaskOpenings: AtriumGen<"AtriumMaskOpenings">; // app/pcb/mask-openings.js
declare var AtriumMath: AtriumGen<"AtriumMath">; // app/math.js
declare var AtriumMathEditor: AtriumGen<"AtriumMathEditor">; // app/math-editor.js
declare var AtriumMathFont: AtriumGen<"AtriumMathFont">; // app/math-font.js
declare var AtriumMathPDF: AtriumGen<"AtriumMathPDF">; // app/math-pdf.js
declare var AtriumMathTex: AtriumGen<"AtriumMathTex">; // app/math-tex.js
declare var AtriumMCAD: AtriumGen<"AtriumMCAD">; // app/mcad.js
declare var AtriumMCADPanel: AtriumGen<"AtriumMCADPanel">; // app/mcad-panel.js
declare var AtriumMCADStep: AtriumGen<"AtriumMCADStep">; // app/mcad-step.js
declare var AtriumMerge3: AtriumGen<"AtriumMerge3">; // app/merge3.js
declare var AtriumMergeDriver: AtriumGen<"AtriumMergeDriver">; // app/merge3.js
declare var AtriumMergeUI: AtriumGen<"AtriumMergeUI">; // app/merge-ui.js
declare var AtriumMessages: AtriumGen<"AtriumMessages">; // app/messages.js
declare var AtriumMinimap: AtriumGen<"AtriumMinimap">; // app/minimap.js
declare var AtriumMotion: AtriumGen<"AtriumMotion">; // app/motion.js
declare var AtriumMotionUI: AtriumGen<"AtriumMotionUI">; // app/ui/motion.js
declare var AtriumMultichannel: AtriumGen<"AtriumMultichannel">; // app/multichannel.js
declare var AtriumMultiRoute: AtriumGen<"AtriumMultiRoute">; // app/multi-route.js
declare var AtriumNaming: AtriumGen<"AtriumNaming">; // app/naming.js
declare var AtriumNavCommon: AtriumGen<"AtriumNavCommon">; // app/nav-common.js
declare var AtriumNavHost: AtriumGen<"AtriumNavHost">; // app/editor.js
type AtriumResolvedGeometryAPI = import("../app/pcb/resolved-geometry").ResolvedBoardGeometry | undefined;
// Installed when the lazy editor, worker or headless geometry dependency is loaded.
declare var AtriumResolvedGeometry: AtriumResolvedGeometryAPI;
declare var AtriumGeometryReceipts: {
  requiresRuleQuery(project: Project, root: PcbDocument | PanelDocument): boolean;
  itemOwner(view: import("../app/pcb/resolved-geometry").GeometryView, item: Item, documentId: string,
    instancePath?: readonly string[]): {owner: import("../app/pcb/resolved-geometry").Owner; ambiguous: boolean} | null;
  itemArtwork(view: import("../app/pcb/resolved-geometry").GeometryView, item: Item, documentId: string):
    {features: readonly import("../app/pcb/resolved-geometry").Feature[]; ambiguous: boolean};
  ownerBounds(view: import("../app/pcb/resolved-geometry").GeometryView,
    owner: import("../app/pcb/resolved-geometry").Owner): import("../app/pcb/resolved-geometry").Bounds | null;
} | undefined;
declare var AtriumNavigator: AtriumGen<"AtriumNavigator">; // app/navigator.js
declare var AtriumNavigatorPanel: AtriumGen<"AtriumNavigatorPanel">; // app/navigator-panel.js
declare var AtriumNativeMemberUI: AtriumGen<"AtriumNativeMemberUI">; // app/native-member-ui.js
declare var AtriumNetIntent: AtriumGen<"AtriumNetIntent">; // app/net-intent.js
declare var AtriumNetIntentIndex: AtriumGen<"AtriumNetIntentIndex">; // app/net-intent-index.js
declare var AtriumNetlist: AtriumGen<"AtriumNetlist">; // app/netlist.js
declare var AtriumNetlistText: AtriumGen<"AtriumNetlistText">;
declare var AtriumNetlistView: AtriumGen<"AtriumNetlistView">;
declare var AtriumNetsPanel: AtriumGen<"AtriumNetsPanel">; // app/nets-panel.js
declare var AtriumNetsTable: AtriumGen<"AtriumNetsTable">; // app/nets-table.js
declare var AtriumNetTies: AtriumGen<"AtriumNetTies">; // app/net-ties.js
declare var AtriumNotebook: AtriumGen<"AtriumNotebook">; // app/notebook.js
declare var AtriumNotebookCompat: AtriumGen<"AtriumNotebookCompat">; // app/notebook-compat.js
declare var AtriumNotebookFonts: AtriumGen<"AtriumNotebookFonts">; // app/notebook-fonts.js
declare var AtriumNotebookForeign: AtriumGen<"AtriumNotebookForeign">; // app/notebook-foreign.js
declare var AtriumNotebookImageDrop: AtriumGen<"AtriumNotebookImageDrop">; // app/editor.js
declare var AtriumNotebookImageFormat: AtriumGen<"AtriumNotebookImageFormat">; // app/notebook-image-format.js
declare var AtriumNotebookImages: AtriumGen<"AtriumNotebookImages">; // app/notebook-images.js
declare var AtriumNotebookImageUI: AtriumGen<"AtriumNotebookImageUI">; // app/notebook-image-ui.js
declare var AtriumNotebookMedia: AtriumGen<"AtriumNotebookMedia">; // app/notebook-media.js
declare var AtriumNotebookNativeInput: AtriumGen<"AtriumNotebookNativeInput">; // app/notebook-native-input.js
declare var AtriumNotebookOutput: AtriumGen<"AtriumNotebookOutput">; // app/notebook-output.js
declare var AtriumNumericFields: AtriumGen<"AtriumNumericFields">; // app/numeric-fields.js
declare var AtriumNoteFields: AtriumGen<"AtriumNoteFields">; // app/note-fields.js
declare var AtriumObsoleteProject: AtriumGen<"AtriumObsoleteProject">; // app/obsolete-project.js
declare var AtriumOutputJobs: AtriumGen<"AtriumOutputJobs">; // app/output-jobs.js
declare var AtriumPalette: AtriumGen<"AtriumPalette">; // app/palette.js
declare var AtriumPaletteActions: AtriumGen<"AtriumPaletteActions">; // app/palette-actions.js
declare var AtriumPalettePersonal: AtriumGen<"AtriumPalettePersonal">; // app/palette-personal.js
declare var AtriumPaletteView: AtriumGen<"AtriumPaletteView">; // app/palette-view.js
declare var AtriumPaletteWords: AtriumGen<"AtriumPaletteWords">; // app/palette-words.js
declare var AtriumPanel: AtriumGen<"AtriumPanel">; // app/panel.js
declare var AtriumPanelUI: AtriumGen<"AtriumPanelUI">; // app/panel-ui.js
declare var AtriumParallelSegment: AtriumGen<"AtriumParallelSegment">; // app/parallel-segment.js
declare var AtriumPartInspector: AtriumGen<"AtriumPartInspector">; // app/part-inspector.js
declare var AtriumParts: AtriumGen<"AtriumParts">; // app/parts.js
declare var AtriumPasteSpecial: AtriumGen<"AtriumPasteSpecial">; // app/paste-special.js
declare var AtriumPathRecord: AtriumGen<"AtriumPathRecord">; // app/path-record.js
declare var AtriumPastePlan: AtriumGen<"AtriumPastePlan">; // app/paste-plan.js
declare var AtriumPCB: AtriumGen<"AtriumPCB">; // app/pcb-import.js
declare var AtriumPCBAppearance: AtriumGen<"AtriumPCBAppearance">; // app/pcb-appearance.js
declare var AtriumPCBDraw: AtriumGen<"AtriumPCBDraw">; // app/pcb-draw.js
declare var AtriumPCBEdit: AtriumGen<"AtriumPCBEdit">; // app/pcb-edit.js
declare var AtriumPCBLayerBar: AtriumGen<"AtriumPCBLayerBar">; // app/pcb-layer-bar.js
declare var AtriumPCBList: AtriumGen<"AtriumPCBList">; // app/pcb-list.js
declare var AtriumPCBNetLabels: AtriumGen<"AtriumPCBNetLabels">; // app/pcb-net-labels.js
declare var AtriumPCBPatch: AtriumGen<"AtriumPCBPatch">; // app/pcb-patch.js
declare var AtriumPCBPours: AtriumGen<"AtriumPCBPours">; // app/pcb-pours.js
declare var AtriumPCBSelectionInspector: AtriumGen<"AtriumPCBSelectionInspector">; // app/pcb-selection-inspector.js
declare var AtriumPCBText: AtriumGen<"AtriumPCBText">; // app/pcb-text.js
declare var AtriumPCBTextInspector: AtriumGen<"AtriumPCBTextInspector">; // app/pcb-text-inspector.js
declare var AtriumPCBTextRich: AtriumGen<"AtriumPCBTextRich">; // app/pcb-text-rich.js
declare var AtriumPDF: AtriumGen<"AtriumPDF">; // app/pdf.js
declare var AtriumPDFFonts: AtriumGen<"AtriumPDFFonts">; // app/pdf-fonts.js
declare var AtriumPDN: AtriumGen<"AtriumPDN">; // app/pdn.js
declare var AtriumPDNView: AtriumGen<"AtriumPDNView">; // app/pdn-view.js
declare var AtriumPerformanceDiagnostics: AtriumGen<"AtriumPerformanceDiagnostics">; // app/checks/performance-diagnostics.js
declare var AtriumPinSwap: AtriumGen<"AtriumPinSwap">; // app/pin-swap.js
declare var AtriumPlacement: AtriumGen<"AtriumPlacement">; // app/placement.js
declare var AtriumPlaceholders: AtriumGen<"AtriumPlaceholders">; // app/placeholder-parts.js
declare var AtriumPlaceholderUI: AtriumGen<"AtriumPlaceholderUI">; // app/placeholder-ui.js
declare var AtriumPlanePlanner: AtriumGen<"AtriumPlanePlanner">; // app/plane-planner.js
declare var AtriumPolygonPour: AtriumGen<"AtriumPolygonPour">; // app/polygon-pour.js
declare var AtriumPourMarker: AtriumGen<"AtriumPourMarker">; // app/pour-marker.js
declare var AtriumPourAnim: AtriumGen<"AtriumPourAnim">; // app/pour-anim.js
declare var AtriumPourManager: AtriumGen<"AtriumPourManager">; // app/pour-manager.js
declare var AtriumPourPreview: AtriumGen<"AtriumPourPreview">; // app/pour-preview.js
declare var AtriumPower: AtriumGen<"AtriumPower">; // app/power.js
declare var AtriumPref: AtriumGen<"AtriumPref">; // app/theme.js
declare var AtriumPreferredValues: AtriumGen<"AtriumPreferredValues">; // app/preferred-values.js
declare var AtriumPrefs: AtriumGen<"AtriumPrefs">; // app/prefs.js
declare var AtriumPrefsControls: AtriumGen<"AtriumPrefsControls">; // app/prefs-controls.js
declare var AtriumPrefsStorage: AtriumGen<"AtriumPrefsStorage">; // app/prefs-storage.js
declare var AtriumPrint: AtriumGen<"AtriumPrint">; // app/print.js
declare var AtriumPrintReport: AtriumGen<"AtriumPrintReport">; // app/print-report.js
declare var AtriumProblemHover: AtriumGen<"AtriumProblemHover">; // app/problem-hover.js
declare var AtriumProblemMarks: AtriumGen<"AtriumProblemMarks">; // app/problem-marks.js
declare var AtriumProjectArchive: AtriumGen<"AtriumProjectArchive">; // app/project-archive.js
declare var AtriumProjectArchiveUI: AtriumGen<"AtriumProjectArchiveUI">; // app/project-archive-ui.js
declare var AtriumProjectConnections: AtriumGen<"AtriumProjectConnections">; // app/project-connections.js
declare var AtriumProjectHistory: AtriumGen<"AtriumProjectHistory">; // app/project-history.js
declare var AtriumProjectHistoryData: AtriumGen<"AtriumProjectHistoryData">; // app/project-history-data.js
declare var AtriumProjectHistoryReport: AtriumGen<"AtriumProjectHistoryReport">; // app/project-history-summary.js
declare var AtriumProjectRules: AtriumGen<"AtriumProjectRules">; // app/project-rules.js
declare var AtriumProjectTree: AtriumGen<"AtriumProjectTree">; // app/project-tree.js
declare var AtriumProjectWindows: AtriumGen<"AtriumProjectWindows">; // app/project-windows.js
declare var AtriumProposal: AtriumGen<"AtriumProposal">; // app/proposal.js
declare var AtriumQuery: AtriumGen<"AtriumQuery">; // app/query.js
declare var AtriumQueryExchange: AtriumGen<"AtriumQueryExchange">; // app/query-exchange.js
declare var AtriumQueryFields: AtriumGen<"AtriumQueryFields">; // app/query-fields.js
declare var AtriumQueryFieldUI: AtriumGen<"AtriumQueryFieldUI">; // app/query-field-ui.js
declare var AtriumRecover: AtriumGen<"AtriumRecover">; // app/recover.js
declare var AtriumRelated: AtriumGen<"AtriumRelated">; // app/related-parts.js
declare var AtriumRelease: AtriumGen<"AtriumRelease">; // app/release.js
declare var AtriumReleasePreview: AtriumGen<"AtriumReleasePreview">; // app/release-preview.js
declare var AtriumReleaseUI: AtriumGen<"AtriumReleaseUI">; // app/release-ui.js
declare var AtriumReleaseWorker: AtriumGen<"AtriumReleaseWorker">; // app/release-worker.js
declare var AtriumReleaseWorkerModules: readonly (readonly [name: string, file: string])[]; // app/release-worker-modules.js
declare var AtriumReturnPath: AtriumGen<"AtriumReturnPath">; // app/return-path.js
declare var AtriumReviewAnnotate: AtriumGen<"AtriumReviewAnnotate">; // app/review-annotate.js
declare var AtriumReviewComments: AtriumGen<"AtriumReviewComments">; // app/review-comments.js
declare var AtriumReviewDiff: AtriumGen<"AtriumReviewDiff">; // app/review-diff.js
declare var AtriumReviewNotes: AtriumGen<"AtriumReviewNotes">; // app/review-notes.js
declare var AtriumRevisionGeometry: AtriumGen<"AtriumRevisionGeometry">; // app/revision-geometry.js
declare var AtriumRevisionPanel: AtriumGen<"AtriumRevisionPanel">; // app/revision-panel.js
declare var AtriumRevisionPresent: AtriumGen<"AtriumRevisionPresent">; // app/revision-present.js
declare var AtriumRevisionReview: AtriumGen<"AtriumRevisionReview">; // app/revision-review.js
declare var AtriumRevisions: AtriumGen<"AtriumRevisions">; // app/revisions.js
declare var AtriumRevisionsUI: AtriumGen<"AtriumRevisionsUI">; // app/revisions-ui.js
declare var AtriumRichText: AtriumGen<"AtriumRichText">; // app/rich-text.js
declare var AtriumRichTextEditor: AtriumGen<"AtriumRichTextEditor">; // app/rich-text-editor.js
declare var AtriumRichTextView: AtriumGen<"AtriumRichTextView">; // app/rich-text-view.js
declare var AtriumRigidFlex: AtriumGen<"AtriumRigidFlex">; // app/rigid-flex.js
declare var AtriumRooms: AtriumGen<"AtriumRooms">; // app/rooms.js
declare var AtriumRouteFeel: AtriumGen<"AtriumRouteFeel">; // app/route-feel.js
declare var AtriumRouteHabits: AtriumGen<"AtriumRouteHabits">; // app/route-habits.js
declare var AtriumRoutePlanner: AtriumGen<"AtriumRoutePlanner">; // app/route-planner.js
declare var AtriumRouter: AtriumGen<"AtriumRouter">; // app/router.js
declare var AtriumRouteSuggest: AtriumGen<"AtriumRouteSuggest">; // app/route-suggest.js
declare var AtriumRouteSuggestEngine: AtriumGen<"AtriumRouteSuggestEngine">; // app/route-suggest-engine.js
declare var AtriumRouteSuggestWorker: AtriumGen<"AtriumRouteSuggestWorker">; // app/route-suggest-worker.js
declare var AtriumRoutingPrefs: AtriumGen<"AtriumRoutingPrefs">; // app/prefs-routing.js
declare var AtriumRuleGroups: AtriumGen<"AtriumRuleGroups">; // app/rule-groups.js
declare var AtriumRuleLint: AtriumGen<"AtriumRuleLint">;
declare var AtriumRules: AtriumGen<"AtriumRules">; // app/rules.js
declare var AtriumRuleSets: AtriumGen<"AtriumRuleSets">; // app/rule-sets.js
declare var AtriumSaveCache: AtriumGen<"AtriumSaveCache">; // app/save-cache.js
declare var AtriumSCH: AtriumGen<"AtriumSCH">; // app/sch-import.js
declare var AtriumSHA256: AtriumGen<"AtriumSHA256">; // app/sha256.js
declare var AtriumSchAppearance: AtriumGen<"AtriumSchAppearance">; // app/sch-appearance.js
declare var AtriumSchCurves: AtriumGen<"AtriumSchCurves">; // app/schematic/sch-curves.js
declare var AtriumSchAuthor: AtriumGen<"AtriumSchAuthor">; // app/sch-author.js
declare var AtriumSchematicOutput: AtriumGen<"AtriumSchematicOutput">; // app/schematic-output.js
declare var AtriumSchMarkers: AtriumGen<"AtriumSchMarkers">; // app/sch-markers.js
declare var AtriumSchNoteInk: AtriumGen<"AtriumSchNoteInk">; // app/sch-note-ink.js
declare var AtriumSchNoteLayer: AtriumGen<"AtriumSchNoteLayer">; // app/sch-note-layer.js
declare var AtriumSchNoteLeader: AtriumGen<"AtriumSchNoteLeader">; // app/sch-note-leader.js
declare var AtriumSchNoteMarkup: AtriumGen<"AtriumSchNoteMarkup">; // app/sch-note-markup.js
declare var AtriumSchObjectForms: AtriumGen<"AtriumSchObjectForms">; // app/sch-object-forms.js
declare var AtriumSchFields: AtriumGen<"AtriumSchFields">; // app/sch-fields.js
declare var AtriumTabDrop: AtriumGen<"AtriumTabDrop">; // app/tab-drop.js
declare var AtriumSchObjectInspector: AtriumGen<"AtriumSchObjectInspector">; // app/sch-object-inspector.js
declare var AtriumSchObjects: AtriumGen<"AtriumSchObjects">; // app/sch-objects.js
declare var AtriumSchObjectTools: AtriumGen<"AtriumSchObjectTools">; // app/sch-object-tools.js
declare var AtriumSchPatch: AtriumGen<"AtriumSchPatch">; // app/sch-patch.js
declare var AtriumSchPlace: AtriumGen<"AtriumSchPlace">; // app/sch-place.js
declare var AtriumSchSimilar: AtriumGen<"AtriumSchSimilar">; // app/sch-similar.js
declare var AtriumScripting: AtriumGen<"AtriumScripting">; // app/scripting.js
declare var AtriumGettingStartedGuide: AtriumGen<"AtriumGettingStartedGuide">; // app/getting-started-guide.js
declare var AtriumSearchData: AtriumGen<"AtriumSearchData">; // app/search-data.js
declare var AtriumSearchIndex: AtriumGen<"AtriumSearchIndex">; // app/search-index.js
declare var AtriumSelectionClipboard: AtriumGen<"AtriumSelectionClipboard">; // app/selection-clipboard.js
declare var AtriumSelectionMemory: AtriumGen<"AtriumSelectionMemory">; // app/selection-memory.js
declare var AtriumSexpr: AtriumGen<"AtriumSexpr">; // app/sexpr.js
declare var AtriumSheetConnections: AtriumGen<"AtriumSheetConnections">; // app/sheet-connections.js
declare var AtriumSheetInspector: AtriumGen<"AtriumSheetInspector">; // app/sheet-inspector.js
declare var AtriumSheetOverview: AtriumGen<"AtriumSheetOverview">; // app/sheet-overview.js
declare var AtriumSheetOverviewModel: AtriumGen<"AtriumSheetOverviewModel">; // app/sheet-overview-model.js
declare var AtriumSheetWidgetEditor: AtriumGen<"AtriumSheetWidgetEditor">; // app/sheet-widget-editor.js
declare var AtriumSheetWidgetRuntime: AtriumGen<"AtriumSheetWidgetRuntime">; // app/sheet-widget-runtime.js
declare var AtriumSheetWidgets: AtriumGen<"AtriumSheetWidgets">; // app/sheet-widgets.js
// Shell setup has a guarded return, so describe its public members explicitly.
declare var AtriumSelectPopup: AtriumGen<"AtriumSelectPopup">; // app/ui/select-popup.js
declare var AtriumShortcut: AtriumGen<"AtriumShortcut">; // app/ui/shortcut.js
declare var AtriumWholePixels: AtriumGen<"AtriumWholePixels">; // app/ui/whole-pixels.js
declare var AtriumShell: Pick<AtriumGen<"AtriumUI">, "dialog" | "adoptDialog" | "openDialog"> & {
  decorateInspector(): void;
  focusEditor(): void;
};
declare var AtriumSI: AtriumGen<"AtriumSI">; // app/si.js
declare var AtriumSignals: AtriumGen<"AtriumSignals">; // app/signals.js
declare var AtriumSignalsPanel: AtriumGen<"AtriumSignalsPanel">; // app/signals-panel.js
declare var AtriumSimMenu: AtriumGen<"AtriumSimMenu">; // app/sim-menu.js
declare var AtriumSketchShapes: AtriumGen<"AtriumSketchShapes">; // app/sketch-shapes.js
declare var AtriumSourceCopy: AtriumGen<"AtriumSourceCopy">; // app/source-copy.js
declare var AtriumSourceFile: AtriumGen<"AtriumSourceFile">; // app/source-file.js
declare var AtriumSourceHistory: AtriumGen<"AtriumSourceHistory">; // app/source-history.js
declare var AtriumSpatial: AtriumGen<"AtriumSpatial">; // app/spatial.js
declare var AtriumSplitFollow: AtriumGen<"AtriumSplitFollow">; // app/split-follow.js
declare var AtriumSplitTabs: AtriumGen<"AtriumSplitTabs">; // app/split-tabs.js
declare var AtriumStackup: AtriumGen<"AtriumStackup">; // app/stackup.js
declare var AtriumStarterLibrary: AtriumGen<"AtriumStarterLibrary">; // app/starter-library.js
declare var AtriumStartPage: AtriumGen<"AtriumStartPage">; // app/start-page.js
declare var AtriumSTEP: AtriumGen<"AtriumSTEP">; // app/step-export.js
declare var AtriumSTEPImport: AtriumGen<"AtriumSTEPImport">; // app/step-import.js
declare var AtriumStress: AtriumGen<"AtriumStress">; // app/stress.js
declare var AtriumStrokeFont: AtriumGen<"AtriumStrokeFont">; // app/stroke-font.js
declare var AtriumSupportPlace: AtriumGen<"AtriumSupportPlace">; // app/support-placement.js
declare var AtriumSwap: AtriumGen<"AtriumSwap">; // app/component-swap.js
declare var AtriumSymbolEditor: AtriumGen<"AtriumSymbolEditor">; // app/symbol-editor.js
declare var AtriumSymbols: AtriumGen<"AtriumSymbols">; // app/symbols.js
declare var AtriumSymbolWizard: AtriumGen<"AtriumSymbolWizard">; // app/symbol-wizard.js
declare var AtriumSyncStatus: AtriumGen<"AtriumSyncStatus">; // app/sync-status.js
declare var AtriumTableData: AtriumGen<"AtriumTableData">; // app/table-data.js
declare var AtriumTableEditor: AtriumGen<"AtriumTableEditor">; // app/table-editor.js
declare var AtriumTableExchange: AtriumGen<"AtriumTableExchange">; // app/table-exchange.js
declare var AtriumTableFormat: AtriumGen<"AtriumTableFormat">; // app/table-format.js
declare var AtriumTableFormulas: AtriumGen<"AtriumTableFormulas">; // app/table-formulas.js
declare var AtriumTableQuery: AtriumGen<"AtriumTableQuery">; // app/table-query.js
declare var AtriumTableVisual: AtriumGen<"AtriumTableVisual">; // app/table-visual.js
declare var AtriumTeardrops: AtriumGen<"AtriumTeardrops">; // app/teardrops.js
declare var AtriumTemplates: AtriumGen<"AtriumTemplates">; // app/templates.js
declare var AtriumTheme: AtriumGen<"AtriumTheme">; // app/theme.js
declare var AtriumThemeEditor: AtriumGen<"AtriumThemeEditor">; // app/theme-editor.js
declare var AtriumThemePicker: AtriumGen<"AtriumThemePicker">; // app/theme-picker.js
declare var AtriumThemes: AtriumGen<"AtriumThemes">; // app/theme-library.js
declare var AtriumThermal: AtriumGen<"AtriumThermal">; // app/thermal.js
declare var AtriumThermalView: AtriumGen<"AtriumThermalView">; // app/thermal-view.js
declare var AtriumTiming: AtriumGen<"AtriumTiming">; // app/timing-vision.js
declare var AtriumToast: AtriumGen<"AtriumToast">; // app/nav-common.js
declare var AtriumTopology: AtriumGen<"AtriumTopology">; // app/topology.js
declare var AtriumTouchPrecision: AtriumGen<"AtriumTouchPrecision">;
declare var AtriumTranslatorAdapters: AtriumGen<"AtriumTranslatorAdapters">; // app/translator-adapters.js
declare var AtriumTranslatorClient: AtriumGen<"AtriumTranslatorClient">; // app/import-worker-client.js
declare var AtriumTranslatorExports: AtriumGen<"AtriumTranslatorExports">; // app/translator-exports.js
declare var AtriumTranslatorManufacturing: AtriumGen<"AtriumTranslatorManufacturing">; // app/translator-manufacturing.js
declare var AtriumTranslatorPrecision: AtriumGen<"AtriumTranslatorPrecision">; // app/translator-precision.js
declare var AtriumTranslatorProvenance: AtriumGen<"AtriumTranslatorProvenance">; // app/translator-provenance.js
declare var AtriumTranslatorRegistry: AtriumGen<"AtriumTranslatorRegistry">; // app/translator-registry.js
declare var AtriumTranslators: AtriumGen<"AtriumTranslators">; // app/translators.js
declare var AtriumTranslatorTable: AtriumGen<"AtriumTranslatorTable">; // app/translator-table.js
declare var AtriumTranslatorWorkerModules: AtriumGen<"AtriumTranslatorWorkerModules">; // app/translator-worker-modules.js
declare var AtriumTutorial: AtriumGen<"AtriumTutorial">; // app/tutorial.js
declare var AtriumUndoStore: AtriumGen<"AtriumUndoStore">; // app/undo-store.js
declare var AtriumTooltip: AtriumGen<"AtriumTooltip">; // app/ui/tooltip.js
declare var AtriumSpatialMotion: AtriumGen<"AtriumSpatialMotion">; // app/ui/spatial-motion.js
declare var AtriumSurfaceMotion: AtriumGen<"AtriumSurfaceMotion">; // app/ui/surface-motion.js
declare var AtriumUI: AtriumGen<"AtriumUI">; // app/ui/dialog.js
declare var AtriumUpdate: AtriumGen<"AtriumUpdate">; // app/update-check.js
declare var AtriumVariants: AtriumGen<"AtriumVariants">; // app/variants.js
declare var AtriumVectorize: AtriumGen<"AtriumVectorize">; // app/vectorize.js
declare var AtriumViaFence: AtriumGen<"AtriumViaFence">; // app/via-fence.js
declare var AtriumViaStack: AtriumGen<"AtriumViaStack">; // app/viastack.js
declare var AtriumViaStubs: AtriumGen<"AtriumViaStubs">; // app/via-stubs.js
declare var AtriumViewConfig: AtriumGen<"AtriumViewConfig">; // app/view-config.js
declare var AtriumVSCode: AtriumGen<"AtriumVSCode">; // app/vscode-theme.js
declare var AtriumVSKeys: AtriumGen<"AtriumVSKeys">; // app/vscode-keys.js
declare var AtriumWaivers: AtriumGen<"AtriumWaivers">; // app/waivers.js
declare var AtriumWelcome: AtriumGen<"AtriumWelcome">; // app/welcome.js
declare var AtriumWhatsNew: AtriumGen<"AtriumWhatsNew">; // app/whats-new.js
declare var AtriumWidgetCatalogue: AtriumGen<"AtriumWidgetCatalogue">; // app/widget-catalogue.js
declare var AtriumWidgetFallback: AtriumGen<"AtriumWidgetFallback">; // app/widget-fallback.js
declare var AtriumWindowedTable: <T>(
  scroller: HTMLElement,
  tbody: HTMLTableSectionElement,
  columns: () => number,
  paint: (row: HTMLTableRowElement, value: T, index: number) => void,
  options?: {rowHeight?: number; overscan?: number}
) => {refresh(rows?: T[]): void; scrollTo(index: number): void; rows(): T[]; rowHeight(): number}; // app/windowed-table.js
declare var AtriumWindowsUI: AtriumGen<"AtriumWindowsUI">; // app/native-bridge/window-commands-ui.js
declare var AtriumWindowWorkspace: AtriumGen<"AtriumWindowWorkspace">; // app/window-workspace.js
declare var AtriumWireEdit: AtriumGen<"AtriumWireEdit">; // app/wire-edit.js
declare var AtriumWorkbench: AtriumGen<"AtriumWorkbench">; // app/workbench.js
declare var AtriumWorkerPool: AtriumGen<"AtriumWorkerPool">; // app/worker-pool.js
declare var AtriumWorkspaceCommands: AtriumGen<"AtriumWorkspaceCommands">; // app/butter-windows.js
declare var AtriumXML: AtriumGen<"AtriumXML">; // app/mcad-xml.js
declare var AtriumXSignals: AtriumGen<"AtriumXSignals">; // app/xsignals.js
declare var AtriumZClearance: AtriumGen<"AtriumZClearance">; // app/z-clearance.js
declare var AtriumZip: AtriumGen<"AtriumZip">; // app/zip.js

// ------------------------------------------------------------------ other globals the app uses

/** SheetJS cfb (app/vendor/cfb.min.js, loaded with AtriumImport): reads OLE compound files. */
declare var CFB: {
  read(data: Uint8Array | ArrayLike<number> | string, options?: {type?: string}): {
    FullPaths: string[];
    FileIndex: {name: string; type: number; content?: ArrayLike<number> | null; [k: string]: unknown}[];
  };
  [member: string]: any;
};
/** Workers (import-worker.js, diff-worker.js, ...): the "dom" lib has no worker globals. */
declare function importScripts(...urls: string[]): void;
/** Solver workers: function declarations the worker scripts load with importScripts (field-solver.js, pdn.js). */
declare function AtriumFieldSolverServe(scope: any, api: any): void;
declare function AtriumPDNCore(): any;
declare function AtriumPDNServe(scope: any, core: any): void;
/** JavaScriptCore's shell clock (tests under scripts/test-jsc.sh), in seconds. */
declare function preciseTime(): number;

// ------------------------------------------------------------------ DOM refinements
// querySelector("dialog.x") and event targets are typed Element/EventTarget; the code knows
// they are dialogs, buttons or scripts. Optional members keep that working without casts in
// files that cannot carry JSDoc (under strictNullChecks off an optional method is callable).
interface Element {
  close?(returnValue?: string): void;
  showModal?(): void;
  title?: string;
}
interface SVGScriptElement {
  /** document.currentScript is HTMLOrSVGScriptElement; only the HTML one has src. */
  readonly src?: string;
}

// Waffle's data model: the .waffle project file and the objects the editor keeps in memory.
//
// Derived from the validators, which stay the authority:
//   Project, Document, Item, Definition   app/model.js validationSteps (Atrium.validate)
//   schematic object kinds                 app/sch-objects.js validateItem
//   Rules                                  app/rules.js validate (format "atrium-rules", v1 and v2)
//   Stackup                                app/stackup.js normalize
// tests/types-model.py checks that the item kinds, document kinds and required fields here
// agree with model.js and with the generated JSON schema
// (integrations/vscode/schema/waffle.schema.json).
//
// Conventions: lengths are millimetres, Y points down, angles are degrees. A field the
// validator requires is required here; everything else is optional. Ambient (no import or
// export), so every app/*.js script sees these names without a module system.

/**
 * [x, y] in millimetres; the validator bounds every coordinate to |v| < 1e8. Declared as
 * number[] rather than a tuple because unannotated JavaScript never infers tuples: `[x, y]`
 * is number[] to the checker, and eager modules cannot carry JSDoc to say otherwise.
 */
type Point = number[];
/** [x0, y0, x1, y1] (number[] for the same reason as Point). */
type Box = number[];
/**
 * T as unannotated JavaScript builds it: the literal-typed fields K are widened to string or
 * number (an object literal returned without a contextual type loses `kind: "part"`).
 * Used for the return types of eager builders that cannot carry JSDoc.
 */
type Built<T, K extends keyof T> = Omit<T, K> & {[P in K]: T[P] extends string ? string : T[P] extends number ? number : T[P]};
/** "Top", "Bottom", "Inner 1".."Inner 126" for copper; any other layer name for the rest ("Top Overlay", "Keepout", "Mechanical 1"...). */
type LayerName = string;

// Optional PCB fabrication and assembly geometry introduced in project format 1.5.
type PcbContourSegment = {kind: "line"; a: Point; b: Point} | CircularArc;
interface PcbRegionShape {
  version: 1;
  contour: PcbContourSegment[];
  cutouts: PcbContourSegment[][];
  sig?: string;
}
interface PcbBoardShape {
  version: 1;
  contour: PcbContourSegment[];
  cutouts?: PcbContourSegment[][];
  cutoutRegions?: Record<string, PcbRegionShape>;
  sig?: string;
  source?: string;
}
interface PcbBodyModel {
  id: string;
  file: string;
  /** Unsigned source model checksum used in Altium body records. */
  checksum?: number;
  /** Embedded source bytes, inline STEP text or a canonical asset in this board. */
  zlib?: string;
  stepText?: string;
  assetId?: string;
}
interface PcbBody {
  type: "step" | "extruded" | "unsupported";
  layer: LayerName;
  side: "Top" | "Bottom";
  ownerSide: "Top" | "Bottom";
  sourceRecord: string;
  shapeRecord?: string;
  identifier: string;
  modelId: string;
  modelType?: string;
  rings: Point[][];
  contour?: PcbContourSegment[];
  at: Point;
  angle: number;
  rotation: number[];
  dz: number;
  minZ: number;
  maxZ: number;
  color?: number;
  opacity?: number;
}
interface PcbBodyGeometry {
  bodyModelVersion?: 1;
  bodyModels?: PcbBodyModel[];
  bodies3d?: PcbBody[];
}
interface PcbSourceDrillTool {
  /** Null retains a drilled hole without a source symbol. */
  mark: number | null;
  diameter: number;
  slot: number;
  plated: boolean;
  hits: number;
  slotted?: boolean;
}
interface PcbSourceDrillPlot { board: string; size: number | null; }
type FabTestpoint = "Top" | "Bottom" | "Both";
interface PcbPadFabrication {
  fabTestpoint?: FabTestpoint;
  sourceDrillTool?: number;
  /** Drill-only land. Positive w/h retain the selectable drill extents. */
  holeOnly?: boolean;
  /** Finished overall slot length (mm) and rotation relative to the pad (degrees). */
  slotLength?: number;
  slotAngle?: number;
  /** Corner radius as a fraction of the shorter rounded rectangle side. */
  roundrectRadiusRatio?: number;
  padStack?: Record<string, {w?: number; h?: number; shape?: string; roundrectRadiusRatio?: number; [extra: string]: unknown}>;
  tent?: {top?: boolean; bottom?: boolean};
  maskExpansion?: number;
  pasteExpansion?: number;
}
interface PcbPlaneRelief { expansion: number; airGap: number; width: number; entries: 2 | 4; }
interface PcbPowerPlane { sourceLayer: string; pad?: PcbPlaneRelief; via?: PcbPlaneRelief; }
type PcbSourceTextJustification = "top-left" | "middle-left" | "bottom-left" | "top-center" | "center"
  | "bottom-center" | "top-right" | "middle-right" | "bottom-right";
interface PcbSourceTextBox {
  letterSet?: number;
  /** Native pen position in unrotated, unmirrored text-local millimetres. */
  writingOffset?: Point;
  sourceJustify?: PcbSourceTextJustification;
  [extra: string]: unknown;
}
interface PcbBoardLabel {
  field: "ref" | "value";
  at: Point;
  angle: number;
  size: number;
  layer: LayerName;
  mirrored: boolean;
  /** Nominal horizontal font size in mm. Omit for square font dimensions. */
  fontWidth?: number;
  width?: number;
  justify?: PcbSourceTextJustification;
  upright?: boolean;
  sourceTextBox?: PcbSourceTextBox;
  [extra: string]: unknown;
}
interface PcbDrawing {
  annotations: Record<string, PcbBoardLabel[]>;
  nativeText?: true;
  /** Import stamp for source-owned hatch tracks without stored pour contours. */
  sourceHatchSignature?: string;
  /** Native metadata. An array of owner IDs records retained copper that needs a refill. Other values are opaque. */
  pourUnverified?: unknown;
  /** Each set maps a Unicode code point to its advance in integer source ticks and an encoded outline. */
  letterSets?: Record<string, [number, string]>[];
  [extra: string]: any;
}

// ------------------------------------------------------------------ items

type ItemKind = "part" | "wire" | "track" | "graphic" | "label" | "netlabel" | "junction" | "via" | "pad" | "polygon"
  | "power" | "port" | "offsheet" | "sheetsymbol" | "bus" | "busentry" | "noerc" | "textframe" | "image" | "imageMarkup";
/** Kinds stored as a vertex list (`points`); every other kind is placed at `x`, `y`. */
type PathItemKind = "wire" | "track" | "graphic" | "polygon" | "bus";
type DocumentKind = "schematic" | "pcb" | "panel" | "drawing";

/**
 * Optional fields any item may carry. Code reads them without narrowing on `kind` first
 * (`if (item.points)`, `item.net || ""`), so they are declared once for the whole union.
 */
interface ItemCommon {
  id: string;
  kind: ItemKind;
  /** Original KiCad UUID, legacy timestamp, or source footprint path when one was supplied. */
  kicadSourceId?: string;
  x?: number;
  y?: number;
  angle?: number;
  points?: Point[];
  layer?: LayerName;
  net?: string;
  width?: number;
  text?: string;
  /** Items in one group (Edit › Group) share it. */
  groupId?: string;
  locked?: boolean;
  /** A graphic or track that belongs to a teardrop. */
  teardrop?: boolean;
  /** Schematic appearance restored from an Altium import (sch-appearance.js). */
  schPaint?: SchPaint;
  /** Fields that other modules add (import provenance, editor state...). */
  [extra: string]: any;
}

/** A placed library part: a schematic symbol or a board footprint. */
interface PartItem extends ItemCommon {
  kind: "part";
  x: number; y: number;
  /** Library definition id (Definition.id). */
  def: string;
  ref: string;
  value: string;
  /** Joins the schematic part and its board footprint. */
  link?: string;
  /** Pin number -> net name. */
  pinNets?: Record<string, string>;
  mirror?: boolean;
  /** Gate of a multi-gate symbol, 1-based (`unit` is the KiCad-style alias). */
  part?: number;
  unit?: number;
  /** De Morgan alternate view. */
  alt?: boolean;
  channel?: string;
  sourceLink?: string;
  altiumSourceId?: string;
  parameters?: Record<string, string | number>;
  paramShow?: Record<string, boolean>;
  dnp?: boolean;
  height?: number;
  bodies3d?: PcbBody[];
  boardLabels?: PcbBoardLabel[];
  hiddenBoardLabels?: PcbBoardLabel[];
}
interface WireItem extends ItemCommon { kind: "wire"; points: Point[]; }
interface BusItem extends ItemCommon { kind: "bus"; points: Point[]; }
/** Circular geometry in model millimetres with counter-clockwise angles in degrees. Equal angles make a full circle. */
interface CircularArc { kind: "arc"; c: Point; r: number; start: number; end: number; ccw: boolean; }
/** A copper path. Earlier projects used a boolean tag for tessellated arcs. */
interface TrackItem extends ItemCommon { kind: "track"; points: Point[]; arc?: boolean | CircularArc; }
/**
 * Lines, arcs, fills, solid regions, keepouts and dimensions (app/pcb-draw.js):
 * fill {fill:true, closed:true, fillRect:true}, region {fill:true, closed:true},
 * keepout (layer "Keepout", or keepout:true on one copper layer), arc {arc:CircularArc},
 * dimension {dimension:{type,...}}.
 */
interface GraphicItem extends ItemCommon {
  kind: "graphic";
  points: Point[];
  closed?: boolean;
  fill?: boolean | string;
  fillRect?: boolean;
  keepout?: boolean;
  cutout?: boolean;
  regionShape?: PcbRegionShape;
  keepoutRestrictions?: number;
  planeVoid?: boolean;
  arc?: boolean | CircularArc;
  dimension?: {type: string; [k: string]: unknown};
}
/** A copper pour outline. Pour settings live on the item (polygon-pour.js). */
interface PolygonItem extends ItemCommon {
  kind: "polygon";
  points: Point[];
  closed?: boolean;
  name?: string;
  pourIndex?: number;
  connectStyle?: string;
  viaConnectStyle?: string;
  pourOverSameNet?: boolean;
  /** Original Altium same-net mode and its editable boolean when read. */
  sourcePourOver?: {style: 0 | 1 | 2; sameNet: boolean};
  removeDeadCopper?: boolean;
  /** "solid" (default), "hatched" or "outline" (Altium's None (Outlines Only)). */
  fillMode?: string;
  /** Remove Necks When Copper Width Less Than, mm (absent: off). */
  neckWidth?: number;
  regionShape?: PcbRegionShape;
  powerPlane?: PcbPowerPlane;
}
/** Free text: schematic text or PCB string (pcb-text.js). */
interface LabelItem extends ItemCommon {
  kind: "label"; x: number; y: number; text: string; size?: number;
  sourceTextBox?: PcbSourceTextBox;
}
type AutoNetNameStyle = "hyphen" | "underscore";
interface NetLabelItem extends ItemCommon {
  kind: "netlabel"; x: number; y: number; text: string;
  /** Generated label retaining the pin-based automatic net name in each repeated channel. */
  autoName?: {part: string; pin: string; style: AutoNetNameStyle};
}
interface JunctionItem extends ItemCommon { kind: "junction"; x: number; y: number; }
interface ViaItem extends ItemCommon {
  kind: "via";
  x: number; y: number;
  diameter: number;
  drill?: number;
  fabTestpoint?: FabTestpoint;
  sourceDrillTool?: number;
  /** Blind and buried vias: the copper span. */
  fromLayer?: LayerName;
  toLayer?: LayerName;
}
/** A free pad on the board (footprint pads are PadDef). */
interface PadItem extends ItemCommon, PcbPadFabrication {
  kind: "pad";
  x: number; y: number;
  w: number; h: number;
  shape?: string;
  drill?: number;
  plated?: boolean;
  number?: string;
}
interface PowerItem extends ItemCommon {
  kind: "power";
  x: number; y: number;
  text: string;
  /** circle, arrow, bar, wave, gnd, signal or earth (sch-objects.js POWER). */
  style: string;
  /** 0..3 */
  direction: number;
  showName?: boolean;
}
type PortIO = "unspecified" | "input" | "output" | "bidirectional";
interface PortItem extends ItemCommon { kind: "port"; x: number; y: number; text: string; io: PortIO; }
interface OffSheetItem extends ItemCommon { kind: "offsheet"; x: number; y: number; text: string; io?: PortIO; }
interface SheetEntry { id: string; name: string; side: "left" | "right" | "top" | "bottom"; offset: number; io: PortIO; }
interface SheetSymbolItem extends ItemCommon {
  kind: "sheetsymbol";
  x: number; y: number;
  w: number; h: number;
  name: string;
  sheet: string;
  file?: string;
  entries: SheetEntry[];
  repeat?: {from: number; to: number};
}
interface BusEntryItem extends ItemCommon { kind: "busentry"; x: number; y: number; size?: number; }
interface NoErcItem extends ItemCommon { kind: "noerc"; x: number; y: number; }
interface NoteFieldBinding {
  scope: "item" | "signal" | "sheet" | "project"; field: string; docId?: string; itemId?: string;
  signalId?: string; instanceId?: string; parameterId?: string; detached?: boolean;
}
interface NoteTextMarks { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean; color?: string; highlight?: string; href?: string; }
type NoteRun = NoteTextMarks & ({type:"text";text:string} | {type:"field";expression:string;binding?:NoteFieldBinding} | {type:"math";tex:string});
interface NoteParagraph {style:"paragraph"|"h1"|"h2"|"h3"|"bullet"|"number"|"check"; align?:"left"|"center"|"right"; checked?:boolean; runs:NoteRun[];}
interface RichNoteBody {font?:"sans"|"serif"|"mono"|"hand"|{source:"system";family:string}|{source:"asset";assetRef:{sha256:string;mediaType:"font/ttf";byteLength:number};license:"OFL-1.1"}; blocks:NoteParagraph[];}
interface TextFrameItem extends ItemCommon {
  richText?: RichNoteBody;
  kind: "textframe";
  x: number; y: number;
  w: number; h: number;
  text: string;
  /** Organisational frame. Its text names the rectangle and its contents are determined geometrically. */
  role?: "frame";
  /** Non-electrical equation. The text field holds its TeX source. */
  math?: boolean;
  note?: boolean;
  border?: boolean;
  /** "#rrggbb" */
  fill?: string;
  size?: number;
}
interface ImageItem extends ItemCommon {
  kind: "image";
  x: number; y: number;
  w: number; h: number;
  /** data:image/(png|jpeg|gif|webp|svg+xml);base64,... */
  src?: string;
  asset?: NotebookAssetRef;
  name?: string;
  extent?: [number, number];
  crop?: NotebookRegion;
  angle?: number;
  caption?: string;
  alt?: string;
  clip?: {source: NotebookAssetRef; name: string; page: number; region: NotebookRegion};
}
interface NotebookAssetRef {sha256: string; mediaType: string; byteLength: number}
type NotebookRegion = [number, number, number, number];
interface ImageMarkupItem extends ItemCommon {
  kind: "imageMarkup";
  imageId: string;
  shape: "arrow" | "ellipse" | "box" | "highlight" | "text";
  at: Point; to: Point;
  width: number; colour: string;
  points?: [number, number, number][];
  richText?: unknown;
}

type Item = PartItem | WireItem | BusItem | TrackItem | GraphicItem | PolygonItem | LabelItem | NetLabelItem
  | JunctionItem | ViaItem | PadItem | PowerItem | PortItem | OffSheetItem | SheetSymbolItem | BusEntryItem
  | NoErcItem | TextFrameItem | ImageItem | ImageMarkupItem;
/** The item interface for one kind: ItemOf<"via"> is ViaItem. */
type ItemOf<K extends ItemKind> = Extract<Item, {kind: K}>;

/** Schematic appearance (Altium-restored sheets). */
interface SchPaint {
  size?: number;
  angle?: number;
  type?: string;
  offset?: Point;
  width?: number;
  height?: number;
  direction?: number;
  style?: number;
  [k: string]: unknown;
}

// ------------------------------------------------------------------ library

/** A symbol or footprint drawing primitive. */
interface Shape {
  kind: "path" | "circle" | "text";
  points?: Point[];
  x?: number;
  y?: number;
  r?: number;
  text?: string;
  width?: number;
  layer?: LayerName;
  closed?: boolean;
  fill?: boolean | string;
  /** Multi-gate symbols: the gate this shape belongs to (0 or absent: every gate). */
  part?: number;
  /** De Morgan: true only in the alternate view, false only in the normal one. */
  alt?: boolean;
  schPaint?: SchPaint;
  arc?: CircularArc | {x:number; y:number; r:number; start:number; end:number} | boolean;
  [k: string]: unknown;
}
interface PinDef {
  number: string;
  x: number;
  y: number;
  name?: string;
  angle?: number;
  length?: number;
  /** Electrical type (input, output, power...). */
  type?: string;
  part?: number;
  [k: string]: unknown;
}
interface PadDef extends PcbPadFabrication {
  x: number;
  y: number;
  w: number;
  h: number;
  number?: string;
  angle?: number;
  shape?: string;
  drill?: number;
  layer?: LayerName;
  [k: string]: unknown;
}
interface SymbolDef {
  pins: PinDef[];
  shapes: Shape[];
  /** Number of gates (multi-gate symbols). */
  parts?: number;
  /** Has a De Morgan alternate view. */
  alternate?: boolean;
  [k: string]: unknown;
}
interface FootprintShape extends Shape {
  regionShape?: PcbRegionShape;
  keepoutRestrictions?: number;
  planeVoid?: boolean;
  keepout?: boolean;
  cutout?: boolean;
  sourceTextBox?: PcbSourceTextBox;
}
interface FootprintDef extends PcbBodyGeometry {
  pads: PadDef[];
  shapes: FootprintShape[];
  [k: string]: unknown;
}
/** A library definition: a symbol, a footprint, or both. The validator needs at least one. */
interface Definition {
  id: string;
  name: string;
  symbol?: SymbolDef;
  footprint?: FootprintDef;
  /** Designator prefix for new parts ("U", "R"...). */
  prefix?: string;
  value?: string;
  mirrorOf?: string;
  [k: string]: unknown;
}
/** Placed-pin geometry returned by Atrium.pins(): the definition pin or pad, in world coordinates. */
type PlacedPin = (PinDef | PadDef) & {at: Point};
/** Symbol or footprint, whichever the document kind uses (Atrium.geometries). */
type Geometry = SymbolDef | FootprintDef;

// ------------------------------------------------------------------ documents

interface DocumentBase {
  id: string;
  kind: DocumentKind;
  name: string;
  /** Snap grid, mm, > 0. */
  grid: number;
  items: Item[];
  /** Flattened board outline (pcb), or empty. */
  outline: Point[];
  notes: string[];
  rules?: Rules;
  [extra: string]: any;
}
type DocumentMetadata = Pick<DocumentBase, "id" | "kind" | "name"> & {
  sourceName?: string;
  missing?: boolean;
};
interface SchematicDocument extends DocumentBase {
  kind: "schematic";
  hopOvers?: boolean;
  sheet?: {infinite?: boolean; size?: string; orientation?: "landscape" | "portrait";
           titleBlock?: "none" | "standard" | "ansi"; [setting: string]: unknown};
  schDrawing?: unknown;
  schRestored?: unknown;
}
interface PcbDocument extends DocumentBase, PcbBodyGeometry {
  kind: "pcb";
  origin?: Point;
  stackup?: Stackup;
  /** Altium rule strings kept from an import (altium-rules.js). */
  sourceRules?: string[];
  /** Source compound-file indices for each rule and the saved check selections. */
  sourceRuleChecks?: {kinds: number[]; batch: number[]; online: number[]};
  /** Native check types excluded by the adopted Altium mode, independent of rule enablement. */
  ruleCheckSelection?: {batch: string[]; online: string[]};
  /** One-based source rule records adopted by the board, including rules later deleted. */
  appliedSourceRuleRecords?: number[];
  /** An external rule file replaced the constraints that produced the stored Altium copper. */
  sourceRulesReplaced?: true;
  sourceRuleLayers?: Record<string, LayerName | null>;
  rooms?: unknown[];
  componentClasses?: unknown;
  boardShape?: PcbBoardShape;
  pcbDrawing?: PcbDrawing;
  sourceDrillDrawing?: {tools: PcbSourceDrillTool[]};
  sourcePourSignature?: string;
  sourceSha256?: string;
  sourceArcVersion?: 1;
}
/** A panel (step and repeat) document: no items, the layout is in `panel` (panel.js). */
interface PanelDocument extends DocumentBase { kind: "panel"; panel: Record<string, unknown>; }
/** A fabrication or assembly drawing: no items, the drawing is in `drawing` (drawing.js). */
interface DrawingDocument extends DocumentBase { kind: "drawing"; drawing: Record<string, unknown>; sheet?: unknown; }
type AtriumDocument = SchematicDocument | PcbDocument | PanelDocument | DrawingDocument;

/** An .waffle project (format "atrium", version 1). */
interface Project {
  format: "atrium";
  version: 1;
  formatVersion?: string;
  name: string;
  library: Definition[];
  /** Optional Library organisation. Each member names the exact definition for one package. */
  componentFamilies?: {id: string; name: string; members: {defId: string; part: string}[]; source?: {library: string; id: string}}[];
  /** At least one. */
  documents: AtriumDocument[];
  importNotes?: string[];
  rules?: ProjectRuleBook;
  sourceDrillPlots?: PcbSourceDrillPlot[];
  ruleSets?: unknown;
  multichannel?: Record<string, unknown>;
  layoutBlocks?: unknown[];
  outputJobs?: {name: string; outputs: OutputJobEntry[]; [k: string]: unknown}[];
  bomViews?: {name: string; [k: string]: unknown}[];
  variants?: {id: string; name: string; [k: string]: unknown}[];
  activeVariant?: string;
  extensions?: {manifest: Record<string, unknown>; files?: Record<string, unknown>}[];
  [extra: string]: any;
}

interface OutputJobEntry {
  kind: string;
  /** PDF layouts for infinite schematic sheets. Scale is printed length divided by drawing length. */
  options?: {infiniteLayout?: "fit" | "frames" | "tile"; infiniteScale?: number; [option: string]: unknown};
  [field: string]: unknown;
}

// ------------------------------------------------------------------ nets

/** One net of a schematic sheet, as Atrium.connectivity() reports it. */
interface SheetNet { name: string; pins: number; wires: number; conflict: boolean; }
interface SheetConnectivity {
  /** "<part id>/<pin number>" -> net name. */
  byPin: Map<string, string>;
  /** wire id -> net name. */
  byWire: Map<string, string>;
  nets: SheetNet[];
  /** Generated names recognised from this sheet's pin connectivity. */
  autoNames: Set<string>;
}

// ------------------------------------------------------------------ rules (app/rules.js)

type RuleScopeTarget = {
  projectId?: string; docId?: string; itemId?: string; signalId?: string; entityId?: string;
  definitionId?: string; pinId?: string; instanceId?: string; parameterId?: string; field?: string; kind?: string;
  detached?: boolean; needsRebind?: boolean;
} & ({scope:"project"} | {scope:"sheet";docId:string} | {scope:"item";docId:string;itemId:string} |
     {scope:"signal";signalId:string} | {scope:"entity";entityId:string} | {scope:"terminal";docId:string;itemId:string;pinId:string});
interface RuleScope {
  languageVersion: 1;
  source: string;
  bindings?: {id: string; name: string; span: [number, number]; target?: RuleScopeTarget | null}[];
}
/** One rule of a version 2 set. The constraint fields depend on `type` (rules.js TYPES). */
interface Rule {
  id: string;
  /** clearance, width, viaStyle, polygonConnect, ... (keys of rules.js TYPES). */
  type: string;
  name: string;
  comment?: string;
  enabled: boolean;
  /** 1 is highest. */
  priority: number;
  scope: RuleScope;
  /** Two-object rules (Clearance, Short-Circuit). */
  scope2?: RuleScope;
  [constraint: string]: unknown;
}
interface RuleMinimums { clearance?: number; trackWidth?: number; viaDrill?: number; }
interface RulesV1 {
  format: "atrium-rules";
  version: 1;
  units: "mm";
  defaults: Required<RuleMinimums>;
  nets: Record<string, RuleMinimums>;
}
interface RulesV2 {
  format: "atrium-rules";
  version: 2;
  units: "mm";
  list: Rule[];
  netClasses?: Record<string, string[]>;
  diffPairs?: {name: string; positive: string; negative: string}[];
  diffPairClasses?: Record<string, string[]>;
  netCurrents?: Record<string, number>;
  classCurrents?: Record<string, number>;
  /** Derived summary for older readers; `list` is authoritative. */
  defaults?: RuleMinimums;
  nets?: Record<string, RuleMinimums>;
}
type Rules = RulesV1 | RulesV2;

/** A persisted rule in the unified project rule book (app/project-rules.js). */
interface ProjectRule {
  id: string;
  type: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  severity?: "fatal" | "error" | "warning" | "hint" | "off";
  where?: "schematic" | "layout" | "both";
  boards?: string[];
  /** Exclusions from a project-wide layout rule. */
  exceptBoards?: string[];
  sheets?: string[];
  origin?: {kind: string; tool?: string; board?: string; record?: number; [extra: string]: unknown};
  [constraint: string]: unknown;
}
interface ProjectRuleBook {
  format: "atrium-rules";
  version: 3;
  units: "mm";
  list: ProjectRule[];
  keys?: Record<string, unknown>;
  boardKeys?: Record<string, Record<string, unknown>>;
}

// ------------------------------------------------------------------ stackup (app/stackup.js)

type StackLayerType = "Signal" | "Plane" | "Dielectric" | "Solder Mask" | "Overlay" | "Surface Finish" | "Coverlay" | "Adhesive" | "Stiffener";
interface StackLayer {
  type: StackLayerType;
  name: string;
  material: string;
  /** mm */
  thickness: number;
  dielectric?: "Core" | "Prepreg";
  dk?: number;
  df?: number;
  /** Copper layers: the Waffle layer key (Top, Inner n, Bottom). */
  key?: LayerName;
  [k: string]: unknown;
}
interface Stackup {
  version: 1;
  layers: StackLayer[];
  drillPairs: {from: LayerName; to: LayerName}[];
  source?: string;
  main?: {name: string; flex: boolean};
  substacks?: {id: string; name: string; flex: boolean; layers: StackLayer[]}[];
  regions?: unknown[];
  bends?: unknown[];
  impedanceProfiles?: unknown[];
  [k: string]: unknown;
}

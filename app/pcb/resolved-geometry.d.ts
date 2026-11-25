/** A1 rigid root board and panel occurrences. XY is millimetres, +X right and +Y down.
 * Z is millimetres from the bottom face of the lowest dielectric towards Top.
 * Circular angles follow Atrium.arcPoint in degrees. Ellipse parameter angles use both axis vectors. */
export type XY = readonly [x: number, y: number];
export type Bounds = readonly [minX: number, minY: number, maxX: number, maxY: number];
export type Edge =
  | { readonly kind: "line"; readonly a: XY; readonly b: XY }
  | { readonly kind: "arc"; readonly center: XY; readonly radius: number; readonly start: number; readonly sweep: number }
  | { readonly kind: "ellipseArc"; readonly center: XY; readonly cosineAxis: XY; readonly sineAxis: XY;
      readonly start: number; readonly sweep: number };
export type Loop = readonly Edge[];
export interface Island { readonly outer: Loop; readonly holes: readonly Loop[] }
export type Area = readonly Island[];

/** Empty instancePath identifies the root. Repeated panel instances and repeated pad numbers have distinct keys. */
export type Owner = { readonly documentId: string; readonly instancePath: readonly string[] } &
  ({ readonly kind: "board" } | { readonly kind: "item"; readonly id: string });
export interface FeatureKey {
  readonly owner: Owner;
  readonly member: readonly string[];
  readonly role: "land" | "track" | "pour" | "drawing" | "legend" | "text" | "mask" | "paste" | "profile" | "keepout";
  readonly layer: LayerName;
}
/** Authoritative plot primitive. A flash has its exact local aperture and a board-space placement. */
export type Artwork =
  | { readonly kind: "stroke"; readonly centerline: readonly Edge[]; readonly width: number }
  | { readonly kind: "flash"; readonly aperture: Area; readonly at: XY; readonly clockwiseDegrees: number; readonly mirrorLocalX: boolean }
  | { readonly kind: "region"; readonly islands: Area };
export interface Feature {
  readonly key: FeatureKey;
  readonly ink: Artwork;
  readonly polarity: "add" | "clear";
  readonly net: string | null;
  readonly bounds: Bounds;
  /** Present on actual inscriptions. Geometry has already applied these values to ink. */
  readonly text?: { readonly content: string; readonly origin: XY; readonly authoredDegrees: number; readonly clockwiseDegrees: number;
    readonly justification: PcbSourceTextJustification; readonly mirrored: boolean };
}
export interface BoreKey { readonly owner: Owner; readonly member: readonly string[] }
export interface ViaTreatment {
  readonly ipc4761: "none" | "I" | "II" | "III" | "IV" | "V" | "VI" | "VII";
  readonly ipcSides: "top" | "bottom" | "both" | null;
  readonly tented: { readonly top: boolean; readonly bottom: boolean };
}
export type Bore = {
  readonly key: BoreKey;
  readonly cutter: { readonly kind: "round"; readonly at: XY; readonly diameter: number }
    | { readonly kind: "slot"; readonly centerline: readonly [Edge, ...Edge[]]; readonly diameter: number };
  readonly from: LayerName;
  readonly to: LayerName;
  readonly z: readonly [bottom: number, top: number] | null;
} & ({ readonly operation: "primary"; readonly plated: boolean; readonly treatment: ViaTreatment | null }
  | { readonly operation: "backdrill"; readonly plated: false; readonly primary: BoreKey });
export interface OccupiedLayer {
  readonly name: LayerName;
  readonly kind: "copper" | "dielectric" | "mask" | "paste" | "legend" | "mechanical" | "annotation";
  readonly z: readonly [bottom: number, top: number] | null;
}
export interface GeometryDiagnostic {readonly owner: Owner; readonly member: readonly string[]; readonly code: string}
export interface OwnerGeometry {
  readonly owner: Owner;
  readonly features: readonly Feature[];
  readonly bores: readonly Bore[];
  /** The authored nominal land is a separate DFM input from any individual finished layer. */
  readonly nominalLands: readonly { readonly member: readonly string[]; readonly ink: Artwork }[];
}
/** A token is opaque outside its issuing process and project binding. Detached jobs pin their own inputs. */
export interface GeometryRevision {
  readonly projectId: string;
  readonly rootId: string;
  readonly kind: "committed" | "snapshot" | "preview";
  readonly generation: string;
}
/** Missing history or incompatible revision lineages require a cold rebuild. The same revision gives empty arrays. */
export type GeometryDelta =
  | { readonly kind: "cold" }
  | { readonly kind: "incremental"; readonly owners: readonly Owner[];
      readonly layers: readonly LayerName[]; readonly bounds: readonly Bounds[] };
export interface GeometryView {
  readonly revision: GeometryRevision;
  readonly layers: readonly OccupiedLayer[];
  /** Map changes from a prior token to this view. Dirty boxes are in root board coordinates.
   * Include the union of previous/current owners, physical layers and extents for moves, removals and definition changes. */
  changes(since: GeometryRevision): GeometryDelta;
  diagnostics(): Iterable<GeometryDiagnostic>;
  /** Every read and iterator step on an expired editor/preview view throws StaleGeometryError. Detached views stay pinned. */
  assertCurrent(): void;
  owner(key: Owner): OwnerGeometry | undefined;
  /** Iterate in authored draw order. A layer or bounds restriction narrows the demand. */
  features(filter?: { readonly layer?: LayerName; readonly bounds?: Bounds }): Iterable<Feature>;
  bores(filter?: { readonly crossesLayer?: LayerName; readonly bounds?: Bounds }): Iterable<Bore>;
  /** Swept area of this feature in board coordinates. Finished material subtracts intersecting bores from any owner. */
  area(key: FeatureKey, stage: "film" | "finished"): Area;
  /** Includes all add/clear features in plot order, then the layer-specific drilling/material policy. */
  layerArea(layer: LayerName, stage: "film" | "finished", bounds?: Bounds, z?: number): Area;
}
export interface StaleGeometryError extends Error { readonly code: "STALE_GEOMETRY" }
export type PreviewEdit =
  | { readonly kind: "item"; readonly owner: Extract<Owner, {kind: "item"}>; readonly value: Item | null }
  | { readonly kind: "board"; readonly owner: Extract<Owner, {kind: "board"}>; readonly value: PcbDocument | PanelDocument }
  | { readonly kind: "definition"; readonly id: string; readonly value: Definition | null };
/** Only choices that affect physical output. The resolver snapshots effective defaults and keys their derived films. */
export interface FilmDefaults {
  readonly maskExpansion?: number; readonly pasteExpansion?: number; readonly overrideExpansions?: boolean;
  readonly tentTop?: boolean; readonly tentBottom?: boolean;
}
export type GeometrySource =
  | { readonly kind: "editor"; readonly project: Project; readonly root: PcbDocument | PanelDocument }
  | { readonly kind: "snapshot"; readonly project: Project; readonly root: PcbDocument | PanelDocument; readonly revision: GeometryRevision };
export interface ResolvedBoardGeometry {
  /** One polyline for a contiguous edge chain. Includes both end points and repeats the start only for a closed chain.
   * toleranceMm bounds chord deviation in model space; a nonpositive or nonfinite value throws RangeError.
   * Empty input gives an empty polyline. Reject a discontinuous chain or an allocation beyond the geometry budget. */
  flatten(edges: readonly Edge[], toleranceMm: number): readonly XY[];
  /** Swept physical ink for a circular pen with round joins and caps. Preserves exact line/circular boundaries
   * where representable. Any required approximation uses flatten's tolerance and world-space convention. */
  strokeOutline(stroke: Extract<Artwork, { kind: "stroke" }>, toleranceMm: number): Area;
  read(source: GeometrySource, defaults?: FilmDefaults): GeometryView;
  readEditor(project: Project, root: PcbDocument | PanelDocument, defaults?: FilmDefaults): GeometryView | null;
  prepareEditor(host: { project(): Project; drag(): unknown }, project: Project,
    root: PcbDocument | PanelDocument, defaults?: FilmDefaults): Promise<GeometryView | null>;
  /** A transient overlay for a gesture. A null replacement removes the owner in this view only. */
  preview(base: GeometryView, edits: readonly PreviewEdit[]): GeometryView;
}

export const { read, readEditor, prepareEditor, preview, flatten, strokeOutline }: ResolvedBoardGeometry;

# Autorouting from fixed placements

This local experiment strips public routed PCBs, runs Waffle's existing engines, and fits a small linear selector for a single routing profile. Each test family is excluded from training. The experiment runs only on explicit invocation. [Measured results](findings.md)

With Node 22 or later, run from the repository root. The first command prepares and verifies the external caches. All subsequent commands work offline.

```sh
node tests/fixed-placement-routing/fetch.cjs
node tests/fixed-placement-routing/fetch.cjs --offline
node tests/fixed-placement-routing/check.cjs
node tests/fixed-placement-routing/bench.cjs > routing-results.json
```

For an individual run, add `--boards tpl5110 --methods v1,v2,single,margin,escape,direct,congestion`. To open a fixed-placement copy, use `node tests/fixed-placement-routing/materialise.cjs tpl5110 /tmp/timer.waffle`. The file must be new. The copy is derived from the hardware design and remains subject to its original licence.

## Protocol

- The sources manifest pins each PCB and hardware licence. The Altium projects reuse the checked hashes in the Altium fidelity fixture manifest. The source reader verifies the offline bytes on each run. Each Eagle design uses its named release commit.
- The materialisation carries pads, assigned pad nets, transforms, footprint geometry, board contour and cutouts, keepouts, stackup and rules supported by the importer. The six development designs use two copper layers. The independent motor driver uses four. Holes remain physical obstacles. Normally closed solder-jumper bridges stay in their footprint. Ordinary tracks, arcs, vias, pours, copper fills, drills derived from routes and old connectivity information are removed. Locked board routes are included in the removal. No board-level preroutes are retained.
- Every pad net is in scope, including supply and ground. The human reference can use polygons. The reference report identifies poured nets and nets with pours but no tracks. Eagle stores polygon boundaries, so Waffle reconstructs their fills for reference connectivity. Track length excludes copper area in polygons.
- A fresh routing process receives only the stripped board. It runs the shipped v1 and v2 APIs plus five one-pass v2 profiles using the same setup, search and post-processing. The full v2 baseline can use its shipped alternate search passes. All calls use a deterministic test clock and IDs for repeatability. The wall timer measures the actual routing call separately. The single-pass search expansion count breaks geometric ties. Time and iteration counts are kept separate.
- The profiles are fixed before training. They vary net order, congestion, grid resolution for pad escape, directional cost, via price, corner shape and a conservative planning clearance margin. Original electrical rules remain active for every method. The untrained heuristic is the fixed margin profile.
- Full connectivity and full rule checks inspect the proposed copper independently of the routing engine. A second outline test checks each whole segment, its radius and cutouts. Raw results include pre-existing placement violations separately. The common offline guard removes entire newly routed nets implicated in new issues, rechecks all remaining copper, and rejects everything if it cannot establish legality. The reports retain both raw and accepted results. Opens come from physical connectivity, including isolated islands. The comparison ranks legal completion and opens before vias, track length and search work.
- Fit one linear rank regressor per single-pass profile, each with an intercept and three inputs from the stripped physical placement. These are terminal density, terminals per net and through-pad fraction. Feature centring, scaling and labels use training boards only. Each training family has equal weight. Ridge shrinkage is fixed at 2. Select the lowest predicted rank on an unseen placement and run that one profile. The two Adafruit projects share a holdout group, as do both SparkFun Qwiic projects. PiDP-11 and MIDAS each form separate groups.

## Frozen model and independent confirmation

`models.json` contains the four held-out models and a fifth trained on all six development boards for entirely new families. They were fitted on the original router at `1ae7f18`. The normal benchmark reuses those coefficients. `--refit` trains the same estimator again on the full development corpus and never includes the confirmation family. To apply the frozen selector with a single route call and save the accepted copper, use `node tests/fixed-placement-routing/propose.cjs tpl5110 /tmp/timer-routed.waffle`.

The Watterott SilentStepStick TMC2209 v2.0 and StepStick Protector v2.0 are reserved together as a separate hardware family for confirmation. Neither design enters training or profile selection. Run `node tests/fixed-placement-routing/bench.cjs --confirmation --rescue > confirmation.json`. The same optional `--rescue` flag on the development boards is exploratory.

The two fallback policies start from identical independently checked single-pass v2 copper. Both take the shortest remaining physical airwires first, call the shipped suggestion engine at most 12 times with the same 24,000-cell target and 32 logical-ms budget, and try the reverse direction on a second attempt. The centre policy uses the existing terminal coordinates. The edge policy considers four points 40% of the pad dimension from its centre along its rotated axes. It favours distance from foreign copper with a small direct-distance penalty. A proposal must reduce independently counted opens and pass the complete physical and rule checks. The report records actual cells, calls, checks and time.

The additional physical checks cover unassigned electrical lands, copper crossing a cutout, and keepouts attached to footprints. Legacy Eagle imports collapse the three source restrict-layer types into Waffle's general keepout layer. Results use the imported restrictions for every method. Reference results identify actual filled region area on each layer separately from track length.

## Focused acceptance gate

Run `node tests/fixed-placement-routing/check.cjs` for the source-free tests. The cached eight-board gate checks every profile, frozen family selection, accepted geometry, and both bounded rescues with `node tests/fixed-placement-routing/gate.cjs`. The original engine at `ff5ef78` can reproduce its historical outcomes with `--original-engine`. The final engine used for the recorded geometry is `cb5a05dc`. The preceding integrated via-sizing fix at `5f4660c` produced identical non-timing results. Time measurements are descriptive and are excluded from the gate.

To replay against that exact engine from a checkout containing this experiment, materialise both Git trees in a temporary directory. Set `engine` to the original commit and pass `--original-engine` to its gate for the earlier comparison.

```sh
engine=cb5a05dc2c9ce59b3f774aec5d230fd7f521d2fb
replay=$(mktemp -d)
git archive "$engine" | tar -x -C "$replay"
git archive HEAD tests/fixed-placement-routing | tar -x -C "$replay"
node "$replay/tests/fixed-placement-routing/gate.cjs"
```

For a repeated measurement, save a development run with `--rescue` and a confirmation run with `--confirmation --rescue` for each engine. Run `python3 tests/fixed-placement-routing/evidence.py --help` for the aggregation command. It checks all geometry hashes, opens, violations, route lengths, expansions and held-out model coefficients across repetitions before reporting median wall times.

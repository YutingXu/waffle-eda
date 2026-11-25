# Autorouter and fanout

**Route › Auto Route** routes unrouted connections. **Auto Route › Fanout…** escapes BGA and fine-pitch pads to vias.
Both dialogs offer two engines. The choice is remembered.

- **Engine v1 (classic, the default).** This engine applies its result directly as one undo step.
- **Engine v2.** This engine computes a proposal and draws it on the board. You then choose **Accept** (one undo step), **Discard**, or **Compare…**.
  - **Compare…** opens the proposal in the diff view, with the current board against the board with the proposal applied.
  - While v2 routes, routes are drawn on the board as they land.
  - **Stop** cancels the run and changes nothing.

v1 stays the default until v2 wins every benchmark (`tests/autorouter-bench.cjs`). Today v2 completes more connections and uses fewer vias, with no clearance errors. It is slower, though: about 1.3–1.5× on small boards and up to 8× on dense, incomplete ones, where it retries.

## What v2 does

1. **Safety.** The router never changes locked copper.
   - Nets listed in `board.autorouter.fixedNets` are left alone.
   - With **Lock all pre-routes** off, only unlocked tracks and vias of the nets in scope are ripped up.
2. **Fanout v2.** This step runs on multi-layer boards that have a BGA.
   - **Ring-by-ring escape.** The outer rings that fit through the top-layer channels get no via. Deeper rings get a via and an escape layer, two rings per inner layer. The router then prefers that layer for the net.
   - **Dog-bones by quadrant.** Each dog-bone points outward from the ball.
   - **Pairs.** Balls of a differential pair get mirrored dog-bones.
   - **Power and ground.** These balls get plane vias. A power-net exposed pad of a QFN or QFP gets a thermal via array.
   - **HDI boards** (Design › HDI Via Setup…, stored as `doc.hdi`):
     - Via-in-pad, as filled laser microvias.
     - Rings assigned to inner build-up layers get chains of microvias. They are stacked while the HDI Vias rule's *Max stacked microvias* allows, and staggered by *Min staggered microvia pitch* beyond it (or always, when the build-up is set to staggered).
3. **Criticality order.** Differential pairs route first, then members of matched-length groups, then the Routing Priority rule, then short connections before long ones.
4. **Detailed routing.**
   - A fine-grid negotiated-congestion router (PathFinder rip-up and retry).
   - Vias keep the Hole To Hole clearance, including from the same net's vias and from pad holes.
   - Differential pairs are routed coupled.
5. **Via minimisation.** Each connection that changes layer is rerouted on one layer, then with a much higher via cost, against everything else. The new route is kept only if it has fewer vias and is not much longer.
6. **45° pad entries.** Off-angle pad entries become a straight run plus a 45° leg.
7. **Retries.** When connections are left unrouted, v2 tries a finer grid, global routing guides (a congestion-aware PathFinder over coarse routing cells that assigns channels and layers), and cheaper vias. The most complete and cleanest result wins.
8. **Push-and-shove completion.** Connections that are still open try the interactive router's shove engine. It may move only the proposal's own tracks.
9. **Post-processing.**
   - Gloss: fewer bends. Each change is checked exactly.
   - Matched-length groups (Matched Lengths rules and the Length Manager's groups) are tuned with meanders. Differential-pair groups are not tuned automatically.
   - Teardrops, when you ask for them.
   - On HDI boards, routed vias whose tracks use only build-up layers become laser microvias.
10. **Report.** The report covers completion, vias, length, bends per connection, the share of segments at 0/45/90°, length per layer, pair coupling, length tuning, and the changes per net.

## MCP

`autoroute` and `fanout` take `engine: "v1" | "v2"`. Both return proposals unless `mode: "write"`.

## Benchmark

```sh
scripts/test-jsc.sh autorouter-bench          # quick check: sample + eco-e2e, both engines, DRC 0
jsc tests/jsc-shim.js -- $PWD/tests/autorouter-bench.cjs --run [--engines v1,v2] [--boards a,b] [--repeat N] [--real DIR] [--svg]
```

See the [benchmark runner](../tests/pcb/autorouter-bench.cjs), [generated boards](../tests/pcb/autorouter-bench-boards.js) and [fixture files](../tests/autorouter-bench-fixtures).

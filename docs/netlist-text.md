# Netlist text

Open **Design → Netlist** to read the project's compiled parts, connections, signals and tags. Click a designator, pin, net, signal or tag to select its placed objects in the schematic or PCB. The tab stays open when you cross-probe. **Copy text** copies the complete document. **Check text** shows the first affected line and column for each reported issue.

## Format 1

```text
netlist 1

part J1 device Connector value "" footprint Header pins [1:passive, 2:passive]
part U1 device Receiver value "" footprint SOIC8 pins [1:input, 2:input]

net D+ = [J1.1, U1.1]
net D- = [J1.2, U1.2]

signal Link diff = [D+] | [D-]
signal "Port bus" bus = [Link]

tag External nets [] signals [Link]
```

The version header comes first. Each declaration occupies one line. Blank lines are allowed, and declarations may refer to a name defined later in the document. A name can be a bare ASCII token made of letters, digits, underscores, plus signs, hyphens and slashes. Quote any other name as a JSON string. A period separates a designator and a pin, so a designator like `"U.1"` needs quotes. Empty strings are valid for device, value and footprint.

| Declaration | Meaning |
| --- | --- |
| `part REF device DEV value V footprint FP pins [PIN:TYPE, ...]` | One physical component. Multi-gate symbols share the package designator and repeated sheet channels use their physical designators. The reader also accepts a part without the optional `device DEV` field. |
| `net NAME = [REF.PIN, ...]` | All component pins on this net. A named net made solely of wires or board copper has an empty list. |
| `signal NAME single = [NET, ...]` | One signal leg. A leg which spans a series component can contain several nets. |
| `signal NAME diff = [NET, ...] \| [NET, ...]` | Positive leg followed by negative leg. Each leg contains at least one net. |
| `signal NAME bus = [SIGNAL, ...]` | Member signals are referenced by name. Buses can be nested. |
| `tag NAME nets [NET, ...] signals [SIGNAL, ...]` | Tag assignments to nets and signals, including declared tags with empty lists. |

Electrical pin types are `input`, `bidirectional`, `output`, `open_collector`, `passive`, `tri_state`, `open_emitter` and `power_in`. Pin numbers and net names are case-sensitive. Component designators, signal names and tag names bind case-insensitively.

The writer sorts each group and its members by UTF-16 code-unit order. It preserves differential polarity and finishes every line with LF. Populated schematic sheets supply the physical connections and the same net names used by the editor, including the compiler's choice among conflicting labels. A board-only project uses PCB pads. For a project with several boards the selector chooses board-scoped signals, bus members and tags and, when reading PCB connectivity, the board. The initial selection is the first board by name, then ID.

## Validation and headless access

- The checker recognizes the grammar, required header and record fields. It checks duplicate names and pins, missing references, conflicting pin assignments, empty or overlapping signal legs, bus cycles and the project's unscoped electrical pin matrix. Full schematic ERC supplies sheet context and scoped exceptions.
- Diagnostics contain `code`, `severity`, `message`, `line`, `column` and `endColumn`. Lines and columns start at one. Column offsets count UTF-16 code units and the end column is exclusive. Up to 100 diagnostics are returned with the full error and warning counts. The bounded checker stops with a diagnostic on input over 32 Mi UTF-16 code units, 200,000 tokens per line or 1.5 million tokens in total.
- The read-only MCP tool `read_netlist` returns the editor's exact text at `untrusted_design_text.text`, plus the source, selected board ID, declaration counts, total line count and project revision. To page it, pass `line_offset` (zero-based) and `line_limit`, then use `next_offset` for the following page. Concatenating the slices reproduces the complete document. Pass `document_id` to select a board.
- The read-only MCP tool `validate_netlist` accepts `{"text":"…"}` and returns `valid`, `errors`, `warnings` and `untrusted_design_text.diagnostics`. Project names and diagnostic text can contain user-authored content. Return values keep them in the design-text field. See the [MCP netlist tools](../mcp/README.md#netlists).

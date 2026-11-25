# Sourcing parts offline

Waffle's starter library and generic part tools provide symbols, footprints and electrical values
for common parts such as resistors, capacitors, LEDs and connectors. Manufacturer part numbers
(MPNs) and supplier codes in your BOM come from you or from a lookup you request.

## What a starter part carries

| Parameter | Filled in | Notes |
|---|---|---|
| Value, Tolerance, Voltage, Power | Yes | Generic ratings for the size, for example 10 kΩ, 1 %, 75 V, 1/10 W for an 0603 resistor |
| Package | Yes | Shown in the library's Package filter |
| `LCSC #` | **Empty** | A supplier code for JLCPCB assembly orders |
| MPN, Manufacturer | Not present | Added by you or by **Assign part numbers** |

The description says the same: "Generic … Not a specific part: choose one and fill in its LCSC # (or
MPN) before ordering." The preview in **Place › Component** shows a yellow *needs sourcing* note
until a part has a supplier number.

## Organize component families and packages

Open **Window › Panels › Library**. Search by family, chip model, component name, or package. For
example, combine a chip model with `pkg:QFN` to narrow its package choices. Expand a family, then a
chip model, and select the package to see its symbol and footprint together. Use **Place on sheet**,
**Place on board**, **Edit symbol**, or **Edit footprint** from that selection. **Place › Component**
also shows the family and chip headings. Click an exact package row to start placement, or focus the
row to review both previews and choose **Place**.

1. Choose **Manage families…**, select **New family…**, and enter the family name. Find each existing
   library definition with **Component to add** and choose **Add component**. Set the same **Chip model**
   for definitions that represent package options for one chip. Give each distinct chip its own label,
   then choose **Save family**.
2. For a symbol without a footprint, select it and choose **Attach footprint…**. From a standalone
   land pattern, choose **Attach symbol…**. Pick the other asset and check the two previews. Waffle
   checks that the pin and pad numbers correspond. For a chip that already has a package, **Add
   package…** makes a separate definition from its symbol and a compatible footprint. Enter the new
   component name and its part number if known.
3. Choose **Edit family…** to rename it or remove individual definitions from the group. **Ungroup
   family** returns every package to the standalone list. **Edit › Undo** reverses a family edit.

For a reusable `.atrlib` file, use **Library source › Open library file…**. Select an exact package
and choose **Add to project** to copy its component definition and family membership into the project.
Switch the source to **This project** to edit the copy.

For example, a project with verified AD5940 and AD5941 definitions can put both chips in one
family. Give each chip its own **Chip model** label and add only the package definitions verified
for that chip. The example describes how to organize your library. The part number for each
package comes from its own definition or the value entered on a placed component.

An assembly variant can fit another library definition at an existing placement. The board keeps
its original footprint and pads. The BOM and the KiCad BOM CSV use the fitted manufacturer's name
and part number. A missing part number on the alternate stays blank. A parameter override on the
variant takes priority, including when one source spells the field `MPN` and another uses
`Manufacturer Part Number`.

## Three ways to fill in part numbers

1. **By hand.** Select the part in the Library panel and edit its parameters in the symbol editor,
   or select a placed part on a schematic sheet and edit its parameters in the Properties panel. Type the `LCSC #`, `MPN` and
   `Manufacturer` from the datasheet or distributor page of the part you chose.
2. **From a parts CSV you supply (offline).** Open **Reports › Bill of Materials**, choose
   **Optimise**, then **Suppliers**. Enable *JLCPCB parts library (offline CSV)* and choose
   **Import CSV…**. Use a file you are allowed to use, such as JLCPCB's parts-library download or
   your own stock list. Waffle reads it on your machine; nothing is uploaded.
   - Recognised columns (case-insensitive): `LCSC Part` (or `LCSC`, `JLCPCB Part #`), `MFR.Part`
     (or `MPN`, `Manufacturer Part Number`), `Package` (or `Footprint`), `Library Type`
     (Basic/Extended), `Manufacturer`, `Description`, `Stock`, `Price`, `First Category`.
   - The file needs at least an LCSC or an MPN column.
   - Only rows this BOM can use are kept in memory. They are matched by LCSC #, by MPN, or by
     value and package for resistors, capacitors and inductors.
   - Then press **Assign part numbers**. It writes only what the lookup returned: `LCSC #`,
     `JLC Part Type` (Basic/Extended), and an MPN or manufacturer where the field was empty. It is
     a single undoable edit.
3. **From a supplier you enable (online, opt-in).** The same Suppliers list has Mouser, DigiKey
   and Octopart (Nexar). Each needs your own API key, which is stored in this browser profile
   (`localStorage`), never in the project. Only a part number or a value query such as
   "10kΩ 0603 resistor 1%" leaves the machine. Designators, net names and file names never do.
   LCSC and the JLCPCB API are listed but not available: their APIs are partner-only.

## Checking before you order

- The BOM grid shows **Supplier Part Number** once any part has an `LCSC #`, so gaps stand out.
- The **JLC BOM** output job lists every line that has no LCSC code, and the job's report repeats
  the reminder.
- A starter footprint is generic too. Compare the land pattern with the drawing of the part you
  bought, especially connectors, crystals and switches. The USB-C receptacle says so in its
  description.

## For scripts and AI clients

`AtriumCatalogue.find(query)` searches the library by text and parameters, for example
`find("10k 0603")`, `find("cat:diode mount:smd")` or `find("starter-ldo-sot223")`. It returns stable
library ids with their category, value, package, pins and mounting. The result includes
`supersededBy` when a built-in part has a starter twin. It never returns a supplier number the
library does not already hold.

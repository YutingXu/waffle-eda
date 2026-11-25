# PairsXSignals.PcbDoc

A synthetic Altium board made for Waffle EDA’s import tests. It covers differential pairs, a differential pair class, xSignals and an xSignal class. Waffle EDA contributors made this synthetic fixture under the repository’s licence.

| Item | Contents |
| --- | --- |
| Board | 2000 × 1200 mil rectangle, top layer only |
| Components | U1 (`ATRIUM_QFN8`, 7 pads), J1 (`ATRIUM_CONN6`, 6 pads), C1 and C2 (series AC caps, `ATRIUM_0402`), C3 (decoupling) |
| Nets | USB_DP, USB_DM, PCIE_TX_P, PCIE_TX_N, PCIE_TX_C_P, PCIE_TX_C_N, CLK, GND, +3V3 |
| Tracks | 6 top-layer tracks on the USB and PCIe nets |
| Net classes | HS_NETS (the 6 USB and PCIe nets), POWER (GND, +3V3) |
| Differential pairs | USB (USB_DP / USB_DM), PCIE_TX (PCIE_TX_P / PCIE_TX_N) |
| Differential pair class | HS_PAIRS (USB, PCIE_TX) |
| xSignals | PCIE_TX_P_XS (U1-3 → C1 → J1-3), PCIE_TX_N_XS (U1-4 → C2 → J1-4), USB_DP_XS (U1-1 → J1-1), USB_DM_XS (U1-2 → J1-2) |
| xSignal classes | PCIE_TX_XSIGNALS (both PCIe xSignals), USB_XSIGNALS (both USB xSignals) |
| Rules | HS_DiffPairs (`DiffPairsRouting`, `InDifferentialPairClass('HS_PAIRS')`), PCIE_TX_MatchedLength (`MatchedLengths`, `InxSignalClass('PCIE_TX_XSIGNALS')`, 10 mil tolerance), plus Designer's default rules |

## How it was made

Altium Designer 26.12.2 built the board from an empty PCB document and saved it in the binary PcbDoc format (`PCB 6.0 Binary File`). The editor ran on macOS through Wine. No library, project or template was used.

- `tests/altium-wine/MakePairsFixture.pas`: the DelphiScript that creates everything above through Designer's PCB API. xSignals come from `Board.PinPairsManager.CreateFromPins` and classes from `AssignPinPairClass`. Designer chose the path through C1 and C2 on its own.
- `tests/altium-wine/make_pairs_fixture.py`: runs the script in an open Designer, normalizes the file and has Designer reopen the result. The run passes only if Designer reads back every class, pair, xSignal and rule.

Normalization changes two things that depend on the Designer session, not on the design. It empties `EmbeddedFonts6`, which held an embedded copy of Arial even though every text is a stroke text. It also clears `2DCONFIGFULLFILENAME`, a path into the Windows user profile. The script clears online DRC markers before saving, so the file has no violation streams. The ASCII PcbDoc format was not used. Designer writes it in the legacy 5.01 layout, which drops pair classes, xSignals and xSignal classes.

SHA-256: `4d7d335685758b11dc150807e27556470573e9b4df5ea4815ce6ef1fbee3a4cd`

The stream and record layout is described in the [Altium PcbDoc format notes](../../../../docs/design/altium-pairs-xsignals-format.md).

Altium Designer is a trademark of Altium LLC. Waffle EDA is not affiliated with Altium.

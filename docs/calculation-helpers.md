# Engineering calculation functions

The notebook and palette use the same functions. Function arguments carry their written or bound units. The display uses up to four significant figures. Snapping, conversions and comparisons use the original binary64 value.

## Preferred values

Write `3.3k in E24` or `nearest E96 3.31k`. They give **3.3 k** and **3.32 k**. The second has a signed selection error of **+0.3021%**. An explicit resistance, capacitance or other linear physical unit is preserved, as in `nearest E96 3.31kΩ`. The series are E3, E6, E12, E24, E48, E96 and E192. They share their nominal values with Tools → Calculators. A series suffix requires its keyword. `3.3E24` is a scientific number.

The closest nominal minimises the absolute logarithm of its ratio to the input. At the geometric mean of two neighbours, the lower nominal wins. Neighbours include the first value of the following decade. For example, E6 snaps 8.2 to 6.8 and 8.3 to 10. The signed relative error is (selected − requested) / requested. A tolerance interval that spans a selection threshold reports the possible nominal range and an unavailable RSS. [IEC 60063](https://webstore.iec.ch/en/publication/22011) · [Vishay decade table](https://www.vishay.com/docs/31001/dectable.pdf)

## Resistor markings

| Expression | Result |
|---|---|
| `bands("yellow violet red gold")` | 4.7 kΩ ±5% |
| `resistorBands(4.7kΩ, 1%, 5)` | Yellow, violet, black, brown, brown |
| `resistorBands(4.7kΩ, 1%, 6, 50 ppm/K)` | The same five bands followed by red for 50 ppm/K |
| `bands("gold red violet yellow", "reverse")` | 4.7 kΩ ±5% |

The first name is the first significant digit by default. Use `"reverse"` for a known opposite reading direction, or `"auto"` for an unoriented resistor. When both orders give valid markings, automatic decoding requests the first digit. Three bands imply ±20%. Four bands carry two digits and a stated tolerance. Five and six bands carry three digits. Six bands also carry a temperature coefficient. Encoding reads the nominal of a typed resistance, including a bound resistor with a tolerance. It requires an exactly representable nominal and a supported marking tolerance. Each record carries the band names and swatches, and typed fields for nominal resistance, tolerance, digit count, multiplier, band count and optional TCR. [IEC 60062](https://webstore.iec.ch/en/publication/65655) · [TE resistor marking examples](https://www.te.com/en/products/passive-active-electronic-components/resistors/intersection/resistor-color-codes.html)

## Solid round wire

`awg(24)` gives **0.5106 mm** bare diameter and **0.2047 mm²** area. Quote a repeated-zero designation, as in `awg("0000")`, to distinguish it from the numeric zero. Signed gauge numbers −3 through 56 are also accepted. Diameter follows the geometric progression through 0.127 mm at AWG 36 and 11.684 mm at AWG 0000, before rounding.

`nearestAWG(0.5 mm)` yields AWG 24 and a **+2.112%** diameter error. A cross-sectional area such as `0.2 mm²` compares areas. The nearest nominal uses logarithmic distance in the supplied dimension, selects the thicker wire at a tie and reports endpoint gauges for out-of-range sizes. Records include numeric gauge, diameter and area. These are dimensions of the bare conductor. [NBS Copper Wire Tables, sections 2.1–2.2](https://nvlpubs.nist.gov/nistpubs/Legacy/hb/nbshandbook100.pdf)

## Power, voltage and decibels

| Expression | Meaning |
|---|---|
| `dbPower(2)`, `dbPower(2 W, 1 W)` | 3.01 dB power ratio |
| `dbVoltage(2)`, `dbVoltage(2 V, 1 V)` | 6.021 dB amplitude ratio |
| `powerRatio(20 dB)`, `voltageRatio(20 dB)` | 100 times the power, 10 times the amplitude |
| `dbm(1 mW)`, `watts(0 dBm)` | 0 dBm and 1 mW |
| `dbm(1 V, 50 Ω)`, `vrms(0 dBm, 50 Ω)` | 13.01 dBm and 0.2236 V RMS at the stated resistive load |
| `dbv(1 V)`, `vrms(0 dBV)` | 0 dBV and 1 V RMS |
| `watts(10 dB, 2 W)`, `vrms(20 dB, 1 V)` | 20 W and 10 V RMS with explicit references |
| `vpeak(1 V, "sine")`, `vpp(1 V, "sine")` | 1.414 V peak and 2.828 V peak-to-peak |

The conversion operator also uses these functions. For example, `0 dBm in mW` gives 1 mW and `0 dBV in V` gives 1 V. Ratios and reference quantities must be positive. dBm fixes the reference at 1 mW. dBV fixes it at 1 V RMS. Converting dBm to volts requires the resistive impedance. Converting relative dB to volts requires a voltage reference. An RMS-to-peak conversion takes a waveform of `"sine"`, `"square"` or `"triangle"`, or an explicit peak/RMS crest factor of at least one. For peak-to-peak conversion these waveforms and the single supplied crest factor describe a signal symmetric about zero. [Analog Devices RF power and voltage relationships](https://www.analog.com/en/resources/technical-articles/measurement-control-rf-power-parti.html)

## Timing and circuits

| Expression | Result |
|---|---|
| `period(100 MHz)`, `frequency(10 ns)` | 10 ns and 100 MHz |
| `wavelength(100 MHz, c)` | 2.998 m in vacuum |
| `wavelength(100 MHz, 200000000 metre/s)` | 2 m at the stated propagation speed |
| `corner(10 kΩ, 1 nF)` | 15.92 kHz for a single-pole RC |
| `divider(5 V, 1 kΩ, 2 kΩ)` | 3.333 V for the unloaded divider |

Frequency, period, propagation speed, resistances and capacitance must be positive throughout their input ranges. A wavelength requires the medium's speed, either explicit or bound. The constant `c` selects 299792458 m/s in vacuum. Smooth conversions enclose the full input intervals and carry the local sensitivities into the shared RSS calculation. [BIPM definition of the metre](https://www.bipm.org/en/si-base-units/metre)

# Measured routing from fixed placements

On six public development boards, the frozen model and Waffle v2 each closed **223 of 256 physical airwires**. Both completed three whole boards with zero new rule violations or shorts. The model used 103 vias and 1,772.02 mm of track. Shipped v2 used 105 vias and 1,806.13 mm. One fixed high-via-cost profile reached the same completion using only 100 vias and 1,774.43 mm. On an entirely new motor-board family the model selected that same fixed profile for both boards. The model uses 20 scoring coefficients and six normalisation values. It remains a manual experiment.

The two motor-board designs were reserved together after the development comparison. The fixed estimator, profile settings and fallback budgets were committed before evaluating that family. Three independent executions under Node 24.22.3 produced identical stripped inputs, decisions, accepted copper, open counts and search work. The final product pin is `cb5a05dc2c9ce59b3f774aec5d230fd7f521d2fb`. Its coordinate-aware via checks produced the same geometry, search counts, checks and choices as the earlier integrated sizing fix at `5f4660c`. Selected routes used through vias and no automatic fanout. Wall times are medians of three actual route calls per configuration. Energy consumption was unmeasured. All source inputs and output comparisons are reproducible offline. [Protocol and commands](README.md) · [Measurements and geometry hashes](results.json) · [Frozen coefficients](models.json)

## Whole-board results

Each method cell gives **remaining opens / vias / track mm / route ms**. The number of independently connected airwires is the initial demand minus remaining opens. These are accepted proposals after the common physical check. Shipped v2 includes its normal retry passes. The hand-designed margin profile and the learned selection each use one v2 pass.

| Board | Initial demand | Shipped v1 | Shipped v2 | Fixed margin | Learned choice |
|---|---:|---:|---:|---:|---:|
| TPL5110 timer | 23 | 0 / 10 / 103.72 / 29 | 0 / 10 / 103.86 / 35 | 0 / 12 / 107.75 / 26 | 0 / 9 / 106.70 / 24 |
| TMP117 sensor | 35 | 16 / 4 / 71.55 / 34 | 16 / 0 / 83.48 / 252 | 16 / 1 / 83.16 / 27 | 16 / 1 / 74.30 / 33 |
| Qwiic Button | 46 | 5 / 33 / 333.38 / 78 | 5 / 22 / 345.95 / 444 | 5 / 26 / 384.66 / 106 | 5 / 22 / 322.53 / 83 |
| Qwiic Buzzer | 62 | 12 / 39 / 404.79 / 107 | 12 / 31 / 393.01 / 674 | 12 / 33 / 435.53 / 127 | 12 / 29 / 400.93 / 156 |
| PiDP-11 I/O | 65 | 0 / 43 / 690.16 / 256 | 0 / 31 / 699.91 / 490 | 0 / 27 / 717.30 / 344 | 0 / 32 / 688.00 / 386 |
| MIDAS communication | 25 | 0 / 11 / 178.31 / 31 | 0 / 11 / 179.92 / 43 | 0 / 7 / 184.44 / 25 | 0 / 10 / 179.55 / 25 |
| TMC2209 driver¹ | 53 | 0 / 25 / 252.62 / 92 | 0 / 23 / 265.88 / 168 | 1 / 23 / 261.35 / 175 | 0 / 23 / 259.32 / 170 |
| StepStick Protector¹ | 23 | 7 / 1 / 74.62 / 29 | 7 / 1 / 75.31 / 47 | 7 / 1 / 74.92 / 26 | 7 / 1 / 74.78 / 42 |

¹ Independent Watterott family. Shipped v2 and the frozen learner both closed 69 of 76 connections, with 24 vias each. The selector uses three placement features and ranks five routing profiles on independent route outcomes. Development holds out both Adafruit projects together and both SparkFun projects together, plus separate PiDP-11 and MIDAS folds.

On the original engine, the frozen selector left **58 opens**, compared with 53 for shipped v2. On MIDAS, v2 claimed to connect all 25 airwires with 11 vias that failed the imported minimum annular ring. The independent check withheld the implicated nets. In the corrected engine, v2 connects 25/25 with 11 legal vias and the frozen selector does so with 10. The exact serialized placements, rules and model coefficients remained identical. The earlier measurements are retained alongside the corrected results. [Original and corrected comparisons](results.json)

## Authored references

These reference controls use the same Waffle connectivity and rule checks as the candidates. Track length excludes copper area in polygons. Area is summed across layers, so a four-layer board can have more filled area than its outline. Eagle stores polygon outlines, which Waffle fills for this control. The Altium controls use their stored poured regions. The generated routes use tracks and vias for every pad net, including supply and ground.

| Board | Original tracks / vias / polygons | Reference opens | Track mm | Filled mm² across layers | Nets with pours and no tracks |
|---|---:|---:|---:|---:|---|
| TPL5110 timer | 72 / 7 / 1 | 0 | 110.37 | 221.92 | None |
| TMP117 sensor | 113 / 10 / 2 | 1 | 183.47 | 500.11 | None |
| Qwiic Button | 193 / 38 / 2 | 0 | 294.07 | 730.13 | GND |
| Qwiic Buzzer | 343 / 61 / 2 | 0 | 456.92 | 554.40 | None |
| PiDP-11 I/O | 194 / 59 / 2 | 2 | 644.54 | 1864.89 | GND |
| MIDAS communication | 12 / 35 / 3 | 0 | 77.66 | 1885.80 | GND, NetJ1_2 |
| TMC2209 driver¹ | 181 / 57 / 15 | 0 | 187.93 | 835.78 | BRA, BRB, OA1, OA2, OB1, OB2 |
| StepStick Protector¹ | 48 / 7 / 2 | 0 | 82.93 | 349.49 | GND |

All eight materialisations contain zero routed board tracks, arcs, vias, copper fills, polygons and cached poured regions. Each part transform and pad net is verified before search, including bottom-side and rotated placements. Fixed solder-jumper bridges, mechanical holes and keepout geometry remain. The original PiDP-11 also contains one board-level copper graphic. The records give the source and stripped counts, fixed bridge count, bottom-side count, and filled area by layer. [Source and placement inventory](results.json)

The imported TMP117 reference has one physical open and PiDP-11 has two. Other authored controls report zero opens. Several references also produce checks from the imported design rules, including 35 minimum-ring violations on the MIDAS authored vias. Legacy Eagle layer mapping treats its three restrict-layer types as general keepouts. Coverage is limited to the imported geometry and supported rule types. The test measures connectivity and manufacturing-rule outcomes in Waffle.

## Bounded rescue

Both explicit rescue policies start from the same accepted single-pass v2 copper. Positive entries below reduced physical opens while adding zero new violations. Time covers suggestions and independent checks. The two policies share the same maximum calls, search cells per attempt and deterministic search-time budget. Each clock read costs 1/64 logical millisecond, so this bound is reproducible under machine load. Extra accepted offers can take longer to check and the report gives their actual wall times. They stop early if all opens are closed or the available directions have been explored.

| Board with initial opens | Before | Centre fallback opens | Edge fallback opens | Calls, centre / edge | Median ms, centre / edge |
|---|---:|---:|---:|---:|---:|
| TMP117 sensor | 16 | 16 | 16 | 12 / 12 | 23 / 18 |
| Qwiic Button | 5 | 5 | 0 | 10 / 5 | 23 / 70 |
| Qwiic Buzzer | 12 | 12 | 6 | 12 / 12 | 46 / 144 |
| StepStick Protector¹ | 7 | 1 | 1 | 8 / 8 | 32 / 23 |

Pad-edge access closed five additional connections on the Button and six on the Buzzer. All 16 TMP117 opens remained. On the previously unseen family, the driver was already complete. Both rescues closed six of seven remaining Protector opens. The independent family therefore showed a benefit from the bounded second pass and equal completion for its two access policies. Rescue remains an explicit experiment.


## Sources

The source and hardware-licence bytes are checked against their SHA-256 pins on every run. The checked-in files contain counts, model coefficients and measurements. The editable public designs remain in external caches.

- Limor Fried / Adafruit Industries, CC BY-SA 3.0. [TPL5110 timer](https://github.com/adafruit/Adafruit-TPL5110-Power-Timer-Breakout-PCB/tree/f1967694bc20333d31b167e4eeaff58742e37bba) · [TMP117 sensor](https://github.com/adafruit/Adafruit-TMP117-PCB/tree/874b3a5b27792d4d166547bab075cb963e1bdb32)
- SparkFun Electronics, CC BY-SA 4.0 for hardware. [Qwiic Button](https://github.com/sparkfun/Qwiic_Button/tree/e89a82fe2ddb293bfe0d6d9f63ccf4782a77c359) · [Qwiic Buzzer](https://github.com/sparkfun/SparkFun_Qwiic_Buzzer/tree/c6be60f1dea6db2bfb4b55cf7b543160fb68c8b6)
- Steven Stallion, BSD-2-Clause. [PiDP-11 I/O Expander Rev A](https://github.com/sstallion/PCB-PiDP11IOExpander/releases/tag/RevA)
- MIDAS Hand project, CERN-OHL-P-2.0. [Communication board](https://github.com/midas-hand-org/midas_hand_communication_board/tree/2ffc166dc3783158e0b00906e13b2d650d676887)
- Watterott electronic, CC BY-SA 4.0. [SilentStepStick motor driver and Protector](https://github.com/watterott/SilentStepStick/tree/098b7518b0de31e6a12fda78c68ae2666b81fbb6/hardware)

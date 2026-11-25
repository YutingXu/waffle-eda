import unittest
from copy import deepcopy

from run import regressions


class RegressionGate(unittest.TestCase):
    def setUp(self):
        self.report = {"protocol":{"pixelMm":.025}, "projects":{"fixture":{
            "revision":"public-revision", "imported":{"objects":10, "schematicKinds":{"part":4}},
            "reimported":{"objects":9}, "erc":{"byCheck":{}}, "drc":{"total":2, "byRule":{"clearance":2}},
            "gerbers":{"gerberXorMm2":.125, "measuredLayers":2, "layers":{
                "GTL":{"xorMm2":0, "outputLayer":"GTL", "referenceArcs":1},
                "GBL":{"xorMm2":.125, "registeredXorMm2":.075}, "GG1":{"xorMm2":None}},
                "generatedArcs":{"GTL":1}},
            "geometry":{"source":{"arcs":7}, "imported":{"itemArcs":{"Top":3}, "bodies":{"unresolvedReferences":1}},
                "formats":{"dxfArcs":3}},
            "roundTrip":{"kindDelta":{}, "kindCountDecreases":{}, "kindCountIncreases":{}}, "drill":None}}}

    def test_equal_better_or_new_reference(self):
        better = deepcopy(self.report)
        p = better["projects"]["fixture"]
        p["imported"]["objects"] += 1
        p["reimported"]["objects"] += 1
        p["drc"] = {"total":0, "byRule":{}}
        p["gerbers"]["layers"]["GBL"]["xorMm2"] = 0
        p["drill"] = {"missingHits":0}
        self.assertEqual(regressions(self.report, better), [])

    def test_fewer_round_trip_approximation_primitives_is_an_improvement(self):
        self.report["projects"]["fixture"]["reimported"]["objects"] = 40
        better = deepcopy(self.report)
        better["projects"]["fixture"]["reimported"]["objects"] = 10
        self.assertEqual(regressions(self.report, better), [])

    def test_source_outcomes_are_monotonic_per_kind_and_phase(self):
        stages = ("imported", "exported", "reimported")
        self.report["projects"]["fixture"]["translation"] = {
            phase:{"Track":{"kept":5, "approximated":3, "dropped":2}, "Via":{"kept":1, "approximated":0, "dropped":0}}
            for phase in stages
        }
        for phase in stages:
            def change(counts):
                updated = deepcopy(self.report)
                updated["projects"]["fixture"]["translation"][phase]["Track"] = counts
                return updated

            for counts in [(5,4,1), (6,2,2), (6,3,1), (6,4,4)]:
                with self.subTest(phase=phase, counts=counts):
                    updated = change(dict(zip(("kept","approximated","dropped"),counts)))
                    self.assertEqual(regressions(self.report,updated), [])
            for counts in [(4,4,2), (5,2,3), (5,3,1), (7,0,3)]:
                with self.subTest(phase=phase,counts=counts):
                    updated = change(dict(zip(("kept","approximated","dropped"),counts)))
                    # An unrelated kind may improve at the same time.
                    updated["projects"]["fixture"]["translation"][phase]["Via"]["kept"] += 2
                    self.assertTrue(regressions(self.report,updated))
            for broken in ({"kept":5,"approximated":3}, {"kept":True,"approximated":3,"dropped":2},
                           {"kept":5,"approximated":3,"dropped":-1}):
                self.assertTrue(regressions(self.report,change(broken)))
            absent = deepcopy(self.report)
            del absent["projects"]["fixture"]["translation"][phase]["Track"]
            self.assertTrue(regressions(self.report,absent))
            del absent["projects"]["fixture"]["translation"][phase]
            self.assertTrue(regressions(self.report,absent))

    def test_added_export_feature_and_its_reimport_are_allowed(self):
        old = self.report["projects"]["fixture"]
        old["translation"] = {p:{"Track":{"kept":8,"approximated":2,"dropped":0}}
                              for p in ("imported","exported","reimported")}
        improved = deepcopy(self.report)
        new = improved["projects"]["fixture"]["translation"]
        new["exported"]["Track"] = {"kept":10,"approximated":0,"dropped":0}
        new["reimported"]["Track"] = {"kept":11,"approximated":2,"dropped":0}
        for phase in ("exported","reimported"):
            new[phase]["Arc"] = {"kept":2,"approximated":0,"dropped":0}
        self.assertEqual(regressions(self.report,improved),[])

    def test_each_regression_independent_of_total(self):
        changes = [
            (("imported", "objects"), 9), (("imported", "schematicKinds"), {}),
            (("reimported", "objects"), 8), (("erc", "byCheck"), {"floatingInputs":1}),
            (("drc", "total"), 3), (("roundTrip", "kindDelta"), {"boardKinds.part":1}),
            (("roundTrip", "kindCountDecreases"), {"boardKinds.track":1}),
            (("roundTrip", "kindCountIncreases"), {"boardKinds.graphic":1}),
            (("gerbers", "layers", "GTL", "xorMm2"), .000625),
            (("gerbers", "layers", "GTL", "xorMm2"), None),
            (("gerbers", "layers", "GTL", "outputLayer"), "GBL"),
            (("gerbers", "layers", "GTL", "referenceArcs"), 2),
            (("gerbers", "layers", "GBL", "registeredXorMm2"), .076),
            (("gerbers", "measuredLayers"), 1),
            (("gerbers", "generatedArcs"), {}),
            (("geometry", "source", "arcs"), 6),
            (("geometry", "imported", "itemArcs", "Top"), 2),
            (("geometry", "imported", "bodies", "unresolvedReferences"), 2),
            (("geometry", "formats", "dxfArcs"), 2),
        ]
        for keys, new in changes:
            with self.subTest(keys=keys, new=new):
                worse = deepcopy(self.report)
                p = worse["projects"]["fixture"]
                for k in keys[:-1]:
                    p = p[k]
                p[keys[-1]] = new
                self.assertTrue(regressions(self.report, worse))

    def test_missing_fixture(self):
        worse = deepcopy(self.report)
        worse["projects"].clear()
        self.assertTrue(regressions(self.report, worse))

    def test_slot_count_transfer_requires_source_geometry_and_conserves_openings(self):
        before = self.report["projects"]["fixture"]
        before["drillUnavailable"] = "no shipped NC drill"
        before["outputs"] = {"drillHits":10, "drillSlots":0}
        after = deepcopy(self.report)
        result = after["projects"]["fixture"]
        result["outputs"] = {"drillHits":6, "drillSlots":4, "physicalDrillOpenings":10}
        result["drillSlotEvidence"] = {"sourcePadSlots":4, "matched":4, "unmatched":0, "slotsStillRound":0}
        self.assertEqual(regressions(self.report, after), [])
        for path, value in [
            (("outputs", "drillHits"), 5), (("outputs", "physicalDrillOpenings"), 9),
            (("drillSlotEvidence", "sourcePadSlots"), 3), (("drillSlotEvidence", "matched"), 3),
            (("drillSlotEvidence", "unmatched"), 1), (("drillSlotEvidence", "slotsStillRound"), 1),
        ]:
            with self.subTest(path=path):
                wrong = deepcopy(after)
                wrong["projects"]["fixture"][path[0]][path[1]] = value
                self.assertTrue(regressions(self.report, wrong))
        before["drill"] = {"missingHits":0}
        result["drill"] = {"missingHits":0}
        self.assertTrue(regressions(self.report, after), "published drill comparisons keep their round-hit gate")

    def test_published_page_mapping_preserves_all_comparable_checks(self):
        old = self.report["projects"]["fixture"]
        old["pdfs"] = {"prints.pdf":{"referencePages":2, "sections":{
            "composite":{"pageInkDifferencePct":{"1":4.0, "2":4.0}}}}}
        new = deepcopy(self.report)
        report = new["projects"]["fixture"]["pdfs"]["prints.pdf"]
        report["sourcePageViews"] = {"2":{"view":"Inner 1", "layers":["Inner 1"], "scale":1.0, "inkDifferencePct":0.1}}
        report["sections"]["composite"]["pageInkDifferencePct"]["2"] = 8.0
        before = {"fixture":{"prints.pdf":{"2":0.2}}}
        self.assertEqual(regressions(self.report, new, before), [])
        wrong = deepcopy(new)
        record = wrong["projects"]["fixture"]["pdfs"]["prints.pdf"]
        record["sourcePageViews"]["2"]["inkDifferencePct"] = 0.3
        self.assertTrue(regressions(self.report, wrong, before), "moving copper on the bound page fails")
        record["sourcePageViews"]["2"]["inkDifferencePct"] = 0.1
        record["sections"]["composite"]["pageInkDifferencePct"]["1"] = 5
        self.assertTrue(regressions(self.report, wrong, before), "the genuine composite comparison remains")
        record["sections"]["composite"]["pageInkDifferencePct"] = {"1":4.0}
        self.assertTrue(regressions(self.report, wrong, before), "historical surrogate figures stay visible")
        record["sections"]["composite"]["pageInkDifferencePct"]["2"] = 8.0
        del record["sourcePageViews"]["2"]
        self.assertTrue(regressions(self.report, wrong, before), "a bound page cannot disappear")

    def test_authored_silk_keeps_the_original_stock_check_and_other_rules(self):
        old = self.report["projects"]["fixture"]
        old["drc"] = {"total":5, "byRule":{"clearance":2, "silkToMask":3}}
        new = deepcopy(self.report)
        current = new["projects"]["fixture"]
        current["drc"] = {"total":12, "byRule":{"clearance":2, "silkToMask":10}}
        current["silkRuleComparison"] = {
            "sourceRules":1, "sourceLimits":[{"gapMm":.254, "surface":"exposed pad copper"}],
            "authored":10, "legacyStock":3, "exactStock":4, "projectedPads":2,
        }
        self.assertEqual(regressions(self.report, new), [])
        for rule in ("clearance", "silkToMask"):
            with self.subTest(rule=rule):
                wrong = deepcopy(new)
                wrong["projects"]["fixture"]["drc"]["byRule"][rule] += 1
                wrong["projects"]["fixture"]["drc"]["total"] += 1
                self.assertTrue(regressions(self.report, wrong))
        current["silkRuleComparison"]["legacyStock"] += 1
        self.assertTrue(regressions(self.report, new), "the historical stock comparison must still pass")
        current["silkRuleComparison"]["legacyStock"] -= 1
        newer = deepcopy(new)
        result = newer["projects"]["fixture"]
        result["silkRuleComparison"]["authored"] += 1
        result["drc"]["byRule"]["silkToMask"] += 1
        result["drc"]["total"] += 1
        self.assertTrue(regressions(new, newer), "a future authored-count regression cannot use migration")
        result["silkRuleComparison"]["authored"] -= 1
        result["drc"]["byRule"]["silkToMask"] -= 1
        result["drc"]["total"] -= 1
        result["silkRuleComparison"]["sourceLimits"][0]["gapMm"] = .1
        self.assertTrue(regressions(new, newer), "an authored limit cannot become the stock limit")


    def test_legend_text_is_checked_without_raising_the_line_budget(self):
        before = self.report["projects"]["fixture"]
        before["drc"] = {"total":5, "byRule":{"clearance":2, "silkToMask":3}}
        before["silkRuleComparison"] = {
            "sourceRules":1, "sourceLimits":[{"gapMm":.254, "surface":"exposed pad copper"}],
            "authored":3, "exactStock":4, "legacyStock":3, "projectedPads":2,
        }
        after = deepcopy(self.report)
        current = after["projects"]["fixture"]
        current["drc"] = {"total":8, "byRule":{"clearance":2, "silkToMask":6}}
        current["silkRuleComparison"].update({
            "authored":6, "exactStock":5, "legacyStock":4,
            "legendText":{"authored":3, "exactStock":1, "legacyStock":1}
        })
        self.assertEqual(regressions(self.report, after), [])
        self.assertEqual(regressions(after, after), [])
        changes = deepcopy(after)
        counts = changes["projects"]["fixture"]["silkRuleComparison"]["legendText"]
        counts["authored"] = 2
        self.assertTrue(regressions(self.report, changes), "six findings with only two text findings add a line finding")
        self.assertTrue(regressions(after, changes), "the pinned legend projection cannot lose coverage")
        counts["authored"] = 7
        self.assertTrue(regressions(self.report, changes), "attribution cannot exceed the total")


if __name__ == "__main__":
    unittest.main()

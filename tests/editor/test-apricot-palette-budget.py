import runpy
from pathlib import Path
import unittest


assess = runpy.run_path(Path(__file__).resolve().parents[2] / "scripts/apricot-palette-budget.py")["assess"]


class ApricotPaletteBudgetTest(unittest.TestCase):
    def test_equal_to_two_refreshes_and_eight_ms_passes(self):
        for rate in (60, 120):
            with self.subTest(rate=rate):
                limit = 2000 / rate
                result = assess([{"presentedMs": limit, "waffleWorkMs": 8}], rate)
                self.assertTrue(result["meetsBudget"])
                self.assertEqual(result["presentationP95Ms"], limit)
                self.assertEqual(result["presentationMaxMs"], limit)

    def test_maximum_exposes_an_outlier_hidden_at_p95(self):
        samples = [{"presentedMs": 13, "waffleWorkMs": 6}] * 19
        result = assess(samples + [{"presentedMs": 50, "waffleWorkMs": 6}], 60)
        self.assertEqual(result["presentationP95Ms"], 13)
        self.assertEqual(result["presentationMaxMs"], 50)
        self.assertEqual(result["overTwoRefreshes"], 1)
        self.assertEqual(result["overThreeRefreshes"], 0)
        self.assertFalse(result["meetsBudget"])
        result = assess(samples + [{"presentedMs": 50.001, "waffleWorkMs": 6}], 60)
        self.assertEqual(result["overThreeRefreshes"], 1)

    def test_missing_measurements_stay_open(self):
        result = assess([{"presentedMs": 10}, {"waffleWorkMs": 4}], 120)
        self.assertEqual(result["missingPresentation"], 1)
        self.assertEqual(result["missingWaffleWork"], 1)
        self.assertFalse(result["meetsBudget"])

    def test_every_input_includes_the_work_limit(self):
        result = assess([{"presentedMs": 16, "waffleWorkMs": 8.001}], 120)
        self.assertEqual(result["overTwoRefreshes"], 0)
        self.assertEqual(result["overWaffleWorkBudget"], 1)
        self.assertFalse(result["meetsBudget"])

    def test_invalid_values_are_rejected(self):
        with self.assertRaises(ValueError):
            assess([{"presentedMs": -1}], 60)
        with self.assertRaises(ValueError):
            assess([{"presentedMs": 16}], 0)
        with self.assertRaises(ValueError):
            assess([], 60)


if __name__ == "__main__":
    unittest.main()

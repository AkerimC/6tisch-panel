"""Regression checks for simulated TX power configuration."""
import unittest
from unittest.mock import patch

from backend import config as C
from backend.engine import Engine, NodeState


class TxPowerTests(unittest.TestCase):
    def setUp(self):
        self.engine = Engine()
        self.node = NodeState("7402", *C.NODES["7402"])
        self.engine.nodes[self.node.id] = self.node
        for name in ("insert_config", "insert_event"):
            patcher = patch("backend.engine.store." + name)
            setattr(self, name, patcher.start())
            self.addCleanup(patcher.stop)

    def test_power_delta_matches_coefficient(self):
        initial = self.node.rssi_seed
        self.engine.apply_config("7402", {"tx_power_dbm": 10})
        # 4 dB dusus * 0.8 seed-katsayisi
        self.assertAlmostEqual(self.node.rssi_seed, initial - 3.2)

    def test_same_power_with_other_params_writes_log_but_no_shift(self):
        params = {"tx_power_dbm": 14, "eb_period": 5}
        self.engine.apply_config("7402", params)
        first = self.node.rssi_seed
        result = self.engine.apply_config("7402", params)
        self.assertEqual(self.node.rssi_seed, first)
        self.assertNotIn("unchanged", result)  # tek-parametre olmadigi icin normal akis
        self.assertEqual(self.insert_config.call_count, 2)

    def test_repeating_power_does_not_accumulate_or_log(self):
        self.engine.apply_config("7402", {"tx_power_dbm": 10})
        first = self.node.rssi_seed
        result = self.engine.apply_config("7402", {"tx_power_dbm": 10})
        self.assertEqual(self.node.rssi_seed, first)
        self.assertTrue(result["unchanged"])
        self.assertEqual(self.insert_config.call_count, 1)
        self.assertEqual(self.insert_event.call_count, 1)

    def test_full_form_is_idempotent_and_power_can_be_restored(self):
        initial = self.node.rssi_seed
        params = {"tx_power_dbm": 10, "eb_period": 1,
                  "rssi_threshold": -85, "slot_update_s": 15}
        self.engine.apply_config("7402", params)
        first = self.node.rssi_seed
        self.engine.apply_config("7402", params)
        self.assertEqual(self.node.rssi_seed, first)
        self.engine.apply_config("7402", {"tx_power_dbm": 14})
        self.assertAlmostEqual(self.node.rssi_seed, initial)


if __name__ == "__main__":
    unittest.main()

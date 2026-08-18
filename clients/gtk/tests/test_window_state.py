import json
import tempfile
import unittest
from pathlib import Path

from clients.gtk.config import DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH
from clients.gtk.window_state import WindowState, WindowStateStore


class WindowStateStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.path = Path(self.temp_dir.name) / "nested" / "window-state.json"
        self.store = WindowStateStore(self.path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_missing_file_uses_defaults(self):
        self.assertEqual(self.store.load(), WindowState())

    def test_round_trip_creates_parent_and_preserves_state(self):
        state = WindowState(width=1040, height=720, maximized=True)

        self.assertTrue(self.store.save(state))
        self.assertEqual(self.store.load(), state)
        self.assertEqual(
            json.loads(self.path.read_text(encoding="utf-8")),
            {"height": 720, "maximized": True, "width": 1040},
        )

    def test_malformed_json_uses_defaults(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("{not json", encoding="utf-8")

        self.assertEqual(self.store.load(), WindowState())

    def test_invalid_fields_are_replaced_individually(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text(
            json.dumps({"width": True, "height": 10, "maximized": "yes"}),
            encoding="utf-8",
        )

        self.assertEqual(
            self.store.load(),
            WindowState(
                width=DEFAULT_WINDOW_WIDTH,
                height=DEFAULT_WINDOW_HEIGHT,
                maximized=False,
            ),
        )

    def test_save_failure_is_non_fatal(self):
        blocking_file = Path(self.temp_dir.name) / "not-a-directory"
        blocking_file.write_text("occupied", encoding="utf-8")
        store = WindowStateStore(blocking_file / "window-state.json")

        self.assertFalse(store.save(WindowState()))


if __name__ == "__main__":
    unittest.main()

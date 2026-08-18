import sys
import unittest
from pathlib import Path


GTK_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GTK_DIR))

from commands import COMMANDS, fuzzy_score, matching_commands, parse_command


class CommandTests(unittest.TestCase):
    def test_matching_prefers_exact_and_prefix(self):
        self.assertEqual(matching_commands("/status")[0]["name"], "status")
        self.assertEqual(matching_commands("/md")[0]["name"], "model")
        self.assertEqual(matching_commands("/models")[0]["name"], "models")
        self.assertEqual(matching_commands("/think")[0]["name"], "think")
        self.assertEqual(fuzzy_score("gateway", COMMANDS[0])[0], 4)

    def test_suggestions_only_cover_command_token(self):
        self.assertEqual(matching_commands("hello"), [])
        self.assertEqual(matching_commands("/model list"), [])

    def test_command_parser_preserves_quoted_arguments(self):
        parsed = parse_command('/task add "0 9 * * *" "Morning job" "do work"')
        self.assertEqual(
            parsed,
            ("task", ["add", "0 9 * * *", "Morning job", "do work"]),
        )

    def test_empty_and_invalid_commands(self):
        self.assertIsNone(parse_command("/"))
        with self.assertRaises(ValueError):
            parse_command('/task "unfinished')


if __name__ == "__main__":
    unittest.main()

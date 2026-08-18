import sys
import unittest
from pathlib import Path


GTK_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GTK_DIR))

from model_picker import fuzzy_model_score, matching_models


MODELS = [
    {"provider": "cerebras", "id": "zai-glm-4.7", "name": "GLM 4.7"},
    {"provider": "openai-codex", "id": "gpt-5.6-luna", "name": "GPT 5.6 Luna"},
    {"provider": "opencode-go", "id": "gpt-5.6-luna", "name": "GPT 5.6 Luna"},
    {"provider": "opencode-go", "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash"},
]


class ModelPickerTests(unittest.TestCase):
    def test_empty_query_preserves_gateway_order(self):
        self.assertEqual(matching_models("", MODELS), MODELS)

    def test_matches_provider_id_and_display_name(self):
        self.assertEqual(
            matching_models("cerebras", MODELS)[0]["id"],
            "zai-glm-4.7",
        )
        self.assertEqual(
            matching_models("deepseek flash", MODELS)[0]["id"],
            "deepseek-v4-flash",
        )

    def test_multiple_terms_can_match_different_fields(self):
        matches = matching_models("opencode luna", MODELS)
        self.assertTrue(matches)
        self.assertEqual(matches[0]["provider"], "opencode-go")

    def test_fuzzy_subsequence_matching(self):
        matches = matching_models("ocgluna", MODELS)
        self.assertTrue(matches)
        self.assertEqual(matches[0]["provider"], "opencode-go")
        self.assertIsNone(fuzzy_model_score("not-present", MODELS[0]))


if __name__ == "__main__":
    unittest.main()

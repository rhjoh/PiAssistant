import sys
import unittest
from pathlib import Path


GTK_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GTK_DIR))

from protocol import (
    content_text,
    content_thinking,
    is_heartbeat,
    is_pending_duplicate,
    model_name,
    prompt_payload,
)


class ProtocolTests(unittest.TestCase):
    def test_pending_duplicate_is_suppressed_until_acknowledged(self):
        pending = {"id": "turn-1", "text": "Test 123"}

        self.assertTrue(is_pending_duplicate(pending, "Test 123"))
        self.assertFalse(is_pending_duplicate(pending, "different"))
        self.assertFalse(is_pending_duplicate(None, "Test 123"))

    def test_prompt_payload_idle_has_no_streaming_behavior(self):
        msg = prompt_payload("hello", "turn-1")
        self.assertEqual(msg, {"type": "prompt", "message": "hello", "id": "turn-1"})

    def test_prompt_payload_busy_defaults_to_steer(self):
        msg = prompt_payload("redirect", "turn-2", processing=True)
        self.assertEqual(msg["streamingBehavior"], "steer")

    def test_prompt_payload_follow_up(self):
        msg = prompt_payload("summarize after", "turn-3", processing=True, behavior="followUp")
        self.assertEqual(msg["streamingBehavior"], "followUp")

    def test_content_text_keeps_prose_and_image_markers(self):
        self.assertEqual(
            content_text([
                {"type": "text", "text": "hello"},
                {"type": "thinking", "text": "hidden"},
                {"type": "image"},
                "!",
            ]),
            "hello[image]!",
        )

    def test_heartbeat_markers(self):
        self.assertTrue(is_heartbeat("  `[Heartbeat] check`  "))
        self.assertTrue(is_heartbeat("answer [[NO_ACTION]]"))
        self.assertFalse(is_heartbeat("normal response"))

    def test_content_thinking_extracts_persisted_reasoning(self):
        self.assertEqual(
            content_thinking([
                {"type": "thinking", "thinking": "first"},
                {"type": "text", "text": "answer"},
                {"type": "thinking", "thinking": " second"},
            ]),
            "first second",
        )

    def test_model_name_fallbacks(self):
        self.assertEqual(model_name({"name": "GPT"}), "GPT")
        self.assertEqual(model_name({"provider": "openai", "id": "gpt"}),
                         "openai/gpt")
        self.assertIsNone(model_name({}))


if __name__ == "__main__":
    unittest.main()

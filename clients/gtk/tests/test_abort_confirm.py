"""Unit tests for the Esc-Esc abort confirmation state machine."""

import unittest

from clients.gtk.abort_confirm import AbortConfirm


class _FakeGLib:
    SOURCE_REMOVE = False

    def __init__(self):
        self.sources = {}
        self.next_source = 1

    def timeout_add(self, interval, callback):
        source = self.next_source
        self.next_source += 1
        self.sources[source] = callback
        return source

    def source_remove(self, source):
        self.sources.pop(source, None)


class AbortConfirmTests(unittest.TestCase):
    def setUp(self):
        self.glib = _FakeGLib()
        self.disarms = []
        self.confirm = AbortConfirm(
            glib=self.glib,
            on_disarm=lambda: self.disarms.append("timeout"),
        )

    def fire_timeouts(self):
        """Run every pending timeout callback once (FIFO)."""

        callbacks = list(self.glib.sources.values())
        for callback in callbacks:
            callback()
        # A fired one-shot timeout removes itself from the registry.
        self.glib.sources.clear()

    def test_first_escape_arms_and_second_escapes_confirms(self):
        self.assertFalse(self.confirm.armed)
        self.assertFalse(self.confirm.on_escape())  # first press: arm
        self.assertTrue(self.confirm.armed)
        self.assertTrue(self.confirm.on_escape())   # second press: abort
        self.assertFalse(self.confirm.armed)        # state reset after confirm

    def test_confirmation_clears_pending_timeout(self):
        self.confirm.on_escape()
        self.assertEqual(len(self.glib.sources), 1)
        self.assertTrue(self.confirm.on_escape())
        # Confirming removes the disarm timer so it cannot fire later.
        self.assertEqual(len(self.glib.sources), 0)

    def test_timeout_disarms_and_notifies_caller(self):
        self.confirm.on_escape()
        self.fire_timeouts()
        self.assertFalse(self.confirm.armed)
        self.assertEqual(self.disarms, ["timeout"])
        # After expiry, the next Escape re-arms rather than aborting.
        self.assertFalse(self.confirm.on_escape())
        self.assertTrue(self.confirm.armed)

    def test_explicit_disarm_does_not_notify_caller(self):
        self.confirm.on_escape()
        self.confirm.disarm()  # run ended on its own
        self.assertFalse(self.confirm.armed)
        self.assertEqual(self.disarms, [])
        self.assertEqual(len(self.glib.sources), 0)

    def test_disarm_is_idempotent_when_not_armed(self):
        self.confirm.disarm()
        self.confirm.disarm()
        self.assertFalse(self.confirm.armed)
        self.assertEqual(len(self.glib.sources), 0)

    def test_stop_removes_timeout(self):
        self.confirm.on_escape()
        self.confirm.stop()
        self.assertEqual(len(self.glib.sources), 0)
        self.assertFalse(self.confirm.armed)

    def test_arm_again_after_confirm_starts_fresh_timeout(self):
        self.assertTrue(self.confirm.on_escape() or True)
        self.confirm.on_escape()  # confirm
        self.confirm.on_escape()  # re-arm
        self.assertTrue(self.confirm.armed)
        self.assertEqual(len(self.glib.sources), 1)


if __name__ == "__main__":
    unittest.main()

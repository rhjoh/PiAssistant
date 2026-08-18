import os
import tempfile
import unittest
from pathlib import Path

from clients.gtk.instance_lock import InstanceLock


class _ExitCalled(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class InstanceLockTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.path = Path(self.temp_dir.name) / "agent-gui.pid"
        self.proc_root = Path(self.temp_dir.name) / "proc"
        self.proc_root.mkdir()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_acquire_writes_pid_and_release_removes_file(self):
        lock = InstanceLock(self.path, pid=1234, proc_root=self.proc_root)

        self.assertTrue(lock.acquire())
        self.assertEqual(self.path.read_text(), "1234")

        lock.release()
        self.assertFalse(self.path.exists())

    def test_stale_pid_file_is_replaced(self):
        self.path.write_text("9999")
        lock = InstanceLock(self.path, pid=1234, proc_root=self.proc_root)

        lock.acquire()

        self.assertEqual(self.path.read_text(), "1234")

    def test_malformed_pid_file_is_replaced(self):
        self.path.write_text("not-a-pid")
        lock = InstanceLock(self.path, pid=1234, proc_root=self.proc_root)

        lock.acquire()

        self.assertEqual(self.path.read_text(), "1234")

    def test_live_pid_causes_clean_exit(self):
        self.path.write_text("5678")
        (self.proc_root / "5678").mkdir()
        exits = []

        def exit_func(code):
            exits.append(code)
            raise _ExitCalled(code)

        lock = InstanceLock(
            self.path,
            pid=1234,
            proc_root=self.proc_root,
            exit_func=exit_func,
        )

        with self.assertRaises(_ExitCalled) as raised:
            lock.acquire()

        self.assertEqual(raised.exception.code, 0)
        self.assertEqual(exits, [0])
        self.assertEqual(self.path.read_text(), "5678")

    def test_release_is_safe_when_file_is_missing(self):
        InstanceLock(self.path).release()


if __name__ == "__main__":
    unittest.main()


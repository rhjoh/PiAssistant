"""PID-file based single-instance locking for the GTK launcher."""

import os
import sys


class InstanceLock:
    """Claim and release the GTK client's runtime PID file.

    Acquisition intentionally follows the existing ``AgentGui`` semantics:

    * use ``O_CREAT | O_EXCL`` so two rapid launches cannot both win;
    * if an existing file names a live process under ``/proc``, terminate the
      new invocation with status 0;
    * malformed, unreadable, or stale files are removed and acquisition is
      retried.

    ``proc_root`` and ``exit_func`` are injectable for deterministic tests.
    """

    def __init__(
        self,
        path,
        *,
        pid=None,
        proc_root="/proc",
        exit_func=sys.exit,
    ):
        self.path = os.fspath(path)
        self.pid = os.getpid() if pid is None else int(pid)
        self.proc_root = os.fspath(proc_root)
        self._exit = exit_func
        self._owned = False

    def acquire(self):
        """Claim the PID file, returning ``True`` when successful.

        ``SystemExit(0)`` is raised by the default ``exit_func`` when another
        live instance owns the file, matching the previous direct
        ``sys.exit(0)`` behavior.
        """

        while True:
            try:
                fd = os.open(
                    self.path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                )
                try:
                    os.write(fd, str(self.pid).encode())
                finally:
                    os.close(fd)
                self._owned = True
                return True
            except FileExistsError:
                other = self._read_pid()
                if other and os.path.exists(os.path.join(self.proc_root, str(other))):
                    self._exit(0)

                # A stale file may disappear between the read and unlink.  In
                # that race, simply loop and let O_EXCL decide the winner.
                try:
                    os.unlink(self.path)
                except FileNotFoundError:
                    pass

    def _read_pid(self):
        try:
            with open(self.path) as pid_file:
                return int(pid_file.read().strip())
        except (OSError, ValueError):
            return None

    def release(self):
        """Remove the PID file, ignoring missing/already-removed files."""

        try:
            os.remove(self.path)
        except OSError:
            pass
        self._owned = False

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback):
        self.release()
        return False


# Alias retaining the terminology used by the window's old ``_pidfile`` code.
PidFileLock = InstanceLock


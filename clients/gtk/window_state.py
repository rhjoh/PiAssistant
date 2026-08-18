"""Persistent size and maximize state for the GTK client window.

Wayland deliberately does not expose global window coordinates to clients, so
position is kept by retaining the same compositor surface during live toggles.
This module handles the state GTK can reliably restore after a full process
restart: the normal (unmaximized) size and whether the window was maximized.
"""

from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import tempfile

try:
    from config import DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH
except ImportError:  # Package import used by the headless tests.
    from .config import DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_WIDTH


MIN_WIDTH = 320
MIN_HEIGHT = 240
MAX_DIMENSION = 32768


@dataclass(frozen=True)
class WindowState:
    width: int = DEFAULT_WINDOW_WIDTH
    height: int = DEFAULT_WINDOW_HEIGHT
    maximized: bool = False


class WindowStateStore:
    """Load and atomically save the GTK window's restorable state."""

    def __init__(self, path=None):
        if path is None:
            config_home = Path(
                os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")
            )
            path = config_home / "agent-gui" / "window-state.json"
        self.path = Path(path)

    def load(self):
        """Return saved state, or safe defaults for missing/invalid data."""
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            return WindowState()

        if not isinstance(data, dict):
            return WindowState()

        return WindowState(
            width=self._dimension(
                data.get("width"), MIN_WIDTH, DEFAULT_WINDOW_WIDTH
            ),
            height=self._dimension(
                data.get("height"), MIN_HEIGHT, DEFAULT_WINDOW_HEIGHT
            ),
            maximized=(
                data.get("maximized")
                if isinstance(data.get("maximized"), bool)
                else False
            ),
        )

    def save(self, state):
        """Atomically persist *state*; return ``False`` on filesystem errors."""
        normalized = WindowState(
            width=self._dimension(state.width, MIN_WIDTH, DEFAULT_WINDOW_WIDTH),
            height=self._dimension(
                state.height, MIN_HEIGHT, DEFAULT_WINDOW_HEIGHT
            ),
            maximized=(
                state.maximized if isinstance(state.maximized, bool) else False
            ),
        )

        temp_path = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                dir=self.path.parent,
            )
            temp_path = Path(temp_name)
            with os.fdopen(fd, "w", encoding="utf-8") as state_file:
                json.dump(asdict(normalized), state_file, sort_keys=True)
                state_file.write("\n")
                state_file.flush()
                os.fsync(state_file.fileno())
            os.replace(temp_path, self.path)
            return True
        except OSError:
            if temp_path is not None:
                try:
                    temp_path.unlink()
                except OSError:
                    pass
            return False

    @staticmethod
    def _dimension(value, minimum, default):
        if (
            isinstance(value, int)
            and not isinstance(value, bool)
            and minimum <= value <= MAX_DIMENSION
        ):
            return value
        return default

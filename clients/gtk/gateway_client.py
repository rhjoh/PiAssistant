"""Threaded WebSocket transport for the GTK gateway client.

The GTK client renders messages on GLib's main loop, while ``websockets``
needs an asyncio event loop.  ``GatewayClient`` owns the asyncio loop and
never imports GTK; callers provide a ``dispatch`` function (for example,
``lambda callback: GLib.idle_add(callback)``) to hand callbacks back to the
UI thread.

This reconnects automatically when the socket drops, unless ``reconnect``
is false (the unit tests use a one-shot connection).  Each successful
connect requests the complete history with ``limit=0``.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import threading
from typing import Any, Callable, Mapping

import websockets


logger = logging.getLogger(__name__)


Message = Mapping[str, Any]
Callback = Callable[..., Any]
Dispatch = Callable[[Callable[[], Any]], Any]
ConnectFactory = Callable[[str], Any]


def _direct_dispatch(callback: Callable[[], Any]) -> Any:
    """Invoke a callback immediately.

    The production GTK client injects a GLib dispatcher.  Direct dispatch is
    useful for small scripts and unit tests, and keeps this module standalone.
    """

    return callback()


class GatewayClient:
    """Own one asyncio WebSocket connection in a background thread.

    ``on_message`` and ``on_error`` are always scheduled through ``dispatch``
    (unless the default direct dispatcher is used).  A callback receives a
    parsed JSON object or an error string respectively.  ``on_connected`` is
    called once the socket is open, before the initial history request is sent.

    The public lifecycle is intentionally small:

    * :meth:`start` is idempotent and starts one connection attempt.
    * :meth:`send` is thread-safe and returns ``False`` when no socket is
      active (or shutdown has begun).
    * :meth:`close` is idempotent and non-blocking, suitable for a GTK
      ``destroy`` handler.
    """

    def __init__(
        self,
        uri: str,
        *,
        dispatch: Dispatch | None = None,
        on_message: Callback | None = None,
        on_error: Callback | None = None,
        on_connected: Callback | None = None,
        on_disconnected: Callback | None = None,
        connect_factory: ConnectFactory | None = None,
        reconnect: bool = True,
        reconnect_min_delay: float = 1.0,
        reconnect_max_delay: float = 15.0,
    ) -> None:
        self.uri = uri
        self._dispatch = dispatch or _direct_dispatch
        self._on_message = on_message
        self._on_error = on_error
        self._on_connected = on_connected
        self._on_disconnected = on_disconnected
        self._reconnect = reconnect
        self._reconnect_min_delay = reconnect_min_delay
        self._reconnect_max_delay = reconnect_max_delay
        # The client requests the complete session history (limit=0), which
        # can far exceed websockets' 1 MiB default max_size (the gateway
        # responds with one large `history` frame).  Disable the receive
        # limit; the payload is bounded by the local session file, and a
        # finite cap would only reproduce this failure as the session grows.
        self._connect_factory = connect_factory or functools.partial(
            websockets.connect, max_size=None
        )

        self._lock = threading.RLock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ws: Any | None = None
        self._send_lock: asyncio.Lock | None = None
        self._task: asyncio.Task[Any] | None = None
        self._thread: threading.Thread | None = None
        self._closed = False
        self._started = False
        self._stopping = threading.Event()
        self._closed_event = threading.Event()

    # ------------------------------------------------------------------
    # Public lifecycle
    # ------------------------------------------------------------------

    def start(self) -> bool:
        """Start the connection thread.

        Returns ``True`` when a new thread was started and ``False`` for
        repeated calls or calls after :meth:`close`.  When ``reconnect`` is
        true the thread keeps retrying until :meth:`close`.
        """

        with self._lock:
            if self._started or self._closed:
                return False
            self._started = True
            self._stopping.clear()
            self._closed_event.clear()
            self._thread = threading.Thread(
                target=self._thread_main,
                name="gtk-gateway-client",
                daemon=True,
            )
            self._thread.start()
            logger.info("transport thread started uri=%s", self.uri)
            return True

    def send(self, message: Message) -> bool:
        """Queue a JSON message on the active WebSocket.

        This method may be called from the GTK main thread.  The actual send
        runs on the transport's asyncio loop.  The socket is captured while
        holding the state lock, so a later reconnect/close cannot cause a
        coroutine to dereference a mutable ``self._ws`` value.
        """

        if not isinstance(message, Mapping):
            raise TypeError("gateway messages must be mapping objects")

        with self._lock:
            loop = self._loop
            ws = self._ws
            send_lock = self._send_lock
            if (
                self._closed
                or self._stopping.is_set()
                or loop is None
                or ws is None
                or send_lock is None
                or not loop.is_running()
            ):
                return False

            try:
                future = asyncio.run_coroutine_threadsafe(
                    self._send_on_socket(ws, send_lock, dict(message)),
                    loop,
                )
            except (RuntimeError, OSError):
                # The loop may have closed between the state check and
                # run_coroutine_threadsafe().  Do not leak an unawaited
                # coroutine or make the GTK caller handle that race.
                return False

        # _send_on_socket handles failures and reports them through the
        # callback.  Consume an unexpected future exception so asyncio never
        # emits "Future exception was never retrieved" during shutdown.
        future.add_done_callback(self._consume_send_future)
        return True

    def close(self) -> None:
        """Begin asynchronous shutdown without blocking the GTK main loop."""

        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._stopping.set()
            loop = self._loop
            ws = self._ws
            task = self._task

        if loop is None or not loop.is_running():
            # The thread can be between Thread.start() and creation of its
            # asyncio loop.  Leave the event unset in that window; _run()
            # observes _stopping before opening a socket and will signal the
            # actual completion from _thread_main().
            with self._lock:
                thread_alive = bool(self._thread and self._thread.is_alive())
            if not thread_alive:
                self._closed_event.set()
            return

        # Closing the socket wakes an async-for receive loop.  Cancelling the
        # top-level task also unblocks a connection attempt that has not yet
        # produced a socket.  Both operations are scheduled thread-safely.
        if ws is not None:
            try:
                close_future = asyncio.run_coroutine_threadsafe(ws.close(), loop)
                close_future.add_done_callback(self._consume_send_future)
            except (RuntimeError, OSError):
                pass
        if task is not None:
            try:
                loop.call_soon_threadsafe(task.cancel)
            except (RuntimeError, OSError):
                pass

    def wait_closed(self, timeout: float | None = None) -> bool:
        """Wait for the background thread to finish (primarily for tests)."""

        return self._closed_event.wait(timeout)

    @property
    def is_running(self) -> bool:
        """Whether the transport thread is currently alive."""

        with self._lock:
            return bool(self._thread and self._thread.is_alive())

    # ------------------------------------------------------------------
    # Async/thread internals
    # ------------------------------------------------------------------

    def _thread_main(self) -> None:
        try:
            asyncio.run(self._run())
        except asyncio.CancelledError:
            # Intentional close cancels the top-level task to unblock a
            # connection attempt.  It is not a transport error.
            pass
        except Exception as exc:
            if not self._stopping.is_set():
                self._notify_error(str(exc))
        finally:
            with self._lock:
                self._loop = None
                self._ws = None
                self._send_lock = None
                self._task = None
            self._closed_event.set()

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        task = asyncio.current_task()
        with self._lock:
            self._loop = loop
            self._task = task
            self._send_lock = asyncio.Lock()

        delay = self._reconnect_min_delay
        while not self._stopping.is_set():
            try:
                await self._connect_once()
                delay = self._reconnect_min_delay
            except asyncio.CancelledError:
                if not self._stopping.is_set():
                    self._notify_error("connection cancelled")
                raise
            except Exception as exc:
                if self._stopping.is_set():
                    return
                self._notify_disconnected(str(exc))
                if not self._reconnect:
                    self._notify_error(str(exc))
                    return
            if self._stopping.is_set() or not self._reconnect:
                return
            await asyncio.sleep(delay)
            delay = min(delay * 2, self._reconnect_max_delay)

    async def _connect_once(self) -> None:
        async with self._connect_factory(self.uri) as ws:
            with self._lock:
                if self._stopping.is_set():
                    return
                self._ws = ws

            self._notify_connected()
            logger.info("websocket connected uri=%s", self.uri)

            # A zero limit explicitly requests all history.  This is the
            # gateway's documented convention (non-positive limits return
            # the complete session).
            await self._send_on_socket(
                ws,
                self._send_lock,
                {"type": "get_history", "limit": 0},
                raise_on_error=True,
            )

            async for raw in ws:
                if self._stopping.is_set():
                    break
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    # Match the existing GTK client: malformed frames are
                    # ignored rather than surfaced as user-facing errors.
                    continue
                if isinstance(message, dict):
                    self._notify_message(message)

        with self._lock:
            self._ws = None
        logger.info("websocket closed uri=%s", self.uri)
        if not self._stopping.is_set():
            self._notify_disconnected("connection closed")

    async def _send_on_socket(
        self,
        ws: Any,
        send_lock: asyncio.Lock | None,
        message: Message,
        *,
        raise_on_error: bool = False,
    ) -> None:
        """Serialize and send one message, preserving history-first order."""

        try:
            payload = json.dumps(dict(message))
            if send_lock is None:
                return
            async with send_lock:
                if self._stopping.is_set():
                    return
                await ws.send(payload)
        except asyncio.CancelledError:
            # A close can cancel queued sends.  They are intentionally not
            # reported as errors.
            if not self._stopping.is_set():
                raise
        except Exception as exc:
            if raise_on_error:
                raise
            if not self._stopping.is_set():
                self._notify_error(f"send failed: {exc}")

    def _notify_connected(self) -> None:
        if self._on_connected is not None:
            self._schedule(self._on_connected)

    def _notify_message(self, message: dict[str, Any]) -> None:
        if self._on_message is not None:
            self._schedule(self._on_message, message)

    def _notify_error(self, error: str) -> None:
        if self._on_error is not None and not self._stopping.is_set():
            self._schedule(self._on_error, error)

    def _notify_disconnected(self, reason: str) -> None:
        if self._on_disconnected is not None and not self._stopping.is_set():
            self._schedule(self._on_disconnected, reason)

    def _schedule(self, callback: Callback, *args: Any) -> None:
        """Dispatch a callback and make queued callbacks shutdown-safe."""

        def invoke() -> bool:
            if self._stopping.is_set():
                return False
            callback(*args)
            # GLib idle callbacks are one-shot unless they return True.
            return False

        self._dispatch(invoke)

    @staticmethod
    def _consume_send_future(future: Any) -> None:
        try:
            future.result()
        except (asyncio.CancelledError, RuntimeError, OSError):
            pass
        except Exception:
            # _send_on_socket reports normal errors through on_error.  This is
            # only a final guard for unexpected implementation/fake failures.
            pass

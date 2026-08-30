"""Unit tests for the GTK gateway transport.

These tests intentionally use only stdlib fakes.  No GTK display and no live
gateway are required.
"""

from __future__ import annotations

import asyncio
import json
import queue
import sys
import threading
import time
import unittest
from pathlib import Path


GTK_DIR = Path(__file__).resolve().parents[1]
if str(GTK_DIR) not in sys.path:
    sys.path.insert(0, str(GTK_DIR))

from gateway_client import GatewayClient  # noqa: E402


_END = object()


class FakeWebSocket:
    """Thread-safe fake implementing the async WebSocket surface we use."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self._sent_lock = threading.Lock()
        self.sent_event = threading.Event()
        self.frames: queue.Queue[object] = queue.Queue()
        self.closed = threading.Event()

    async def send(self, payload: str) -> None:
        # Yield once so tests exercise the event-loop scheduling path.
        await asyncio.sleep(0)
        with self._sent_lock:
            self.sent.append(payload)
        self.sent_event.set()

    def __aiter__(self):
        return self

    async def __anext__(self):
        frame = await asyncio.to_thread(self.frames.get)
        if frame is _END:
            raise StopAsyncIteration
        return frame

    async def close(self) -> None:
        if not self.closed.is_set():
            self.closed.set()
            self.frames.put(_END)

    def feed(self, frame: object) -> None:
        self.frames.put(frame)

    def sent_snapshot(self) -> list[str]:
        with self._sent_lock:
            return list(self.sent)


class FakeConnect:
    def __init__(self, websocket: FakeWebSocket) -> None:
        self.websocket = websocket

    async def __aenter__(self) -> FakeWebSocket:
        await asyncio.sleep(0)
        return self.websocket

    async def __aexit__(self, _exc_type, _exc, _tb) -> bool:
        await self.websocket.close()
        return False


class FailingSendWebSocket(FakeWebSocket):
    async def send(self, payload: str) -> None:
        raise OSError("socket closed")


class FailingConnect:
    def __init__(self, message: str = "gateway unavailable") -> None:
        self.message = message

    async def __aenter__(self):
        raise RuntimeError(self.message)

    async def __aexit__(self, _exc_type, _exc, _tb) -> bool:
        return False


def wait_for(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.005)
    raise AssertionError("timed out waiting for condition")


class GatewayClientTests(unittest.TestCase):
    def make_client(self, websocket: FakeWebSocket, **callbacks):
        uris: list[str] = []

        def connect_factory(uri: str):
            uris.append(uri)
            return FakeConnect(websocket)

        client = GatewayClient(
            "ws://test.invalid/",
            connect_factory=connect_factory,
            dispatch=lambda callback: callback(),
            reconnect=False,
            **callbacks,
        )
        return client, uris

    def start_connected(self, client: GatewayClient, websocket: FakeWebSocket) -> None:
        self.assertTrue(client.start())
        wait_for(lambda: len(websocket.sent_snapshot()) >= 1)
        self.assertEqual(
            json.loads(websocket.sent_snapshot()[0]),
            {"type": "get_history", "limit": 0},
        )

    def tearDown(self) -> None:
        # Tests close each client explicitly; this is a safety net for a
        # failed assertion before the local variable reaches cleanup.
        for client in getattr(self, "_clients", []):
            client.close()
            client.wait_closed(1)

    def track(self, client: GatewayClient) -> GatewayClient:
        if not hasattr(self, "_clients"):
            self._clients = []
        self._clients.append(client)
        return client

    def test_start_requests_complete_history_and_delivers_messages(self):
        websocket = FakeWebSocket()
        connected = threading.Event()
        messages: list[dict] = []
        client, uris = self.make_client(
            websocket,
            on_connected=lambda: connected.set(),
            on_message=messages.append,
        )
        self.track(client)

        self.start_connected(client, websocket)
        self.assertTrue(connected.wait(1))
        self.assertEqual(uris, ["ws://test.invalid/"])

        websocket.feed(json.dumps({"type": "connection", "data": {"connected": True}}))
        wait_for(lambda: len(messages) == 1)
        self.assertEqual(messages[0]["type"], "connection")

    def test_malformed_json_and_non_object_frames_are_ignored(self):
        websocket = FakeWebSocket()
        messages: list[dict] = []
        client, _ = self.make_client(websocket, on_message=messages.append)
        self.track(client)
        self.start_connected(client, websocket)

        websocket.feed("not-json")
        websocket.feed("42")
        websocket.feed(json.dumps({"type": "pong", "data": {"timestamp": 1}}))
        wait_for(lambda: len(messages) == 1)
        self.assertEqual(messages[0]["type"], "pong")

    def test_send_is_thread_safe_and_preserves_history_first(self):
        websocket = FakeWebSocket()
        client, _ = self.make_client(websocket)
        self.track(client)
        self.start_connected(client, websocket)

        self.assertTrue(client.send({"type": "prompt", "message": "hello", "id": "turn-1"}))
        wait_for(lambda: len(websocket.sent_snapshot()) >= 2)
        sent = [json.loads(item) for item in websocket.sent_snapshot()]
        self.assertEqual(sent[0], {"type": "get_history", "limit": 0})
        self.assertEqual(sent[1], {"type": "prompt", "message": "hello", "id": "turn-1"})

    def test_send_returns_false_when_disconnected(self):
        websocket = FakeWebSocket()
        client, _ = self.make_client(websocket)
        self.track(client)
        self.assertFalse(client.send({"type": "ping"}))

    def test_connection_error_is_reported_once_without_reconnect(self):
        errors: list[str] = []
        attempts: list[str] = []

        def connect_factory(uri: str):
            attempts.append(uri)
            return FailingConnect()

        client = self.track(
            GatewayClient(
                "ws://test.invalid/",
                connect_factory=connect_factory,
                dispatch=lambda callback: callback(),
                on_error=errors.append,
                reconnect=False,
            )
        )
        self.assertTrue(client.start())
        self.assertTrue(client.wait_closed(1))
        self.assertEqual(attempts, ["ws://test.invalid/"])
        self.assertEqual(errors, ["gateway unavailable"])
        self.assertFalse(client.start())

    def test_reconnects_after_the_first_connection_failure(self):
        websocket = FakeWebSocket()
        attempts: list[str] = []
        connected = threading.Event()

        def connect_factory(uri: str):
            attempts.append(uri)
            if len(attempts) == 1:
                return FailingConnect()
            return FakeConnect(websocket)

        client = self.track(
            GatewayClient(
                "ws://test.invalid/",
                connect_factory=connect_factory,
                dispatch=lambda callback: callback(),
                on_connected=lambda: connected.set(),
                reconnect=True,
                reconnect_min_delay=0.01,
                reconnect_max_delay=0.01,
            )
        )
        self.assertTrue(client.start())
        self.assertTrue(connected.wait(2))
        wait_for(lambda: len(websocket.sent_snapshot()) >= 1)
        self.assertGreaterEqual(len(attempts), 2)
        client.close()
        self.assertTrue(client.wait_closed(1))

    def test_initial_history_send_failure_reports_error_and_stops(self):
        websocket = FailingSendWebSocket()
        errors: list[str] = []
        client, _ = self.make_client(websocket, on_error=errors.append)
        self.track(client)

        self.assertTrue(client.start())
        self.assertTrue(client.wait_closed(1))
        self.assertEqual(errors, ["socket closed"])
        self.assertFalse(client.is_running)

    def test_close_is_idempotent_and_suppresses_shutdown_errors(self):
        websocket = FakeWebSocket()
        errors: list[str] = []
        client, _ = self.make_client(websocket, on_error=errors.append)
        self.track(client)
        self.start_connected(client, websocket)

        client.close()
        client.close()
        self.assertTrue(client.wait_closed(1))
        self.assertTrue(websocket.closed.wait(1))
        self.assertEqual(errors, [])
        self.assertFalse(client.send({"type": "ping"}))

    def test_close_before_event_loop_setup_does_not_leave_thread_running(self):
        websocket = FakeWebSocket()
        client, _ = self.make_client(websocket)
        self.track(client)
        self.assertTrue(client.start())
        client.close()
        self.assertTrue(client.wait_closed(1))
        self.assertFalse(client.is_running)

    def test_queued_callbacks_are_dropped_after_close(self):
        websocket = FakeWebSocket()
        pending: list[callable] = []
        connected = threading.Event()

        client, _ = self.make_client(
            websocket,
            on_connected=lambda: connected.set(),
        )
        # Replace the direct dispatcher installed by make_client with a
        # queued dispatcher to model GLib.idle_add without requiring GTK.
        client._dispatch = pending.append
        self.track(client)
        self.assertTrue(client.start())
        wait_for(lambda: bool(pending))
        client.close()
        self.assertTrue(client.wait_closed(1))
        for callback in pending:
            callback()
        self.assertFalse(connected.is_set())


if __name__ == "__main__":
    unittest.main()

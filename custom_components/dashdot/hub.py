"""Talks to a dashdot server and fans the data out to sensors and cards.

Home Assistant polls dashdot's REST API server-side, so browsers only ever
talk to Home Assistant (authenticated) and never to dashdot itself.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import deque
from collections.abc import Callable
from typing import Any

import aiohttp
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import STATIC_REFRESH_INTERVAL

_LOGGER = logging.getLogger(__name__)

REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=10)

# Retry a failed periodic config/info refresh after this many seconds
STATIC_RETRY_INTERVAL = 60

# Widgets with a time series graph, and the dashdot config key that holds
# how many datapoints the original UI keeps for them.
SERIES_WIDGETS = {
    "cpu": "cpu_shown_datapoints",
    "ram": "ram_shown_datapoints",
    "gpu": "gpu_shown_datapoints",
    "network": "network_shown_datapoints",
}


class DashdotError(Exception):
    """Raised when dashdot cannot be reached or answers unexpectedly."""


async def async_fetch_json(
    session: aiohttp.ClientSession, base_url: str, path: str, verify_ssl: bool
) -> Any:
    """GET a JSON document from dashdot."""
    url = f"{base_url.rstrip('/')}/{path}"
    try:
        async with session.get(
            url, timeout=REQUEST_TIMEOUT, ssl=None if verify_ssl else False
        ) as resp:
            if resp.status != 200:
                raise DashdotError(f"{url} returned HTTP {resp.status}")
            # dashdot's /load endpoints don't always send a JSON content type
            return await resp.json(content_type=None)
    except (TimeoutError, aiohttp.ClientError, ValueError) as err:
        raise DashdotError(f"Error fetching {url}: {err}") from err


class DashdotHub:
    """Polls one dashdot instance.

    Each /load endpoint is polled every `live_interval` while an open card
    shows it, and every `sensor_interval` otherwise, so a card with only a
    RAM graph doesn't make Home Assistant poll CPU and GPU every second.
    """

    def __init__(
        self,
        hass: HomeAssistant,
        base_url: str,
        verify_ssl: bool,
        live_interval: float,
        sensor_interval: float,
    ) -> None:
        self.hass = hass
        self.base_url = base_url.rstrip("/")
        self.verify_ssl = verify_ssl
        self.live_interval = live_interval
        self.sensor_interval = sensor_interval
        self._session = async_get_clientsession(hass, verify_ssl=verify_ssl)

        self.config: dict[str, Any] = {}
        self.info: dict[str, Any] = {}
        self.boot_time: float | None = None
        self.history: dict[str, deque] = {}
        self.latest: dict[str, Any] = {}
        self.storage: list[float] | None = None
        self.available = False
        # /load endpoints that failed on the last poll
        self.failed: set[str] = set()

        # Called when dashdot's widgets or hardware change in a way that
        # changes which sensors should exist
        self.on_layout_change: CALLBACK_TYPE | None = None

        # listener -> widgets it shows (None = all of them)
        self._subscribers: dict[
            Callable[[dict[str, Any]], None], frozenset[str] | None
        ] = {}
        self._sensor_listeners: set[CALLBACK_TYPE] = set()
        self._task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._layout: tuple | None = None
        self._next_static = 0.0
        self._last_fetch: dict[str, float] = {}
        self._last_sensor_write = 0.0

    @property
    def widgets(self) -> list[str]:
        """Widgets enabled in dashdot (DASHDOT_WIDGET_LIST)."""
        return self.config.get("widget_list", [])

    @property
    def live_widgets(self) -> set[str]:
        """Series widgets an open card is showing, these get the fast rate."""
        wanted: set[str] = set()
        for widgets in self._subscribers.values():
            wanted |= set(SERIES_WIDGETS) if widgets is None else widgets
        return wanted & set(SERIES_WIDGETS) & set(self.widgets)

    def widget_ok(self, widget: str) -> bool:
        """Whether the last fetch of this widget's data worked."""
        return self.available and widget not in self.failed

    def _layout_key(self) -> tuple:
        """Everything that decides which sensor entities exist."""
        return (
            tuple(sorted(self.widgets)),
            bool(self.config.get("enable_cpu_temps")),
            len((self.info.get("gpu") or {}).get("layout") or []),
            len(self.info.get("storage") or []),
        )

    async def _get(self, path: str) -> Any:
        return await async_fetch_json(
            self._session, self.base_url, path, self.verify_ssl
        )

    async def async_refresh_static(self) -> None:
        """Fetch config and hardware info. Raises DashdotError on failure."""
        config, info = await asyncio.gather(self._get("config"), self._get("info"))
        self.config = config.get("config", {})
        self.info = info
        uptime = (info.get("os") or {}).get("uptime")
        self.boot_time = time.time() - uptime if uptime else None
        self._next_static = time.monotonic() + STATIC_REFRESH_INTERVAL

        for widget, key in SERIES_WIDGETS.items():
            size = int(self.config.get(key) or 20)
            old = self.history.get(widget)
            if old is None or old.maxlen != size:
                self.history[widget] = deque(old or (), maxlen=size)

        layout = self._layout_key()
        if self._layout is not None and layout != self._layout:
            _LOGGER.info(
                "dashdot's widgets or hardware changed, reloading to update sensors"
            )
            if self.on_layout_change:
                self.on_layout_change()
        self._layout = layout

    async def async_start(self) -> None:
        """Do the first fetch and start polling."""
        await self.async_refresh_static()
        await self._async_poll()
        self._task = self.hass.async_create_background_task(
            self._async_run(), name=f"dashdot poll {self.base_url}"
        )

    @callback
    def async_stop(self) -> None:
        """Stop polling and tell open cards to resubscribe."""
        if self._task:
            self._task.cancel()
            self._task = None
        self._broadcast({"reload": True})
        self._subscribers.clear()
        self._wake.set()

    async def _async_run(self) -> None:
        while True:
            self._wake.clear()
            started = time.monotonic()
            try:
                await self._async_poll()
            except Exception:
                _LOGGER.exception("Unexpected error polling dashdot")
            interval = self.live_interval if self.live_widgets else self.sensor_interval
            delay = max(0.0, interval - (time.monotonic() - started))
            # A card subscribing sets _wake, so it gets data right away
            with contextlib.suppress(TimeoutError):
                async with asyncio.timeout(delay):
                    await self._wake.wait()

    async def _async_poll(self) -> None:
        now = time.monotonic()
        update: dict[str, Any] = {}
        was_available = self.available
        had_data = bool(self.latest)

        if now >= self._next_static:
            try:
                await self.async_refresh_static()
                update["static"] = self.static_payload()
            except DashdotError as err:
                # keep the old info, it rarely changes
                _LOGGER.debug("Refreshing dashdot config/info failed: %s", err)
                self._next_static = now + STATIC_RETRY_INTERVAL

        live = self.live_widgets
        storage_interval = (self.config.get("storage_poll_interval") or 60000) / 1000

        def due(path: str, interval: float) -> bool:
            # small slack so jitter doesn't push a fetch a whole tick later
            return now - self._last_fetch.get(path, -1e9) >= interval - 0.5

        paths = [
            w
            for w in SERIES_WIDGETS
            if w in self.widgets and (w in live or due(w, self.sensor_interval))
        ]
        if "storage" in self.widgets and (
            self.storage is None or due("storage", storage_interval)
        ):
            paths.append("storage")

        # Each endpoint on its own, so one failing doesn't take the rest down
        results = await asyncio.gather(
            *(self._get(f"load/{p}") for p in paths), return_exceptions=True
        )

        samples: dict[str, Any] = {}
        # endpoints not fetched this time keep their previous state
        failed = self.failed - set(paths)
        for path, value in zip(paths, results, strict=True):
            self._last_fetch[path] = now
            if isinstance(value, Exception):
                failed.add(path)
                if path not in self.failed:
                    _LOGGER.debug("dashdot load/%s failed: %s", path, value)
                continue
            if path == "storage":
                self.storage = value
                update["storage"] = value
                continue
            if path == "ram" and isinstance(value, dict):
                value = value.get("load")
            # dashdot answers with an empty body until its first measurement
            if value is None:
                continue
            self.latest[path] = value
            # graphs only get the fast samples, slow idle polls would
            # squash minutes into a graph that is meant to cover seconds
            if path in live:
                self.history[path].append(value)
                samples[path] = value

        failed_changed = failed != self.failed
        self.failed = failed
        # only "lost" when every endpoint is failing, not just one of them
        endpoints = set(self._last_fetch)
        self.available = not endpoints or bool(endpoints - failed)

        if was_available and not self.available:
            _LOGGER.warning("Lost connection to dashdot at %s", self.base_url)
        elif not was_available and self.available and had_data:
            _LOGGER.info("Reconnected to dashdot at %s", self.base_url)
        if self.available != was_available:
            update["available"] = self.available

        if samples:
            update["samples"] = samples
        self._broadcast(update)

        # sensors write at sensor_interval, or right away when availability flips
        if (
            self.available != was_available
            or failed_changed
            or now - self._last_sensor_write >= self.sensor_interval - 0.5
        ):
            self._last_sensor_write = now
            self._notify_sensors()

    # ---- Card subscriptions -------------------------------------------------

    def static_payload(self) -> dict[str, Any]:
        """Data that rarely changes."""
        return {
            "config": self.config,
            "info": self.info,
            "boot_time": self.boot_time,
        }

    def snapshot(self, widgets: frozenset[str] | None = None) -> dict[str, Any]:
        """Everything a freshly opened card needs to draw itself."""
        return {
            "static": self.static_payload(),
            "available": self.available,
            "history": {
                k: list(v)
                for k, v in self.history.items()
                if widgets is None or k in widgets
            },
            "storage": self.storage
            if widgets is None or "storage" in widgets
            else None,
            "live_interval": self.live_interval,
        }

    @callback
    def subscribe(
        self,
        listener: Callable[[dict[str, Any]], None],
        widgets: frozenset[str] | None = None,
    ) -> CALLBACK_TYPE:
        """Receive live updates for `widgets` (None = all).

        Returns an unsubscribe callback.
        """
        before = self.live_widgets
        self._subscribers[listener] = widgets
        started = self.live_widgets - before
        if started:
            # These were polled slowly until now, so their history is stale
            # or from an earlier session. Start fresh and poll right away.
            for widget in started:
                self.history[widget].clear()
            self._wake.set()

        @callback
        def unsubscribe() -> None:
            self._subscribers.pop(listener, None)

        return unsubscribe

    def _broadcast(self, update: dict[str, Any]) -> None:
        if not update:
            return
        for listener, widgets in list(self._subscribers.items()):
            if widgets is None:
                listener(update)
                continue
            # only send a card the data it shows
            filtered = {
                k: v for k, v in update.items() if k not in ("samples", "storage")
            }
            samples = {
                k: v for k, v in update.get("samples", {}).items() if k in widgets
            }
            if samples:
                filtered["samples"] = samples
            if "storage" in update and "storage" in widgets:
                filtered["storage"] = update["storage"]
            if filtered:
                listener(filtered)

    # ---- Sensor entities ----------------------------------------------------

    @callback
    def add_sensor_listener(self, listener: CALLBACK_TYPE) -> CALLBACK_TYPE:
        """Called every sensor_interval (and on availability changes)."""
        self._sensor_listeners.add(listener)

        @callback
        def remove() -> None:
            self._sensor_listeners.discard(listener)

        return remove

    @callback
    def _notify_sensors(self) -> None:
        for listener in list(self._sensor_listeners):
            listener()

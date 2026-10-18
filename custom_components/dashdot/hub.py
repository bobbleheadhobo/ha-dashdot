"""Talks to a dashdot server and fans the data out to sensors and cards.

Home Assistant polls dashdot's REST API server-side, so browsers only ever
talk to Home Assistant (authenticated) and never to dashdot itself.
"""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import Callable
from datetime import timedelta
import logging
import time
from typing import Any

import aiohttp

from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_time_interval

from .const import STATIC_REFRESH_INTERVAL

_LOGGER = logging.getLogger(__name__)

REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=10)

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
    """Polls one dashdot instance."""

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

        self._subscribers: set[Callable[[dict[str, Any]], None]] = set()
        self._sensor_listeners: set[CALLBACK_TYPE] = set()
        self._unsubs: list[CALLBACK_TYPE] = []
        self._polling = False
        self._last_static = 0.0
        self._last_storage = 0.0

    @property
    def widgets(self) -> list[str]:
        """Widgets enabled in dashdot (DASHDOT_WIDGET_LIST)."""
        return self.config.get("widget_list", [])

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
        self._last_static = time.monotonic()

        for widget, key in SERIES_WIDGETS.items():
            size = int(self.config.get(key) or 20)
            old = self.history.get(widget)
            if old is None or old.maxlen != size:
                self.history[widget] = deque(old or (), maxlen=size)

    async def async_start(self) -> None:
        """Do the first fetch and start polling."""
        await self.async_refresh_static()
        await self._async_poll()
        self._unsubs.append(
            async_track_time_interval(
                self.hass,
                self._async_poll_interval,
                timedelta(seconds=self.live_interval),
                name="dashdot live poll",
            )
        )
        self._unsubs.append(
            async_track_time_interval(
                self.hass,
                self._notify_sensors,
                timedelta(seconds=self.sensor_interval),
                name="dashdot sensor update",
            )
        )

    @callback
    def async_stop(self) -> None:
        """Stop polling and tell open cards to resubscribe."""
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        self._broadcast({"reload": True})
        self._subscribers.clear()

    async def _async_poll_interval(self, _now: Any) -> None:
        await self._async_poll()

    async def _async_poll(self) -> None:
        # Skip a tick rather than piling up requests if dashdot is slow.
        if self._polling:
            return
        self._polling = True
        try:
            await self._async_poll_inner()
        finally:
            self._polling = False

    async def _async_poll_inner(self) -> None:
        now = time.monotonic()
        update: dict[str, Any] = {}

        try:
            if now - self._last_static > STATIC_REFRESH_INTERVAL:
                await self.async_refresh_static()
                update["static"] = self.static_payload()

            paths = [w for w in SERIES_WIDGETS if w in self.widgets]
            storage_interval = (
                self.config.get("storage_poll_interval") or 60000
            ) / 1000
            fetch_storage = "storage" in self.widgets and (
                self.storage is None or now - self._last_storage > storage_interval
            )
            if fetch_storage:
                paths.append("storage")

            results = await asyncio.gather(*(self._get(f"load/{p}") for p in paths))
        except DashdotError as err:
            if self.available:
                _LOGGER.warning("Lost connection to dashdot: %s", err)
                self.available = False
                self._broadcast({"available": False})
                self._notify_sensors()
            return

        if not self.available:
            if self.latest:
                _LOGGER.info("Reconnected to dashdot at %s", self.base_url)
            self.available = True
            update["available"] = True
            self._notify_sensors()

        samples: dict[str, Any] = {}
        for path, value in zip(paths, results, strict=True):
            if path == "storage":
                self.storage = value
                self._last_storage = now
                update["storage"] = value
                continue
            if path == "ram" and isinstance(value, dict):
                value = value.get("load")
            # dashdot answers with an empty body until its first measurement
            if value is None:
                continue
            self.latest[path] = value
            self.history[path].append(value)
            samples[path] = value

        if samples:
            update["samples"] = samples
        self._broadcast(update)

    # ---- Card subscriptions -------------------------------------------------

    def static_payload(self) -> dict[str, Any]:
        """Data that rarely changes."""
        return {
            "config": self.config,
            "info": self.info,
            "boot_time": self.boot_time,
        }

    def snapshot(self) -> dict[str, Any]:
        """Everything a freshly opened card needs to draw itself."""
        return {
            "static": self.static_payload(),
            "available": self.available,
            "history": {k: list(v) for k, v in self.history.items()},
            "storage": self.storage,
            "live_interval": self.live_interval,
        }

    @callback
    def subscribe(self, listener: Callable[[dict[str, Any]], None]) -> CALLBACK_TYPE:
        """Receive live updates. Returns an unsubscribe callback."""
        self._subscribers.add(listener)

        @callback
        def unsubscribe() -> None:
            self._subscribers.discard(listener)

        return unsubscribe

    def _broadcast(self, update: dict[str, Any]) -> None:
        if not update:
            return
        for listener in list(self._subscribers):
            listener(update)

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
    def _notify_sensors(self, _now: Any = None) -> None:
        for listener in list(self._sensor_listeners):
            listener()

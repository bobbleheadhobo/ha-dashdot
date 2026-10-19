"""The dash. (dashdot) integration."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.const import CONF_URL, CONF_VERIFY_SSL, Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import (
    CARD_URL,
    CONF_LIVE_INTERVAL,
    CONF_SENSOR_INTERVAL,
    DEFAULT_LIVE_INTERVAL,
    DEFAULT_SENSOR_INTERVAL,
    DOMAIN,
)
from .hub import DashdotError, DashdotHub

PLATFORMS = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

CARD_PATH = Path(__file__).parent / "www" / "dashdot-card.js"

type DashdotConfigEntry = ConfigEntry[DashdotHub]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve the card and register the websocket API."""
    card_hash = await hass.async_add_executor_job(
        lambda: hashlib.sha1(CARD_PATH.read_bytes()).hexdigest()[:10]
    )
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(CARD_PATH), True)]
    )
    # Loads the card on every dashboard, no manual resource setup needed.
    add_extra_js_url(hass, f"{CARD_URL}?v={card_hash}")

    websocket_api.async_register_command(hass, ws_subscribe)
    websocket_api.async_register_command(hass, ws_instances)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: DashdotConfigEntry) -> bool:
    """Set up a dashdot instance."""
    hub = DashdotHub(
        hass,
        entry.data[CONF_URL],
        entry.data.get(CONF_VERIFY_SSL, True),
        entry.options.get(CONF_LIVE_INTERVAL, DEFAULT_LIVE_INTERVAL),
        entry.options.get(CONF_SENSOR_INTERVAL, DEFAULT_SENSOR_INTERVAL),
    )
    try:
        await hub.async_start()
    except DashdotError as err:
        hub.async_stop()
        raise ConfigEntryNotReady(str(err)) from err

    entry.runtime_data = hub
    # widgets added/removed in dashdot change which sensors exist
    hub.on_layout_change = lambda: hass.config_entries.async_schedule_reload(
        entry.entry_id
    )
    entry.async_on_unload(hub.async_stop)
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: DashdotConfigEntry) -> bool:
    """Unload a dashdot instance."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_reload(hass: HomeAssistant, entry: DashdotConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


def _loaded_entries(hass: HomeAssistant) -> list[DashdotConfigEntry]:
    return [
        e
        for e in hass.config_entries.async_entries(DOMAIN)
        if e.state is ConfigEntryState.LOADED
    ]


@websocket_api.websocket_command({vol.Required("type"): "dashdot/instances"})
@callback
def ws_instances(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """List configured dashdot instances (used by the card editor)."""
    connection.send_result(
        msg["id"],
        [{"entry_id": e.entry_id, "title": e.title} for e in _loaded_entries(hass)],
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "dashdot/subscribe",
        vol.Optional("instance"): str,
        # Only stream (and fast-poll) these. Omitted = everything.
        vol.Optional("widgets"): [
            vol.In(["os", "cpu", "ram", "gpu", "network", "storage"])
        ],
    }
)
@callback
def ws_subscribe(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Stream live dashdot data to a card."""
    entries = _loaded_entries(hass)
    wanted = msg.get("instance")
    if wanted:
        wanted_l = wanted.lower()
        entries = [
            e for e in entries if e.entry_id == wanted or e.title.lower() == wanted_l
        ]
    if not entries:
        connection.send_error(
            msg["id"],
            "not_found",
            f"No loaded dashdot instance matching '{wanted}'"
            if wanted
            else "No dashdot instance is configured",
        )
        return

    hub: DashdotHub = entries[0].runtime_data

    @callback
    def forward(update: dict[str, Any]) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], update))

    widgets = frozenset(msg["widgets"]) if "widgets" in msg else None
    connection.subscriptions[msg["id"]] = hub.subscribe(forward, widgets)
    connection.send_result(msg["id"])
    forward(hub.snapshot(widgets))

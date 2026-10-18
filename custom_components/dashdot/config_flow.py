"""Config flow for the dash. integration."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import aiohttp
import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import CONF_URL, CONF_VERIFY_SSL
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_LIVE_INTERVAL,
    CONF_SENSOR_INTERVAL,
    DEFAULT_LIVE_INTERVAL,
    DEFAULT_SENSOR_INTERVAL,
    DOMAIN,
)
from .hub import REQUEST_TIMEOUT, DashdotError, async_fetch_json


async def _ui_reachable(
    session: aiohttp.ClientSession, url: str, verify_ssl: bool
) -> bool:
    try:
        async with session.get(
            f"{url}/", timeout=REQUEST_TIMEOUT, ssl=None if verify_ssl else False
        ) as resp:
            return resp.status == 200
    except (TimeoutError, aiohttp.ClientError):
        return False


class DashdotConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for dash."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            verify_ssl = user_input[CONF_VERIFY_SSL]
            await self.async_set_unique_id(url.lower())
            self._abort_if_unique_id_configured()

            session = async_get_clientsession(self.hass, verify_ssl=verify_ssl)
            try:
                await async_fetch_json(session, url, "config", verify_ssl)
                await async_fetch_json(session, url, "info", verify_ssl)
            except DashdotError:
                # Distinguish "wrong URL" from "API switched off": the web UI
                # (HTML, not JSON) still answers when integrations are off.
                errors["base"] = (
                    "integrations_disabled"
                    if await _ui_reachable(session, url, verify_ssl)
                    else "cannot_connect"
                )
            else:
                host = urlparse(url).hostname or url
                title = f"dash. {host}"
                return self.async_create_entry(
                    title=title,
                    data={CONF_URL: url, CONF_VERIFY_SSL: verify_ssl},
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_URL,
                        default=(user_input or {}).get(CONF_URL, "http://"),
                    ): str,
                    vol.Required(CONF_VERIFY_SSL, default=True): bool,
                }
            ),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return DashdotOptionsFlow()


class DashdotOptionsFlow(OptionsFlow):
    """Polling intervals."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)

        options = self.config_entry.options
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_LIVE_INTERVAL,
                        default=options.get(CONF_LIVE_INTERVAL, DEFAULT_LIVE_INTERVAL),
                    ): vol.All(vol.Coerce(float), vol.Range(min=0.5, max=60)),
                    vol.Required(
                        CONF_SENSOR_INTERVAL,
                        default=options.get(
                            CONF_SENSOR_INTERVAL, DEFAULT_SENSOR_INTERVAL
                        ),
                    ): vol.All(vol.Coerce(int), vol.Range(min=5, max=3600)),
                }
            ),
        )

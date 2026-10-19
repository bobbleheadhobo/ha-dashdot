"""Sensor entities for dash.

The live graphs in the card are streamed over the websocket API and never
touch the state machine. These sensors are for automations / history and
only write a state every `sensor_interval` seconds to keep the recorder small.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import (
    PERCENTAGE,
    UnitOfDataRate,
    UnitOfInformation,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import DashdotConfigEntry
from .const import DOMAIN
from .hub import DashdotHub


@dataclass(frozen=True, kw_only=True)
class DashdotSensorDescription(SensorEntityDescription):
    value_fn: Callable[[DashdotHub], Any]


def _avg(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 1) if values else None


def _cpu_load(hub: DashdotHub) -> float | None:
    cores = hub.latest.get("cpu") or []
    return _avg([c.get("load", 0) for c in cores])


def _cpu_temp(hub: DashdotHub) -> float | None:
    temps = [c.get("temp") for c in hub.latest.get("cpu") or [] if c.get("temp")]
    if not temps:
        return None
    if hub.config.get("cpu_temps_mode") == "max":
        return round(max(temps), 1)
    return _avg(temps)


def _ram_size(hub: DashdotHub) -> float | None:
    override = (hub.config.get("override") or {}).get("ram_size")
    return override or (hub.info.get("ram") or {}).get("size")


def _ram_usage(hub: DashdotHub) -> float | None:
    used, size = hub.latest.get("ram"), _ram_size(hub)
    if used is None or not size:
        return None
    return round(used / size * 100, 1)


def _gpu(hub: DashdotHub, index: int) -> dict[str, Any]:
    layout = (hub.latest.get("gpu") or {}).get("layout") or []
    return layout[index] if index < len(layout) else {}


def _gpu_load(hub: DashdotHub, index: int) -> float | None:
    gpu = _gpu(hub, index)
    engines = gpu.get("engines")
    if engines:
        # Intel GPUs report per-engine busy %, use the busiest engine.
        return round(max(engines.values()), 1)
    load = gpu.get("load")
    return None if load is None else round(load, 1)


def _gpu_memory(hub: DashdotHub, index: int) -> float | None:
    memory = _gpu(hub, index).get("memory")
    return None if memory is None else round(memory, 1)


def _network(hub: DashdotHub, key: str) -> float | None:
    value = (hub.latest.get("network") or {}).get(key)
    return None if value is None else round(value)


def _storage_usage(hub: DashdotHub, index: int) -> float | None:
    storage = hub.info.get("storage") or []
    loads = hub.storage or []
    if index >= len(storage) or index >= len(loads):
        return None
    size = storage[index].get("size")
    return round(loads[index] / size * 100, 1) if size else None


def _last_boot(hub: DashdotHub) -> datetime | None:
    if hub.boot_time is None:
        return None
    # Round so jitter in the reported uptime doesn't create new states.
    return datetime.fromtimestamp(round(hub.boot_time / 60) * 60, tz=UTC)


def _descriptions(hub: DashdotHub) -> list[DashdotSensorDescription]:
    widgets = hub.widgets
    result: list[DashdotSensorDescription] = [
        DashdotSensorDescription(
            key="last_boot",
            translation_key="last_boot",
            device_class=SensorDeviceClass.TIMESTAMP,
            value_fn=_last_boot,
        )
    ]

    if "cpu" in widgets:
        result.append(
            DashdotSensorDescription(
                key="cpu_load",
                translation_key="cpu_load",
                native_unit_of_measurement=PERCENTAGE,
                state_class=SensorStateClass.MEASUREMENT,
                suggested_display_precision=1,
                icon="mdi:cpu-64-bit",
                value_fn=_cpu_load,
            )
        )
        if hub.config.get("enable_cpu_temps"):
            result.append(
                DashdotSensorDescription(
                    key="cpu_temperature",
                    translation_key="cpu_temperature",
                    device_class=SensorDeviceClass.TEMPERATURE,
                    native_unit_of_measurement=UnitOfTemperature.CELSIUS,
                    state_class=SensorStateClass.MEASUREMENT,
                    value_fn=_cpu_temp,
                )
            )

    if "ram" in widgets:
        result += [
            DashdotSensorDescription(
                key="ram_usage",
                translation_key="ram_usage",
                native_unit_of_measurement=PERCENTAGE,
                state_class=SensorStateClass.MEASUREMENT,
                suggested_display_precision=1,
                icon="mdi:memory",
                value_fn=_ram_usage,
            ),
            DashdotSensorDescription(
                key="ram_used",
                translation_key="ram_used",
                device_class=SensorDeviceClass.DATA_SIZE,
                native_unit_of_measurement=UnitOfInformation.BYTES,
                suggested_unit_of_measurement=UnitOfInformation.GIBIBYTES,
                state_class=SensorStateClass.MEASUREMENT,
                suggested_display_precision=1,
                entity_registry_enabled_default=False,
                value_fn=lambda hub: hub.latest.get("ram"),
            ),
        ]

    if "gpu" in widgets:
        for i, _ in enumerate((hub.info.get("gpu") or {}).get("layout") or []):
            placeholders = {"index": str(i + 1)}
            result += [
                DashdotSensorDescription(
                    key=f"gpu_{i}_load",
                    translation_key="gpu_load",
                    translation_placeholders=placeholders,
                    native_unit_of_measurement=PERCENTAGE,
                    state_class=SensorStateClass.MEASUREMENT,
                    suggested_display_precision=1,
                    icon="mdi:expansion-card",
                    value_fn=lambda hub, i=i: _gpu_load(hub, i),
                ),
                DashdotSensorDescription(
                    key=f"gpu_{i}_memory",
                    translation_key="gpu_memory",
                    translation_placeholders=placeholders,
                    native_unit_of_measurement=PERCENTAGE,
                    state_class=SensorStateClass.MEASUREMENT,
                    suggested_display_precision=1,
                    icon="mdi:expansion-card-variant",
                    value_fn=lambda hub, i=i: _gpu_memory(hub, i),
                ),
            ]

    if "network" in widgets:
        for key, icon in (("up", "mdi:upload"), ("down", "mdi:download")):
            result.append(
                DashdotSensorDescription(
                    key=f"network_{key}",
                    translation_key=f"network_{key}",
                    device_class=SensorDeviceClass.DATA_RATE,
                    native_unit_of_measurement=UnitOfDataRate.BYTES_PER_SECOND,
                    suggested_unit_of_measurement=UnitOfDataRate.MEGABITS_PER_SECOND,
                    state_class=SensorStateClass.MEASUREMENT,
                    suggested_display_precision=1,
                    icon=icon,
                    value_fn=lambda hub, key=key: _network(hub, key),
                )
            )

    if "storage" in widgets:
        for i, _ in enumerate(hub.info.get("storage") or []):
            result.append(
                DashdotSensorDescription(
                    key=f"storage_{i}_usage",
                    translation_key="storage_usage",
                    translation_placeholders={"index": str(i + 1)},
                    native_unit_of_measurement=PERCENTAGE,
                    state_class=SensorStateClass.MEASUREMENT,
                    suggested_display_precision=1,
                    icon="mdi:harddisk",
                    value_fn=lambda hub, i=i: _storage_usage(hub, i),
                )
            )

    return result


async def async_setup_entry(
    hass: HomeAssistant,
    entry: DashdotConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    hub = entry.runtime_data
    async_add_entities(
        DashdotSensor(hub, entry, description) for description in _descriptions(hub)
    )


class DashdotSensor(SensorEntity):
    """A dashdot metric."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    entity_description: DashdotSensorDescription

    def __init__(
        self,
        hub: DashdotHub,
        entry: DashdotConfigEntry,
        description: DashdotSensorDescription,
    ) -> None:
        self.hub = hub
        self.entity_description = description
        self._attr_unique_id = f"{entry.entry_id}_{description.key}"
        os_info = hub.info.get("os") or {}
        override = hub.config.get("override") or {}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="dashdot",
            model=override.get("os")
            or f"{os_info.get('distro', '')} {os_info.get('release', '')}".strip()
            or None,
            sw_version=os_info.get("dash_version"),
        )

    @property
    def available(self) -> bool:
        # key prefix is the dashdot endpoint the value comes from
        widget = self.entity_description.key.split("_")[0]
        if widget in ("cpu", "ram", "gpu", "network", "storage"):
            return self.hub.widget_ok(widget)
        return self.hub.available

    @property
    def native_value(self) -> Any:
        return self.entity_description.value_fn(self.hub)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.hub.add_sensor_listener(self.async_write_ha_state))

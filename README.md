# dash. for Home Assistant

A Home Assistant custom integration plus a Lovelace card that redraws the
dashdot widgets natively inside Home Assistant, without an iframe.

```
browser ──(HA login, HA websocket)──▶ Home Assistant ──(LAN, server-side)──▶ dashdot
```

Home Assistant fetches dashdot's REST API (`/config`, `/info`, `/load/*`) from
the server side and streams the data to the card over Home Assistant's own
authenticated websocket. Your browser never connects to dashdot, so dashdot
only has to be reachable from the Home Assistant host. You don't need a public
URL, reverse proxy route or unauthenticated iframe.

## Install

### HACS (recommended)

1. In Home Assistant open **HACS → ⋮ → Custom repositories**.
2. Add `https://github.com/bobbleheadhobo/ha-dashdot` with type **Integration**.
3. Install **dash.** and restart Home Assistant.

### Manual

Copy `custom_components/dashdot` into your Home Assistant config folder, so
you end up with `/config/custom_components/dashdot/manifest.json`, then
restart Home Assistant.

### Setup

1. Go to **Settings → Devices & services → Add integration → dash.** and enter
   the URL of dashdot as Home Assistant can reach it, including
   `DASHDOT_ROUTING_PATH` if you set one, e.g. `http://192.168.1.10:3001` or
   `http://192.168.1.10:3001/my-path`.
2. Add the card to a dashboard:

```yaml
type: custom:dashdot-card
```

The integration serves and registers the card itself, so there is no
dashboard resource to add and no separate HACS "Dashboard" download. After an
update, refresh the browser (or clear the companion app's frontend cache) to
load the new card.

dashdot's `DASHDOT_DISABLE_INTEGRATIONS` must **not** be `true`, because the
REST API is what Home Assistant reads. Any dashdot image works, no changes to
dashdot are needed.

## Card options

| Option             | Default                  | Description                                                                |
| ------------------ | ------------------------ | -------------------------------------------------------------------------- |
| `widgets`          | `DASHDOT_WIDGET_LIST`    | Any of `os`, `cpu`, `ram`, `gpu`, `network`, `storage`, in display order    |
| `instance`         | first configured         | Config entry title (e.g. `dash. 192.168.1.10`) when you have several       |
| `show_percentages` | like dashdot             | `true`/`false`. dashdot shows them only on narrow layouts by default        |
| `theme`            | `auto`                   | `auto` follows Home Assistant's dark mode, or force `light` / `dark`        |
| `height`           | `360`                    | Minimum height of each widget in px                                         |
| `multi_core`       | `false`                  | Initial state of "Show All Cores" (the toggle is remembered per browser)    |

Your dashdot settings (overrides, label lists, `*_shown_datapoints`,
`*_widget_grow`, `cpu_cores_toggle_mode`, `use_imperial`, ...) are read from
dashdot and applied just like on the dashdot page.

Several widgets in one card lay out like dashdot does (flex-wrap using the
`*_widget_grow` / `*_widget_min_width` settings). A panel view gives the
closest look to the real page. You can also use one card per widget, e.g.
`widgets: [cpu]`.

## Entities

The integration also creates sensors for automations and history: CPU load,
CPU temperature (if `DASHDOT_ENABLE_CPU_TEMPS`), memory usage, per-GPU load and
memory, network up/down, storage usage and last boot.

The graphs are streamed separately from these sensors, so they don't flood the
recorder. Sensors only write a new state every *sensor interval* (30 s
default). The graph refresh rate is the *live interval* (1 s default, like
dashdot). Change both under **Configure** on the integration.

## Security notes

* dashdot's API has no authentication. Keep it off the internet: remove any
  reverse proxy / tunnel route to it, and ideally publish the port only on
  the LAN interface Home Assistant uses, e.g. `'192.168.1.10:3001:3001'`
  instead of `'3001:3001'`. If Home Assistant runs on the same Docker host,
  you can put both on a shared Docker network and drop `ports:` entirely.
* The card's data is available to any logged-in Home Assistant user (the same
  people who can see your dashboards).
* The card renders every value from dashdot as text, never as HTML.

## Credits

The card's design is ported from [dashdot](https://github.com/MauriceNino/dashdot)
by Maurice el-Banna (MIT). This project is not affiliated with dashdot.

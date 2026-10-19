# dash. for Home Assistant

A Home Assistant custom integration plus a Lovelace card that redraws the
dashdot widgets natively inside Home Assistant, without an iframe.

![The full dash. card in Home Assistant](https://raw.githubusercontent.com/bobbleheadhobo/ha-dashdot/main/images/widgets.png)

Or single graphs, like dashdot's iframe widgets:

![Single graph cards: CPU cores, memory, CPU, GPU load](https://raw.githubusercontent.com/bobbleheadhobo/ha-dashdot/main/images/graphs.png)

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

To change the URL later (e.g. dashdot's host got a new IP), use **⋮ →
Reconfigure** on the integration. Entities and their history are kept.

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
| `instance`         | first configured         | Config entry title (e.g. `dash. 2`) when you have several                   |
| `show_percentages` | like dashdot             | `true`/`false`. dashdot shows them only on narrow layouts by default        |
| `theme`            | `auto`                   | `auto` follows Home Assistant's dark mode, or force `light` / `dark`        |
| `height`           | `360`                    | Minimum height of each widget in px                                         |
| `multi_core`       | `false`                  | Initial state of "Show All Cores" (the toggle is remembered per browser)    |

Your dashdot settings (overrides, label lists, `*_shown_datapoints`,
`*_widget_grow`, `cpu_cores_toggle_mode`, `use_imperial`, ...) are read from
dashdot and applied just like on the dashdot page.

These options are for the full widgets. For single graphs see below.

Several widgets in one card lay out like dashdot does (flex-wrap using the
`*_widget_grow` / `*_widget_min_width` settings). A panel view gives the
closest look to the real page. You can also use one card per widget, e.g.
`widgets: [cpu]`.

## Single graphs (iframe replacement)

Set `graph` to get just the graph, exactly like a dashdot iframe widget
(`https://<dashdot>/?graph=cpu&...`). The options use the same names as
dashdot's query parameters:

| Option           | Values                                       | Default         |
| ---------------- | -------------------------------------------- | --------------- |
| `graph`          | `cpu`, `ram`, `gpu`, `network`, `storage`    | required        |
| `multiView`      | `true` = every CPU core / every drive        | `false`         |
| `filter`         | gpu: `load` / `memory`, network: `up` / `down` | show all      |
| `showPercentage` | `true` / `false`                             | `false`         |
| `theme`          | `auto`, `light`, `dark`                      | `auto`          |
| `color`          | hex graph color, `#` optional (`ff526f`)     | widget color    |
| `surface`        | hex background color (`000000`)              | theme surface   |
| `innerRadius`    | corner radius of the graphs                  | `10px`          |
| `gap`            | space between graphs                         | `12px`          |
| `textSize`       | size of the percentage text                  | `16px`          |
| `textOffset`     | distance of the text from the corner         | `24px`          |
| `height`         | card height, e.g. `150px`                    | fills grid cell |

Sizes accept a plain number (pixels) or a CSS unit (`px`, `em`, `rem`, `%`,
...). snake_case spellings (`multi_view`, `show_percentage`, `inner_radius`,
`text_size`, `text_offset`) work too.

To move an existing iframe over, paste its URL or query string into `query`:

```yaml
type: custom:dashdot-card
query: https://dash.example.com/?graph=gpu&theme=dark&filter=load&gap=1
```

Options set next to `query` win over the ones inside it, and the visual
editor turns a pasted `query` into separate fields when you edit the card.

More examples:

```yaml
# All CPU cores, tight grid
type: custom:dashdot-card
graph: cpu
multiView: true
gap: 1

# RAM with the percentage label
type: custom:dashdot-card
graph: ram
showPercentage: true

# Only the GPU load (Intel GPUs: the main engine), red on black
type: custom:dashdot-card
graph: gpu
filter: load
showPercentage: true
color: ff526f
surface: "000000"
```

In a sections view the graph fills its grid cell, so resize it there. In
masonry views, set `height`.

## Entities

The integration also creates sensors for automations and history: CPU load,
CPU temperature (if `DASHDOT_ENABLE_CPU_TEMPS`), memory usage, per-GPU load and
memory, network up/down, storage usage and last boot.

The graphs are streamed separately from these sensors, so they don't flood the
recorder. Sensors only write a new state every *sensor interval* (30 s
default). The graph refresh rate is the *live interval* (1 s default, like
dashdot). Change both under **Configure** on the integration.

Home Assistant only polls an endpoint at the live interval while an open card
shows it. Everything else is polled at the sensor interval. For example, a
dashboard with just a RAM graph means one request per second, and nothing is
fast-polled when no card is open. All open cards share the same polling, and
each card only receives the data it shows. When a graph opens, it starts fresh
and fills up within a few seconds.

If you change `DASHDOT_WIDGET_LIST`, `DASHDOT_ENABLE_CPU_TEMPS`, or the
GPUs/drives dashdot sees, the integration reloads itself to add or remove
sensors. dashdot's config is re-read every 10 minutes, so this can take up
to 10 minutes. Reload the integration to apply it right away.

If one of dashdot's endpoints fails (for example the GPU read), only the
sensors that use it become unavailable.

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
by Maurice el-Banna (MIT, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
This project is not affiliated with dashdot.

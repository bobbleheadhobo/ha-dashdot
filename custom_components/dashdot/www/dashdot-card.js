/*
 * dash. card for Home Assistant
 *
 * Recreates the dashdot widgets natively inside Home Assistant. Data is
 * streamed from the `dashdot` integration over Home Assistant's own
 * (authenticated) websocket, so the browser never talks to dashdot directly.
 *
 *   type: custom:dashdot-card
 *   instance: dash. 192.168.1.10   # optional, config entry title or id
 *   widgets: [os, cpu, ram, gpu]  # optional, defaults to DASHDOT_WIDGET_LIST
 *   show_percentages: true        # optional, default: like dashdot (narrow only)
 *   theme: auto                   # optional, auto | light | dark
 *   height: 360                   # optional, widget height in px
 *
 * Single graph, like dashdot's iframe widgets (same option names):
 *
 *   type: custom:dashdot-card
 *   graph: cpu                    # cpu | ram | gpu | network | storage
 *   multiView: true               # cpu cores / storage drives
 *   filter: load                  # gpu: load | memory, network: up | down
 *   showPercentage: true
 *   color: ff526f                 # graph color (hex, # optional)
 *   surface: 000000               # graph background (hex)
 *   innerRadius: 10px
 *   gap: 12px
 *   textSize: 16px
 *   textOffset: 24px
 *   height: 150px                 # optional, fills the grid cell otherwise
 *
 * or paste the query string of an existing dashdot iframe:
 *
 *   query: graph=cpu&multiView=true&gap=1
 */

const CARD_VERSION = '1.1.0';

const PALETTES = {
  light: {
    primary: '#5ee2ff',
    surface: '#fafafa',
    background: '#d9d9d9',
    text: '#404040',
    cpu: '#52d7ff',
    ram: '#ff526f',
    storage: '#49e37a',
    network: '#ffd745',
    gpu: '#c97bff',
  },
  dark: {
    primary: '#775a9e',
    surface: '#212121',
    background: '#4f4f4f',
    text: '#fafafa',
    cpu: '#2259b3',
    ram: '#c43148',
    storage: '#22b352',
    network: '#e9c235',
    gpu: '#a135eb',
  },
};

const NARROW_WIDTH = 600;
const KNOWN_WIDGETS = ['os', 'cpu', 'ram', 'gpu', 'network', 'storage'];
const GRAPHS = ['cpu', 'ram', 'gpu', 'network', 'storage'];
const GRAPH_FILTERS = { gpu: ['load', 'memory'], network: ['up', 'down'] };

// snake_case spellings of dashdot's iframe query parameters
const ALIASES = {
  multi_view: 'multiView',
  show_percentage: 'showPercentage',
  inner_radius: 'innerRadius',
  text_size: 'textSize',
  text_offset: 'textOffset',
};

// Same validation as dashdot's query-params.ts
const SIZE_RE = /^\d+(\.\d+)?(px|rem|em|%|vh|vw|ch|ex)$/i;
const COLOR_RE = /^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const toSize = (value, name) => {
  if (value == null || value === '') return undefined;
  const str = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return `${str}px`;
  if (SIZE_RE.test(str)) return str;
  throw new Error(`${name} must be a size like 12, 12px or 1em (got "${str}")`);
};

const toColor = (value, name) => {
  if (value == null || value === '') return undefined;
  const str = String(value).trim().replace(/^#/, '');
  if (COLOR_RE.test(str)) return `#${str}`;
  // YAML turns unquoted 000000 into the number 0
  const hint = typeof value === 'number' ? `. Put the hex value in quotes, e.g. ${name}: "000000"` : '';
  throw new Error(`${name} must be a hex color like ff526f (got "${value}")${hint}`);
};

const toBool = (value) => value === true || value === 'true';

/** Merge `query` (an iframe query string or URL) into the config and resolve aliases */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const normalizeConfig = (raw) => {
  const config = {};
  const put = (k, v) => {
    if (!UNSAFE_KEYS.has(k)) config[ALIASES[k] ?? k] = v;
  };
  if (raw.query) {
    let query = String(raw.query);
    if (query.includes('?')) query = query.slice(query.indexOf('?') + 1);
    for (const [k, v] of new URLSearchParams(query)) put(k, v);
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k !== 'query') put(k, v);
  }
  return config;
};

// ---------------------------------------------------------------------------
// Formatting (ported from apps/view/src/utils/calculations.ts)

const bytePrettyPrint = (byte) =>
  byte > 1024 ** 4 * 10
    ? `${(byte / 1024 ** 4).toFixed(1)} TiB`
    : byte > 1024 ** 3
      ? `${(byte / 1024 ** 3).toFixed(1)} GiB`
      : byte > 1024 ** 2
        ? `${(byte / 1024 ** 2).toFixed(1)} MiB`
        : byte > 1024
          ? `${(byte / 1024).toFixed(1)} KiB`
          : `${byte.toFixed(1)} B`;

const bpsPrettyPrint = (bits, asBytes = false) => {
  const units = asBytes
    ? ['B/s', 'KB/s', 'MB/s', 'GB/s']
    : ['b/s', 'Kb/s', 'Mb/s', 'Gb/s'];
  const value = asBytes ? bits / 8 : bits;
  const exp =
    bits >= 1e9 ? 3 : bits >= 1e6 ? 2 : bits >= 1e3 ? 1 : 0;
  return `${(value / 1000 ** exp).toFixed(1)} ${units[exp]}`;
};

const celsiusToFahrenheit = (c) => (c * 9) / 5 + 32;
const unique = (arr) => [...new Set((arr ?? []).filter((x) => x != null && x !== ''))];
const fixed = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '?');

const toInfoTable = (order, mappings) =>
  (order ?? [])
    .filter((key) => mappings[key])
    .map((key) => {
      const { label, value } = mappings[key];
      return { label, value: value ? String(value) : undefined };
    });

// Same as dashdot's getColumnsForCores
const getColumnsForCores = (cores) => {
  let columns = 1;
  for (let i = 0; i < cores - 1; i++) {
    if (cores % i === 0) {
      columns = i;
      if (columns >= cores / i) return columns;
    }
  }
  return columns;
};

// ---------------------------------------------------------------------------
// DOM helpers. Text is only ever set via textContent, never innerHTML.

const SVG_NS = 'http://www.w3.org/2000/svg';

const h = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};

const s = (tag, attrs = {}, children = []) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of children) node.append(child);
  return node;
};

const icon = (name) => {
  const node = document.createElement('ha-icon');
  node.setAttribute('icon', name);
  return node;
};

// ---------------------------------------------------------------------------
// Monotone cubic interpolation, equivalent to d3's curveMonotoneX which
// recharts uses for type="monotone".

const sign = (x) => (x < 0 ? -1 : 1);
const slope3 = (p0, p1, p2) => {
  const h0 = p1[0] - p0[0];
  const h1 = p2[0] - p1[0];
  const s0 = (p1[1] - p0[1]) / (h0 || (h1 < 0 && -0));
  const s1 = (p2[1] - p1[1]) / (h1 || (h0 < 0 && -0));
  const p = (s0 * h1 + s1 * h0) / (h0 + h1);
  return (
    (sign(s0) + sign(s1)) *
      Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0
  );
};
const slope2 = (p0, p1, t) => {
  const dx = p1[0] - p0[0];
  return dx ? ((3 * (p1[1] - p0[1])) / dx - t) / 2 : t;
};

const monotonePath = (pts) => {
  const n = pts.length;
  if (n < 2) return '';
  const f = (v) => +v.toFixed(3);
  if (n === 2) return `M${f(pts[0][0])},${f(pts[0][1])}L${f(pts[1][0])},${f(pts[1][1])}`;

  const m = new Array(n);
  for (let i = 1; i < n - 1; i++) m[i] = slope3(pts[i - 1], pts[i], pts[i + 1]);
  m[0] = slope2(pts[0], pts[1], m[1]);
  m[n - 1] = slope2(pts[n - 2], pts[n - 1], m[n - 2]);

  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const dx = (x1 - x0) / 3;
    d += `C${f(x0 + dx)},${f(y0 + dx * m[i])},${f(x1 - dx)},${f(y1 - dx * m[i + 1])},${f(x1)},${f(y1)}`;
  }
  return d;
};

// ---------------------------------------------------------------------------
// Area chart (ChartContainer + DefaultAreaChart)

let chartIds = 0;

class AreaChart {
  constructor({ color, format, edges, small, radius, textSize, textOffset }) {
    this.format = format;
    this.values = [];
    this.domain = [-5, 105];
    this.hoverX = null;
    const id = `dd-grad-${++chartIds}`;
    const [tl, tr, br, bl] = (edges ?? [true, true, true, true]).map((e) => (e ? '25px' : '10px'));

    this.line = s('path', {
      fill: 'none',
      stroke: color,
      'stroke-width': '3',
      'vector-effect': 'non-scaling-stroke',
      'stroke-linejoin': 'round',
    });
    this.area = s('path', { fill: `url(#${id})`, stroke: 'none' });
    this.svg = s('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none' }, [
      s('defs', {}, [
        s('linearGradient', { id, x1: '0', y1: '0', x2: '0', y2: '1' }, [
          s('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '0.2' }),
          s('stop', { offset: '95%', 'stop-color': color, 'stop-opacity': '0' }),
        ]),
      ]),
      this.area,
      this.line,
    ]);

    const statStyle = (side) => {
      const style = {};
      if (textOffset) {
        style.marginTop = textOffset;
        style[side === 'left' ? 'marginLeft' : 'marginRight'] = textOffset;
      }
      // dashdot always draws secondary GPU engine labels at 0.8em
      if (textSize && !small) style.fontSize = textSize;
      return style;
    };
    this.statLeft = h('p', { class: `stat left${small ? ' small' : ''}`, style: statStyle('left') });
    this.statRight = h('p', { class: `stat right${small ? ' small' : ''}`, style: statStyle('right') });
    this.loader = h('div', { class: 'loader' }, [h('span'), h('span'), h('span')]);
    this.dot = h('div', { class: 'dot', style: { background: color } });
    this.tip = h('div', { class: 'tip' });
    this.clip = h('div', { class: 'clip' }, [this.svg]);

    this.el = h(
      'div',
      {
        class: 'chart',
        style: { borderRadius: radius ?? `${tl} ${tr} ${br} ${bl}` },
        onpointermove: (e) => {
          const rect = this.el.getBoundingClientRect();
          this.hoverX = (e.clientX - rect.left) / rect.width;
          this.renderHover();
        },
        onpointerleave: () => {
          this.hoverX = null;
          this.renderHover();
        },
      },
      [this.statLeft, this.statRight, this.loader, this.clip, this.dot, this.tip],
    );
  }

  setTexts(left, right) {
    this.statLeft.textContent = left ?? '';
    this.statRight.textContent = right ?? '';
  }

  set(values, domain = [-5, 105]) {
    this.values = values;
    this.domain = domain;
    const loaded = values.length > 1;
    this.el.classList.toggle('loading', !loaded);
    if (!loaded) return;

    const [d0, d1] = domain;
    const span = d1 - d0 || 1;
    const pts = values.map((v, i) => [
      (i / (values.length - 1)) * 100,
      100 - (((Number(v) || 0) - d0) / span) * 100,
    ]);
    const line = monotonePath(pts);
    this.line.setAttribute('d', line);
    this.area.setAttribute('d', `${line}L100,100L0,100Z`);
    this.renderHover();
  }

  renderHover() {
    const n = this.values.length;
    if (this.hoverX == null || n < 2) {
      this.dot.style.display = 'none';
      this.tip.style.display = 'none';
      return;
    }
    const i = Math.max(0, Math.min(n - 1, Math.round(this.hoverX * (n - 1))));
    const [d0, d1] = this.domain;
    const fx = i / (n - 1);
    const fy = 1 - ((Number(this.values[i]) || 0) - d0) / (d1 - d0 || 1);
    Object.assign(this.dot.style, { display: 'block', left: `${fx * 100}%`, top: `${fy * 100}%` });
    this.tip.textContent = this.format(this.values[i]);
    Object.assign(this.tip.style, {
      display: 'block',
      left: `${Math.min(Math.max(fx * 100, 15), 85)}%`,
      top: fy > 0.5 ? `calc(${fy * 100}% - 40px)` : `calc(${fy * 100}% + 15px)`,
    });
  }
}

// Horizontal used/available bars for the storage widget
class BarChart {
  constructor(color) {
    this.color = color;
    this.el = h('div', { class: 'chart bars' });
  }

  set(rows) {
    this.el.replaceChildren(
      ...rows.map((r) =>
        h('div', { class: 'bar-row' }, [
          h('div', { class: 'bar', title: `${bytePrettyPrint(r.used)} / ${bytePrettyPrint(r.size)}` }, [
            h('div', {
              class: 'bar-fill',
              style: { width: `${Math.min(100, r.percent)}%`, background: this.color },
            }),
            h('span', { class: 'bar-label', text: r.label }),
          ]),
        ]),
      ),
    );
  }
}

// Used / free ring (DefaultPieChart) for total storage
class DonutChart {
  constructor({ color, radius, textSize, textOffset }) {
    const ring = (attrs) =>
      s('circle', { cx: '50', cy: '50', r: '34', fill: 'none', 'stroke-width': '14', ...attrs });
    this.free = ring({ stroke: 'var(--dd-text)', 'stroke-opacity': '0.2' });
    this.used = ring({ stroke: color, 'stroke-linecap': 'round', transform: 'rotate(-90 50 50)' });
    const statStyle = {};
    if (textOffset) Object.assign(statStyle, { marginTop: textOffset, marginLeft: textOffset });
    if (textSize) statStyle.fontSize = textSize;
    this.stat = h('p', { class: 'stat left', style: statStyle });
    this.loader = h('div', { class: 'loader' }, [h('span'), h('span'), h('span')]);
    this.svg = s('svg', { viewBox: '0 0 100 100', class: 'donut' }, [this.free, this.used]);
    this.el = h('div', { class: 'chart', style: { borderRadius: radius ?? '25px' } }, [
      this.stat,
      this.loader,
      h('div', { class: 'clip' }, [this.svg]),
    ]);
  }

  set(used, size, label) {
    const loaded = size > 0 && used != null;
    this.el.classList.toggle('loading', !loaded);
    if (!loaded) return;
    const circumference = 2 * Math.PI * 34;
    const fraction = Math.min(1, Math.max(0, used / size));
    this.used.setAttribute('stroke-dasharray', `${fraction * circumference} ${circumference}`);
    this.el.title = `${(fraction * 100).toFixed(1)} % Used\n${bytePrettyPrint(used)} / ${bytePrettyPrint(size)}`;
    this.stat.textContent = label ?? '';
  }
}

// ---------------------------------------------------------------------------
// Widgets

const infoTable = (infos) =>
  h(
    'div',
    { class: 'table' },
    infos.map((info) =>
      h('div', { class: 'row' }, [
        h('p', { class: 'label', text: info.label }),
        h('p', {
          class: 'value',
          text: info.value == null || info.value.trim().length === 0 ? '/' : info.value,
        }),
      ]),
    ),
  );

/** Shared layout of HardwareInfoContainer */
class HardwareWidget {
  constructor(card, { key, heading, iconName, color }) {
    this.card = card;
    this.key = key;
    this.color = color;
    this.page = 0;
    this.heading = heading;

    this.controls = h('div', { class: 'controls' });
    this.table = h('div');
    this.extra = h('div', { class: 'extra' });
    this.grid = h('div', { class: 'grid' });
    if (card.graph) {
      // iframe style: just the graph(s), no info / icon / heading
      this.el = h('div', { class: 'graph' }, [this.grid]);
      return;
    }
    this.el = card.pane(key, [
      h('div', { class: 'hw' }, [
        h('div', { class: 'icon', style: { background: color } }, [icon(iconName)]),
        h('div', { class: 'content' }, [
          h('div', { class: 'info' }, [
            h('div', { class: 'info-head' }, [h('p', { class: 'heading', text: heading }), this.controls]),
            this.table,
          ]),
          this.extra,
          h('div', { class: 'charts' }, [this.grid]),
        ]),
      ]),
    ]);
  }

  get config() {
    return this.card.dd.static.config;
  }

  get info() {
    return this.card.dd.static.info;
  }

  get override() {
    return this.config.override ?? {};
  }

  get graph() {
    return this.card.graph;
  }

  // dashdot shows the % labels on mobile, or everywhere if always_show_percentages
  get showPercentages() {
    if (this.graph) return this.graph.showPercentage;
    const forced = this.card.config.show_percentages;
    if (forced != null) return !!forced;
    return !!this.config.always_show_percentages || this.el.classList.contains('narrow');
  }

  /** infos: full list, perPage: rows per page. onPage: called on page change. */
  renderInfos(infos, perPage, onPage) {
    this.pageArgs = [infos, perPage, onPage];
    const pages = Math.max(1, Math.ceil(infos.length / perPage));
    this.page = Math.min(this.page, pages - 1);
    this.table.replaceChildren(infoTable(infos.slice(this.page * perPage, (this.page + 1) * perPage)));

    const arrows = [];
    if (this.page > 0)
      arrows.push(h('button', { class: 'arrow', 'aria-label': 'Previous', onclick: () => this.goTo(this.page - 1) }, [icon('mdi:arrow-left')]));
    if (this.page < pages - 1)
      arrows.push(h('button', { class: 'arrow', 'aria-label': 'Next', onclick: () => this.goTo(this.page + 1) }, [icon('mdi:arrow-right')]));
    this.controls.replaceChildren(...arrows);
  }

  goTo(page) {
    this.page = page;
    this.renderInfos(...this.pageArgs);
    this.pageArgs[2]?.();
  }

  /** An area chart styled for the current mode */
  chart(opts) {
    return new AreaChart({ ...opts, ...this.card.chartStyle });
  }

  setGrid(charts, { columns = 1, template, rows, gap = 20 } = {}) {
    this.charts = charts;
    Object.assign(this.grid.style, {
      gridTemplateColumns: template ?? `repeat(${columns}, minmax(0, 1fr))`,
      gridTemplateRows: rows ? `repeat(${rows}, minmax(0, 1fr))` : '',
      gap: this.graph ? this.graph.gap : `${gap}px`,
    });
    this.grid.replaceChildren(...charts.map((c) => c.el));
  }

  toggle(label, checked, onChange) {
    const btn = h('button', {
      class: `switch${checked ? ' on' : ''}`,
      role: 'switch',
      'aria-checked': String(checked),
      'aria-label': label,
      onclick: () => onChange(!checked),
    });
    this.extra.replaceChildren(h('div', { class: 'switch-wrap' }, [h('p', { text: label }), btn]));
  }
}

class CpuWidget extends HardwareWidget {
  constructor(card) {
    super(card, { key: 'cpu', heading: 'Processor', iconName: 'mdi:cpu-64-bit', color: card.colors.cpu });
    const o = this.override;
    const d = this.info.cpu ?? {};
    const frequency = o.cpu_frequency ?? d.frequency;
    this.renderInfos(
      toInfoTable(this.config.cpu_label_list, {
        brand: { label: 'Brand', value: o.cpu_brand ?? d.brand },
        model: { label: 'Model', value: o.cpu_model ?? d.model },
        cores: { label: 'Cores', value: o.cpu_cores ?? d.cores },
        threads: { label: 'Threads', value: o.cpu_threads ?? d.threads },
        frequency: { label: 'Frequency', value: frequency ? `${frequency} GHz` : '' },
      }),
      7,
    );
    this.multi = null;
  }

  get multiView() {
    if (this.graph) return this.graph.multiView;
    const mode = this.config.cpu_cores_toggle_mode;
    if (mode === 'multi-core') return true;
    if (mode === 'average') return false;
    return this.card.getSetting('multiCore', this.card.config.multi_core ?? false);
  }

  buildCharts(cores) {
    const multi = this.multiView;
    if (!this.graph && (this.config.cpu_cores_toggle_mode === 'toggle' || !this.config.cpu_cores_toggle_mode)) {
      this.toggle('Show All Cores', multi, (v) => {
        this.card.setSetting('multiCore', v);
        this.multi = null;
        this.update();
      });
    }
    const format = (v) => `${fixed(v)} %`;
    const color = this.card.colors.cpu;
    if (multi) {
      const columns = getColumnsForCores(cores);
      this.setGrid(
        Array.from({ length: cores }, (_, i) =>
          this.chart({
            color,
            format,
            edges: [i === 0, i === columns - 1, i === cores - 1, i === cores - columns],
          }),
        ),
        { columns, gap: 8 },
      );
    } else {
      this.setGrid([this.chart({ color, format })]);
    }
    this.multi = multi;
    this.cores = cores;
  }

  update() {
    const load = this.card.dd.history.cpu ?? [];
    const cores = load.at(-1)?.length ?? 1;
    if (this.multi !== this.multiView || this.cores !== cores) this.buildCharts(cores);

    if (this.multi) {
      this.charts.forEach((chart, i) => {
        chart.set(load.map((sample) => sample.find((c) => c.core === i)?.load ?? sample[i]?.load ?? 0));
      });
      return;
    }

    const avg = load.map((sample) => sample.reduce((a, c) => a + c.load, 0) / (sample.length || 1));
    const chart = this.charts[0];
    chart.set(avg);

    let right;
    const latest = load.at(-1) ?? [];
    if (this.config.enable_cpu_temps && latest.length) {
      const temps = latest.map((c) => c.temp ?? 0);
      const t = this.config.cpu_temps_mode === 'max' ? Math.max(...temps) : temps.reduce((a, b) => a + b, 0) / temps.length;
      right = this.config.use_imperial ? `${fixed(celsiusToFahrenheit(t))} °F` : `${fixed(t)} °C`;
    }
    chart.setTexts(this.showPercentages ? `%: ${fixed(avg.at(-1))}` : '', right);
  }
}

class RamWidget extends HardwareWidget {
  constructor(card) {
    super(card, { key: 'ram', heading: 'Memory', iconName: 'mdi:memory', color: card.colors.ram });
    const o = this.override;
    const d = this.info.ram ?? {};
    const layout = d.layout ?? [];
    const brands = unique(o.ram_brand ? [o.ram_brand] : layout.map((l) => l.brand));
    const types = unique(o.ram_type ? [o.ram_type] : layout.map((l) => l.type));
    const freqs = unique(o.ram_frequency ? [o.ram_frequency] : layout.map((l) => l.frequency).filter((f) => f)).map((f) => `${f} MHz`);
    this.size = d.size;
    this.renderInfos(
      toInfoTable(this.config.ram_label_list, {
        brand: { label: brands.length > 1 ? 'Brands' : 'Brand', value: brands.join(', ') },
        size: { label: 'Size', value: (o.ram_size ?? d.size) ? bytePrettyPrint(o.ram_size ?? d.size) : '' },
        type: { label: types.length > 1 ? 'Types' : 'Type', value: types.join(', ') },
        frequency: { label: freqs.length > 1 ? 'Frequencies' : 'Frequency', value: freqs.join(', ') },
      }),
      7,
    );
    this.setGrid([this.chart({ color: card.colors.ram, format: (v) => `${fixed(v)} %` })]);
  }

  update() {
    const load = this.card.dd.history.ram ?? [];
    const pct = load.map((b) => (b / (this.size || 1)) * 100);
    const chart = this.charts[0];
    chart.set(pct);
    chart.setTexts(this.showPercentages ? `%: ${fixed(pct.at(-1))} (${bytePrettyPrint(load.at(-1) ?? 0)})` : '');
  }
}

const ENGINE_GRID_LAYOUTS = {
  2: { template: '1fr 1fr' },
  3: { template: '1fr 1fr 1fr' },
  4: { template: '1fr 1fr', rows: 2 },
  5: { template: '2fr 1fr 1fr', rows: 2 },
};

class GpuWidget extends HardwareWidget {
  constructor(card) {
    super(card, { key: 'gpu', heading: 'Graphics', iconName: 'mdi:expansion-card', color: card.colors.gpu });
    const o = this.override;
    const infos = (this.info.gpu?.layout ?? []).flatMap((gpu, i) => {
      const memory = o.gpu_memories?.[i] ?? gpu.memory;
      return toInfoTable(this.config.gpu_label_list, {
        brand: { label: 'Brand', value: o.gpu_brands?.[i] ?? gpu.brand },
        model: { label: 'Model', value: o.gpu_models?.[i] ?? gpu.model },
        memory: { label: 'Memory', value: memory ? bytePrettyPrint(memory * 1024 * 1024) : memory },
      });
    });
    // one page per GPU
    this.renderInfos(infos, Math.max(1, this.config.gpu_label_list?.length ?? 3), () => this.update());
  }

  update() {
    const load = this.card.dd.history.gpu ?? [];
    const idx = this.page;
    const engines = load.at(-1)?.layout?.[idx]?.engines;
    const names = engines ? Object.keys(engines) : [];
    const color = this.card.colors.gpu;
    const format = (v) => `${fixed(v)} %`;
    const filter = this.graph?.filter;
    const key = `${idx}:${names.join(',')}:${filter ?? ''}`;

    if (names.length) {
      const featured = names.length === 5 ? (names.includes('Video') ? 'Video' : names[0]) : null;
      const sorted = featured ? [featured, ...names.filter((n) => n !== featured)] : names;
      if (this.engineKey !== key) {
        const charts = sorted.map((name, i) => {
          const isFeatured = i === 0 && featured !== null;
          const c = this.chart({ color, format, small: !isFeatured });
          if (isFeatured) c.el.style.gridRow = 'span 2';
          c.name = name;
          return c;
        });
        if (filter) {
          // dashdot shows only the primary engine when filtered
          this.setGrid([charts[0]], { columns: 1 });
        } else {
          this.setGrid(charts, ENGINE_GRID_LAYOUTS[sorted.length] ?? { columns: sorted.length });
        }
        this.engineKey = key;
      }
      for (const chart of this.charts) {
        const values = load.map((l) => l.layout?.[idx]?.engines?.[chart.name] ?? 0);
        chart.set(values);
        chart.setTexts(this.showPercentages ? `%: ${fixed(values.at(-1))} (${chart.name})` : chart.name);
      }
      return;
    }

    if (this.engineKey !== key) {
      this.loadChart = filter === 'memory' ? null : this.chart({ color, format });
      this.memChart = filter === 'load' ? null : this.chart({ color, format });
      const charts = [this.loadChart, this.memChart].filter((c) => c);
      this.setGrid(charts, { columns: charts.length });
      this.engineKey = key;
    }
    const loads = load.map((l) => l.layout?.[idx]?.load ?? 0);
    const mems = load.map((l) => l.layout?.[idx]?.memory ?? 0);
    this.loadChart?.set(loads);
    this.loadChart?.setTexts(this.showPercentages ? `%: ${fixed(loads.at(-1))} (Load)` : '');
    this.memChart?.set(mems);
    this.memChart?.setTexts(`%: ${fixed(mems.at(-1))} (Memory)`);
  }
}

class NetworkWidget extends HardwareWidget {
  constructor(card) {
    super(card, { key: 'network', heading: 'Network', iconName: 'mdi:lan', color: card.colors.network });
    const o = this.override;
    const d = this.info.network ?? {};
    const asBytes = this.config.network_speed_as_bytes;
    this.speedUp = o.network_speed_up ?? d.speedUp;
    this.speedDown = o.network_speed_down ?? d.speedDown;
    const ifSpeed = o.network_interface_speed ?? d.interfaceSpeed;
    this.renderInfos(
      toInfoTable(this.config.network_label_list, {
        type: { label: 'Type', value: o.network_type ?? d.type },
        speed_up: { label: 'Speed (Up)', value: this.speedUp ? bpsPrettyPrint(this.speedUp, asBytes) : undefined },
        speed_down: { label: 'Speed (Down)', value: this.speedDown ? bpsPrettyPrint(this.speedDown, asBytes) : undefined },
        interface_speed: { label: 'Interface Speed', value: ifSpeed ? bpsPrettyPrint(ifSpeed * 1e6) : undefined },
        public_ip: { label: 'Public IP', value: o.network_public_ip ?? d.publicIp },
      }),
      7,
    );
    const format = (v) => bpsPrettyPrint((v ?? 0) * 8, asBytes);
    const filter = this.graph?.filter;
    this.upChart = filter === 'down' ? null : this.chart({ color: card.colors.network, format });
    this.downChart = filter === 'up' ? null : this.chart({ color: card.colors.network, format });
    const charts = [this.upChart, this.downChart].filter((c) => c);
    this.setGrid(charts, { columns: charts.length });
  }

  update() {
    const load = this.card.dd.history.network ?? [];
    const asBytes = this.config.network_speed_as_bytes;
    for (const [chart, key, speed, arrow] of [
      [this.upChart, 'up', this.speedUp, '↑'],
      [this.downChart, 'down', this.speedDown, '↓'],
    ]) {
      if (!chart) continue;
      const values = load.map((l) => l[key] ?? 0);
      const max = Math.max((speed ?? 0) / 8, ...values) || 1;
      chart.set(values, [max * -0.1, max * 1.1]);
      chart.setTexts(this.showPercentages ? `${arrow} ${bpsPrettyPrint((values.at(-1) ?? 0) * 8, asBytes)}` : '');
    }
  }
}

class StorageWidget extends HardwareWidget {
  constructor(card) {
    super(card, { key: 'storage', heading: 'Storage', iconName: 'mdi:harddisk', color: card.colors.storage });
    const o = this.override;
    this.entries = (this.info.storage ?? []).map((entry) => {
      const sizeDisk = entry.disks?.find((d) => o.storage_sizes?.[d.device] != null);
      return {
        ...entry,
        size: sizeDisk ? o.storage_sizes[sizeDisk.device] : entry.size,
        disks: (entry.disks ?? []).map((d) => ({
          ...d,
          brand: o.storage_brands?.[d.device] ?? d.brand,
          type: o.storage_types?.[d.device] ?? d.type,
        })),
      };
    });
    const labels = this.config.storage_label_list ?? [];
    const infos = this.entries.map((e) => ({
      label: e.virtual ? 'VIRT' : e.raidLabel ? `RAID${labels.includes('raid') ? `\n=> ${e.raidLabel}` : ''}` : 'Drive',
      value: [
        labels.includes('brand') || labels.includes('type')
          ? unique(e.disks.map((d) => [labels.includes('brand') ? d.brand : null, labels.includes('type') ? d.type : null].filter((x) => x).join(' '))).join(', ')
          : null,
        labels.includes('size') ? bytePrettyPrint(e.size ?? 0) : null,
      ]
        .filter((x) => x)
        .join('\n=> '),
    }));
    this.renderInfos(infos, this.config.storage_widget_items_per_page ?? 3, () => this.update());
    if (this.graph && !this.graph.multiView) {
      this.donut = new DonutChart({ color: card.colors.storage, ...card.chartStyle });
      this.setGrid([this.donut]);
    } else {
      this.bars = new BarChart(card.colors.storage);
      if (card.chartStyle.radius) this.bars.el.style.borderRadius = card.chartStyle.radius;
      this.setGrid([this.bars]);
    }
  }

  update() {
    const loads = this.card.dd.storage ?? [];
    if (this.donut) {
      // totals exclude virtual mounts, -1 means no mount was found
      let size = 0;
      let used = 0;
      this.entries.forEach((e, i) => {
        if (e.virtual || loads[i] === -1) return;
        size += e.size ?? 0;
        used += Math.max(0, loads[i] ?? 0);
      });
      this.donut.set(loads.length ? used : null, size, this.showPercentages && size ? `%: ${((used / size) * 100).toFixed(1)}` : '');
      return;
    }
    const perPage = this.graph ? this.entries.length : (this.config.storage_widget_items_per_page ?? 3);
    const start = this.graph ? 0 : this.page * perPage;
    this.bars.el.classList.toggle('loading', !loads.length);
    this.bars.set(
      this.entries.slice(start, start + perPage).map((e, i) => {
        const used = loads[start + i] ?? 0;
        const percent = e.size ? (used / e.size) * 100 : 0;
        return {
          used,
          size: e.size ?? 0,
          percent,
          label: `${percent.toFixed(1)} % · ${bytePrettyPrint(used)} / ${bytePrettyPrint(e.size ?? 0)}`,
        };
      }),
    );
  }
}

const osIcon = (os) => {
  const checks = [
    ['ubuntu', 'mdi:ubuntu'],
    ['debian', 'mdi:debian'],
    ['redhat', 'mdi:redhat'],
    ['fedora', 'mdi:fedora'],
    ['centos', 'mdi:centos'],
    ['linux', 'mdi:linux'],
    ['mac', 'mdi:apple'],
    ['osx', 'mdi:apple'],
    ['darwin', 'mdi:apple'],
    ['apple', 'mdi:apple'],
    ['win', 'mdi:microsoft-windows'],
  ];
  return checks.find(([k]) => os.includes(k))?.[1] ?? 'mdi:server';
};

class OsWidget {
  constructor(card) {
    this.card = card;
    const { config, info } = card.dd.static;
    const o = config.override ?? {};
    const os = info.os ?? {};
    this.config = config;
    this.osName = o.os ?? `${os.distro ?? ''} ${os.release ?? ''}`.trim();
    this.arch = o.arch ?? os.arch;
    this.version = os.dash_version;

    const heading = config.show_host && config.custom_host
      ? h('p', { class: 'os-heading' }, [h('span', { class: 'appendix', text: 'dash.' }), h('span', { class: 'server-name', text: config.custom_host })])
      : h('p', { class: 'os-heading' }, [h('span', { class: 'server-name standalone', text: 'dash.' })]);
    this.table = h('div', { class: 'os-table' });
    const bg = icon(osIcon((o.os ?? `${os.distro}${os.platform}`).toLowerCase()));
    bg.className = 'os-bg';
    this.el = card.pane('os', [h('div', { class: 'os' }, [heading, this.table, bg])]);
  }

  update() {
    const boot = this.card.dd.static.boot_time;
    const uptime = boot ? Date.now() / 1000 - boot : 0;
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeStr = (days ? `${days} days\n` : '') + (hours ? `${hours} hours\n` : '') + (minutes ? `${minutes} minutes` : '');
    const key = `${uptimeStr}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.table.replaceChildren(
      infoTable(
        toInfoTable(this.config.os_label_list, {
          os: { label: 'OS', value: this.osName },
          arch: { label: 'Arch', value: this.arch },
          up_since: { label: 'Up since', value: uptimeStr.trim() },
          dash_version: { label: 'Dash Version', value: this.version },
        }),
      ),
    );
  }
}

const WIDGETS = {
  os: OsWidget,
  cpu: CpuWidget,
  ram: RamWidget,
  gpu: GpuWidget,
  network: NetworkWidget,
  storage: StorageWidget,
};

// ---------------------------------------------------------------------------

const STYLE = `
:host {
  display: block;
  /* the icon and charts intentionally overhang their pane, like dashdot */
  padding: 10px 10px 10px 0;
  --dd-height: 360px;
}
p { margin: 0; }
.wrap { display: flex; flex-wrap: wrap; gap: 20px; }
.message {
  padding: 16px; border-radius: 25px; color: var(--dd-text);
  border: 1px solid color-mix(in srgb, var(--dd-text) 20%, transparent);
  background: color-mix(in srgb, var(--dd-surface) 27%, transparent);
}
.pane {
  position: relative; display: flex; box-sizing: border-box;
  flex-basis: 0; min-height: var(--dd-height); max-height: 500px;
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
  background-color: color-mix(in srgb, var(--dd-surface) 27%, transparent);
  border: 1px solid color-mix(in srgb, var(--dd-text) 20%, transparent);
  border-radius: 25px; color: var(--dd-text);
}
.pane.narrow { max-height: none; }
.pane.offline { opacity: 0.5; }

/* HardwareInfoContainer */
.hw { position: relative; display: flex; flex-direction: column; width: 100%; }
.icon {
  display: flex; align-items: center; justify-content: center;
  width: 100px; height: 100px; min-height: 100px;
  position: relative; top: -10px; left: 20px; border-radius: 10px;
  box-shadow: 13px 13px 35px 0 rgba(0, 0, 0, 0.15);
  color: var(--dd-text); --mdc-icon-size: 40px;
}
.content { display: flex; flex-direction: row; flex: 1 1 auto; min-height: 0; }
.narrow .content { flex-direction: column-reverse; padding: 20px 0; }
.info { display: flex; flex-direction: column; width: 300px; min-width: 300px; flex-grow: 0; }
.narrow .info { width: 100%; min-width: 0; }
.info-head { display: flex; justify-content: space-between; margin: 30px 30px 0 30px; }
.heading { font-size: 1.5rem; font-weight: bold; }
.controls { display: flex; gap: 15px; }
.arrow { all: unset; cursor: pointer; color: var(--dd-text); --mdc-icon-size: 20px; }
.table { display: table; padding: 30px 30px 15px 30px; }
.row { display: table-row; }
.label { display: table-cell; font-size: 0.8rem; padding: 0 15px 3px 0; line-height: 1.5; white-space: pre; }
.value { display: table-cell; font-size: 1rem; font-weight: bold; padding-bottom: 3px; line-height: 1.5; white-space: pre-wrap; }

/* WidgetSwitch */
.switch-wrap { position: absolute; right: 25px; top: 25px; z-index: 2; display: flex; align-items: center; gap: 15px; }
.switch {
  all: unset; cursor: pointer; position: relative; width: 44px; height: 22px; border-radius: 11px;
  background: color-mix(in srgb, var(--dd-text) 25%, transparent); transition: background 0.2s;
}
.switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
  background: #fff; transition: left 0.2s; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}
.switch.on { background: var(--dd-primary); }
.switch.on::after { left: 24px; }
.switch:focus-visible { outline: 2px solid var(--dd-primary); outline-offset: 2px; }

/* MultiChartContainer */
.charts { position: relative; flex: 1 1 auto; min-width: 0; }
.narrow .charts { height: 270px; flex: 0 0 auto; }
.grid {
  display: grid; position: absolute; height: 110%; width: 100%;
  bottom: -10px; right: -10px; z-index: 1; grid-auto-flow: row;
}
.narrow .grid { position: relative; height: 100%; bottom: 0; }

/* ChartContainer */
.chart {
  position: relative; display: flex; min-width: 0; min-height: 0;
  background-color: var(--dd-surface); align-items: center; justify-content: center;
  box-shadow: -13px -13px 35px 0 rgba(0, 0, 0, 0.15);
}
.clip { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; }
.clip svg { width: 100%; height: 100%; display: block; }
.stat {
  position: absolute; top: 0; margin-top: min(13%, 30px); z-index: 2; pointer-events: none;
  color: color-mix(in srgb, var(--dd-text) 67%, transparent); white-space: nowrap;
}
.stat.left { left: 0; margin-left: min(13%, 30px); }
.stat.right { right: 0; margin-right: min(13%, 30px); }
.stat.small { font-size: 0.8em; }
.stat:empty { display: none; }
.dot {
  display: none; position: absolute; width: 10px; height: 10px; border-radius: 50%;
  transform: translate(-50%, -50%); border: 2px solid var(--dd-surface); z-index: 3; pointer-events: none;
}
.tip {
  display: none; position: absolute; transform: translateX(-50%); z-index: 3; pointer-events: none;
  padding: 4px 8px; border-radius: 8px; white-space: nowrap; font-size: 0.85rem;
  background: var(--dd-surface); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
}
.loader { display: none; gap: 6px; }
.loading .loader { display: flex; }
.loading .clip, .loading .stat, .loading .dot, .loading .tip { display: none; }
.loader span {
  width: 12px; height: 12px; border-radius: 50%; background: var(--dd-background);
  animation: dd-beat 0.7s infinite linear;
}
.loader span:nth-child(2) { animation-delay: 0.35s; }
@keyframes dd-beat { 50% { transform: scale(0.75); opacity: 0.2; } }

/* Storage bars */
.bars { flex-direction: column; justify-content: center; align-items: stretch; gap: 12px; padding: 20px; border-radius: 25px; }
.bar { position: relative; height: 36px; border-radius: 10px; overflow: hidden;
  background: color-mix(in srgb, var(--dd-text) 10%, transparent); }
.bar-fill { height: 100%; border-radius: 10px; }
.bar-label { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); font-size: 0.85rem; white-space: nowrap; }

/* Single graph (dashdot iframe widgets) */
:host([graph]) { padding: 0; height: 100%; }
:host([graph]) .root { height: 100%; }
ha-card.graph-card {
  position: relative; display: block; box-sizing: border-box; overflow: hidden;
  height: var(--dd-graph-height, 100%); min-height: var(--dd-graph-min-height, 120px);
  color: var(--dd-text);
}
.graph-card.offline > * { opacity: 0.5; }
.graph-card > .graph, .graph-card > .message { position: absolute; inset: 0; }
.graph-card .grid { position: relative; height: 100%; width: 100%; bottom: auto; right: auto; }
.graph-card .chart { box-shadow: none; }
.graph-card .message { border: none; border-radius: 0; background: none; display: flex; align-items: center; justify-content: center; text-align: center; }
.donut { width: 100%; height: 100%; }

/* ServerWidget */
.os { position: relative; flex: 1; max-width: 100%; display: flex; flex-direction: column; padding: 25px; overflow: hidden; border-radius: 25px; }
.os-heading {
  width: 100%; margin-top: 31px; margin-bottom: 15px; display: flex; flex-flow: row wrap;
  justify-content: center; align-items: flex-end; column-gap: 15px; font-size: 2rem;
}
.appendix { font-size: 1.5rem; }
.server-name {
  font-weight: bold; text-decoration: underline; text-decoration-color: var(--dd-primary);
  position: relative; bottom: -3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.server-name.standalone { font-size: 3rem; margin-top: 18px; }
.os-table .table { width: 100%; box-sizing: border-box; padding: 15px 5px 5px 5px; }
.os-bg {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  --mdc-icon-size: 17rem; opacity: 0.05; pointer-events: none;
}
`;

class DashdotCard extends HTMLElement {
  static getStubConfig() {
    return {};
  }

  static getConfigElement() {
    return document.createElement('dashdot-card-editor');
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    this.root = h('div', { class: 'root' });
    this.shadowRoot.append(style, this.root);
    this.dd = null;
    this.widgets = [];
    this.resizeObserver = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const narrow = entry.contentRect.width < NARROW_WIDTH;
        if (entry.target.classList.contains('narrow') !== narrow) {
          entry.target.classList.toggle('narrow', narrow);
          changed = true;
        }
      }
      if (changed) this.updateWidgets();
    });
  }

  setConfig(rawConfig) {
    const config = normalizeConfig(rawConfig ?? {});
    if (config.widgets && !Array.isArray(config.widgets)) {
      throw new Error('widgets must be a list, e.g. [os, cpu, ram, gpu]');
    }
    const unknown = (config.widgets ?? []).filter((w) => !KNOWN_WIDGETS.includes(w));
    if (unknown.length) throw new Error(`Unknown widget(s): ${unknown.join(', ')}`);
    if (config.theme && !['auto', 'light', 'dark'].includes(config.theme)) {
      throw new Error('theme must be auto, light or dark');
    }
    // validate everything before touching any state
    const graph = this.parseGraph(config);
    const color = toColor(config.color, 'color');
    const surface = toColor(config.surface, 'surface');
    const chartStyle = graph
      ? {
          radius: toSize(config.innerRadius, 'innerRadius') ?? '10px',
          textSize: toSize(config.textSize, 'textSize') ?? '16px',
          textOffset: toSize(config.textOffset, 'textOffset') ?? '24px',
        }
      : {};
    const height = graph ? toSize(config.height, 'height') : undefined;

    const instanceChanged = this.config && this.config.instance !== config.instance;
    this.config = config;
    this.graph = graph;
    this.overrides = { color, surface };
    this.chartStyle = chartStyle;
    this.toggleAttribute('graph', !!graph);
    if (graph) {
      this.style.setProperty('--dd-graph-height', height ?? '100%');
      this.style.setProperty('--dd-graph-min-height', height ? '0' : '120px');
    } else {
      this.style.setProperty('--dd-height', `${Number(config.height) || 360}px`);
    }
    if (instanceChanged) this.resubscribe();
    else this.subscribe();
    this.rebuild();
  }

  parseGraph(config) {
    if (config.graph == null || config.graph === '') return null;
    const type = String(config.graph).toLowerCase();
    if (!GRAPHS.includes(type)) throw new Error(`graph must be one of ${GRAPHS.join(', ')}`);
    if (config.widgets) throw new Error('Use either graph (single graph) or widgets, not both');
    const filter = config.filter ? String(config.filter).toLowerCase() : undefined;
    if (filter && !(GRAPH_FILTERS[type] ?? []).includes(filter)) {
      throw new Error(
        GRAPH_FILTERS[type]
          ? `filter for ${type} must be ${GRAPH_FILTERS[type].join(' or ')}`
          : `filter is only supported for ${Object.keys(GRAPH_FILTERS).join(' and ')}`,
      );
    }
    return {
      type,
      filter,
      multiView: toBool(config.multiView),
      showPercentage: toBool(config.showPercentage ?? config.show_percentages),
      gap: toSize(config.gap, 'gap') ?? '12px',
    };
  }

  set hass(hass) {
    this._hass = hass;
    const dark = hass.themes?.darkMode ?? false;
    if (dark !== this.dark) {
      this.dark = dark;
      this.rebuild();
    }
    this.subscribe();
  }

  connectedCallback() {
    this.subscribe();
    clearInterval(this.tick);
    this.tick = setInterval(() => this.widgets.forEach((w) => w instanceof OsWidget && w.update()), 30000);
  }

  disconnectedCallback() {
    clearInterval(this.tick);
    this.unsubscribe();
  }

  getCardSize() {
    if (this.graph) return 3;
    return Math.max(1, this.widgetKeys().length) * 8;
  }

  getGridOptions() {
    if (this.graph) return { columns: 6, rows: 3, min_columns: 2, min_rows: 1 };
    return { columns: 'full', min_columns: 6, rows: 'auto' };
  }

  // ---- settings persisted per browser (like dashdot's localStorage) ------

  getSetting(key, fallback) {
    try {
      const v = localStorage.getItem(`dashdot-card:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  setSetting(key, value) {
    try {
      localStorage.setItem(`dashdot-card:${key}`, JSON.stringify(value));
    } catch {
      // storage unavailable, the setting just won't persist
    }
  }

  // ---- data -----------------------------------------------------------------

  async subscribe() {
    if (this.unsub || this.subscribing || !this._hass || !this.config || !this.isConnected) return;
    this.subscribing = true;
    clearTimeout(this.retry);
    const msg = { type: 'dashdot/subscribe' };
    if (this.config?.instance) msg.instance = this.config.instance;
    try {
      this.unsub = await this._hass.connection.subscribeMessage((m) => this.onMessage(m), msg);
      this.error = null;
      // The element might have been removed while we were waiting
      if (!this.isConnected) this.unsubscribe();
    } catch (err) {
      this.error = err?.message ?? String(err);
      this.dd = null;
      this.rebuild();
      this.retry = setTimeout(() => this.subscribe(), 10000);
    } finally {
      this.subscribing = false;
    }
  }

  unsubscribe() {
    clearTimeout(this.retry);
    const unsub = this.unsub;
    this.unsub = null;
    if (unsub) unsub().catch(() => {});
  }

  resubscribe() {
    this.unsubscribe();
    this.dd = null;
    this.subscribe();
  }

  onMessage(m) {
    if (m.reload) {
      // The integration was reloaded, the old subscription is dead.
      this.unsubscribe();
      this.dd = null;
      this.rebuild();
      this.retry = setTimeout(() => this.subscribe(), 3000);
      return;
    }

    if (m.history) {
      this.dd = { static: m.static, available: m.available, history: m.history, storage: m.storage };
      this.rebuild();
      return;
    }
    if (!this.dd) return;

    let rebuild = false;
    if (m.static) {
      const key = (st) => JSON.stringify([st.config, { ...st.info, os: { ...st.info?.os, uptime: 0 } }]);
      rebuild = key(m.static) !== key(this.dd.static);
      this.dd.static = m.static;
    }
    if (m.available !== undefined) {
      this.dd.available = m.available;
      this.root.querySelectorAll('.pane, .graph-card').forEach((p) => p.classList.toggle('offline', !m.available));
    }
    if (m.storage) this.dd.storage = m.storage;
    if (m.samples) {
      const cfg = this.dd.static.config;
      for (const [key, value] of Object.entries(m.samples)) {
        const max = cfg[`${key}_shown_datapoints`] ?? 20;
        const arr = (this.dd.history[key] ??= []);
        arr.push(value);
        if (arr.length > max) arr.splice(0, arr.length - max);
      }
    }
    if (rebuild) this.rebuild();
    else this.updateWidgets();
  }

  // ---- rendering --------------------------------------------------------

  get colors() {
    const theme = this.config?.theme ?? 'auto';
    const dark = theme === 'auto' ? this.dark : theme === 'dark';
    const colors = { ...PALETTES[dark ? 'dark' : 'light'] };
    const { color, surface } = this.overrides ?? {};
    if (color) {
      for (const key of ['primary', 'cpu', 'ram', 'storage', 'network', 'gpu']) colors[key] = color;
    }
    if (surface) colors.surface = surface;
    return colors;
  }

  widgetKeys() {
    const available = this.dd?.static?.config?.widget_list ?? [];
    const wanted = this.config?.widgets ?? available;
    return wanted.filter((w) => KNOWN_WIDGETS.includes(w));
  }

  pane(key, children) {
    const cfg = this.dd.static.config;
    const pane = h('div', { class: 'pane' }, children);
    pane.style.flexGrow = String(cfg[`${key}_widget_grow`] ?? 1);
    pane.style.minWidth = `min(${cfg[`${key}_widget_min_width`] ?? 350}px, 100%)`;
    if (!this.dd.available) pane.classList.add('offline');
    return pane;
  }

  rebuild() {
    if (!this.config) return;
    const c = this.colors;
    for (const [k, v] of Object.entries(c)) this.style.setProperty(`--dd-${k}`, v);

    this.resizeObserver.disconnect();
    this.widgets = [];

    if (!this.dd) {
      this.root.replaceChildren(
        h('div', { class: 'message', text: this.error ? `dash.: ${this.error}` : 'Connecting to dash.…' }),
      );
      return;
    }

    if (this.graph) {
      this.rebuildGraph();
      return;
    }

    const missing = (this.config.widgets ?? []).filter((w) => !this.dd.static.config.widget_list?.includes(w));
    for (const key of this.widgetKeys()) {
      if (missing.includes(key)) continue;
      try {
        this.widgets.push(new WIDGETS[key](this));
      } catch (err) {
        console.error(`dashdot-card: failed to build ${key} widget`, err);
      }
    }

    const children = this.widgets.map((w) => w.el);
    if (missing.length) {
      children.push(
        h('div', {
          class: 'message',
          text: `Not enabled in dashdot (DASHDOT_WIDGET_LIST): ${missing.join(', ')}`,
        }),
      );
    }
    this.root.replaceChildren(h('div', { class: 'wrap' }, children));
    for (const w of this.widgets) this.resizeObserver.observe(w.el);
    this.updateWidgets();
  }

  rebuildGraph() {
    const { type } = this.graph;
    const card = document.createElement('ha-card');
    card.className = 'graph-card';
    if (!this.dd.available) card.classList.add('offline');

    if (!this.dd.static.config.widget_list?.includes(type)) {
      card.append(h('div', { class: 'message', text: `${type} is not enabled in dashdot (DASHDOT_WIDGET_LIST)` }));
    } else {
      try {
        const widget = new WIDGETS[type](this);
        this.widgets.push(widget);
        card.append(widget.el);
      } catch (err) {
        console.error(`dashdot-card: failed to build ${type} graph`, err);
      }
    }
    this.root.replaceChildren(card);
    this.updateWidgets();
  }

  updateWidgets() {
    for (const w of this.widgets) {
      try {
        w.update();
      } catch (err) {
        console.error(`dashdot-card: failed to update widget`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal visual editor

class DashdotCardEditor extends HTMLElement {
  setConfig(config) {
    // expands a pasted iframe `query` into individual fields on the next edit
    this.config = normalizeConfig(config ?? {});
    this.render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      hass.connection
        .sendMessagePromise({ type: 'dashdot/instances' })
        .then((list) => {
          this.instances = list;
          this.render();
        })
        .catch(() => {});
    }
  }

  emit() {
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this.config }, bubbles: true, composed: true }));
  }

  set(key, value) {
    if (value === '' || value == null || value === false) delete this.config[key];
    else this.config[key] = value;
    this.emit();
  }

  select(key, options, fallback = '') {
    return h(
      'select',
      { onchange: (e) => this.set(key, e.target.value) },
      options.map(([value, label]) => {
        const o = h('option', { value, text: label });
        if (String(this.config[key] ?? fallback) === value) o.selected = true;
        return o;
      }),
    );
  }

  checkbox(key) {
    const box = h('input', { type: 'checkbox', onchange: (e) => this.set(key, e.target.checked) });
    box.checked = toBool(this.config[key]);
    return box;
  }

  // 'change' (not 'input') so re-rendering doesn't steal focus while typing
  text(key, placeholder) {
    const input = h('input', { type: 'text', placeholder, onchange: (e) => this.set(key, e.target.value.trim()) });
    input.value = this.config[key] ?? '';
    return input;
  }

  render() {
    if (!this.config) return;
    const row = (label, control) =>
      h('label', { style: { display: 'flex', gap: '12px', alignItems: 'center', margin: '8px 0' } }, [h('span', { text: label, style: { minWidth: '140px' } }), control]);
    const hint = (text) => h('div', { text, style: { opacity: 0.7, fontSize: '0.85em' } });

    const instance = this.select('instance', [
      ['', 'First configured'],
      ...(this.instances ?? []).map((i) => [this.config.instance === i.entry_id ? i.entry_id : i.title, i.title]),
    ]);

    const graph = this.config.graph ? String(this.config.graph).toLowerCase() : '';
    const mode = h(
      'select',
      {
        onchange: (e) => {
          // height means different things in the two modes, reset it too
          if (e.target.value === 'graph') {
            for (const k of ['widgets', 'show_percentages', 'multi_core', 'height']) delete this.config[k];
            this.config.graph = 'cpu';
          } else {
            for (const k of ['graph', 'multiView', 'filter', 'showPercentage', 'color', 'surface', 'innerRadius', 'gap', 'textSize', 'textOffset', 'height']) delete this.config[k];
          }
          this.emit();
        },
      },
      [
        ['widgets', 'Full widgets (like the dashdot page)'],
        ['graph', 'Single graph (like a dashdot iframe)'],
      ].map(([value, label]) => {
        const o = h('option', { value, text: label });
        o.selected = (graph ? 'graph' : 'widgets') === value;
        return o;
      }),
    );

    const rows = [row('Instance', instance), row('Mode', mode)];

    if (graph) {
      const graphSelect = h(
        'select',
        {
          onchange: (e) => {
            const next = e.target.value;
            this.config.graph = next;
            if (!(GRAPH_FILTERS[next] ?? []).includes(this.config.filter)) delete this.config.filter;
            if (next !== 'cpu' && next !== 'storage') delete this.config.multiView;
            this.emit();
          },
        },
        GRAPHS.map((g) => {
          const o = h('option', { value: g, text: g });
          o.selected = graph === g;
          return o;
        }),
      );
      rows.push(row('Graph', graphSelect));
      if (graph === 'cpu' || graph === 'storage') rows.push(row(graph === 'cpu' ? 'All cores' : 'Per drive', this.checkbox('multiView')));
      if (GRAPH_FILTERS[graph]) {
        rows.push(row('Filter', this.select('filter', [['', 'Show all'], ...GRAPH_FILTERS[graph].map((f) => [f, f])])));
      }
      rows.push(
        row('Show percentage', this.checkbox('showPercentage')),
        row('Theme', this.select('theme', [['auto', 'auto'], ['light', 'light'], ['dark', 'dark']], 'auto')),
        row('Color', this.text('color', 'widget default, e.g. ff526f')),
        row('Surface', this.text('surface', 'theme default, e.g. 000000')),
        row('Inner radius', this.text('innerRadius', '10px')),
        row('Gap', this.text('gap', '12px')),
        row('Text size', this.text('textSize', '16px')),
        row('Text offset', this.text('textOffset', '24px')),
        row('Height', this.text('height', 'fill grid cell, e.g. 150px')),
      );
    } else {
      const selected = this.config.widgets ?? [];
      const checks = h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: '12px' } },
        KNOWN_WIDGETS.map((w) => {
          const box = h('input', {
            type: 'checkbox',
            onchange: (e) => {
              const set = new Set(this.config.widgets ?? []);
              e.target.checked ? set.add(w) : set.delete(w);
              const list = KNOWN_WIDGETS.filter((k) => set.has(k));
              if (list.length) this.config.widgets = list;
              else delete this.config.widgets;
              this.emit();
            },
          });
          box.checked = selected.includes(w);
          return h('label', {}, [box, ` ${w}`]);
        }),
      );
      rows.push(
        row('Widgets', checks),
        hint('No widgets ticked = use DASHDOT_WIDGET_LIST'),
        row('Theme', this.select('theme', [['auto', 'auto'], ['light', 'light'], ['dark', 'dark']], 'auto')),
      );
    }

    this.replaceChildren(...rows);
  }
}

const ELEMENTS = { 'dashdot-card': DashdotCard, 'dashdot-card-editor': DashdotCardEditor };

// Home Assistant installs a scoped custom element registry polyfill that can
// replace window.customElements after this (early loaded) module has run,
// hiding definitions made before that. Re-define on the current registry
// until things settle. A fresh subclass is used for every define since a
// constructor can only be registered once.
const defineElements = () => {
  for (const [name, cls] of Object.entries(ELEMENTS)) {
    if (!window.customElements.get(name)) {
      window.customElements.define(name, class extends cls {});
    }
  }
};
defineElements();
let defineChecks = 0;
const defineTimer = setInterval(() => {
  defineElements();
  if (++defineChecks >= 120) clearInterval(defineTimer);
}, 500);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === 'dashdot-card')) {
  window.customCards.push({
    type: 'dashdot-card',
    name: 'dash.',
    description: 'dashdot server graphs, streamed through Home Assistant',
    preview: false,
  });
  console.info(`%c dash. card %c ${CARD_VERSION} `, 'background:#775a9e;color:#fff', '');
}

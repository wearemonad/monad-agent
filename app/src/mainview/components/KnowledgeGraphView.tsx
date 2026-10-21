import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { forceCollide, forceX, forceY } from "d3-force";
import ForceGraph2D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from "react-force-graph-2d";
import wikiLinkPlugin from "@flowershow/remark-wiki-link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FileText,
  Folder,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  SearchIcon,
  Sparkles,
  Waypoints,
  X,
} from "lucide-react";
import {
  entityKey,
  type GraphBackfillStatus,
  type GraphLinkView,
  type GraphNodeView,
  type KnowledgeGraphView as GraphView,
} from "../../shared/knowledgeGraph";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { carryLayout, popIn } from "../lib/graphLayout";
import { useResolvedScheme, useThemeId } from "../lib/theme";
import { api } from "../rpc";
import { SafeLink, safeMarkdownComponents } from "./safeMarkdown";

type Node = NodeObject<GraphNodeView>;
type Link = LinkObject<GraphNodeView, GraphLinkView>;
type RGB = readonly [number, number, number];

/** Canonical entity types and the theme token each is painted with. */
const TYPE_SWATCHES = [
  { group: "company", label: "Company", token: "--chart-1" },
  { group: "person", label: "Person", token: "--chart-2" },
  { group: "project", label: "Project", token: "--chart-4" },
  { group: "product", label: "Product", token: "--chart-3" },
  { group: "other", label: "Other", token: "--chart-5" },
] as const;
const UNTYPED = "";
const DOC_GROUP = "__doc";
/** Screen px kept clear at the canvas sides: about half a long label. */
const LABEL_MARGIN = 80;

type Palette = {
  types: Record<string, RGB>;
  untyped: RGB;
  docFill: RGB;
  ink: RGB;
  inkMuted: RGB;
  background: RGB;
  focus: RGB;
};

const rgba = ([r, g, b]: RGB, a = 1) => `rgba(${r},${g},${b},${a})`;

/** Theme tokens resolved to RGB the canvas can blend. Tokens are oklch(), and
 *  canvas color serialization varies by engine, so each is painted onto a 1×1
 *  canvas and read back as pixels — exact, and free to re-alpha later. */
function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const color = (token: string, fallback: RGB): RGB => {
    const value = css.getPropertyValue(token).trim();
    if (!ctx || !value) return fallback;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = rgba(fallback);
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a === 0 ? fallback : [r, g, b];
  };
  return {
    types: Object.fromEntries(
      TYPE_SWATCHES.map((s) => [s.group, color(s.token, [99, 102, 241])]),
    ),
    untyped: color("--muted-foreground", [140, 140, 150]),
    docFill: color("--muted", [60, 60, 70]),
    ink: color("--foreground", [240, 240, 245]),
    inkMuted: color("--muted-foreground", [150, 150, 160]),
    background: color("--background", [20, 20, 24]),
    focus: color("--primary", [99, 102, 241]),
  };
}

function nodeRGB(n: GraphNodeView, p: Palette): RGB {
  if (n.kind === "doc") return p.inkMuted;
  return n.group ? (p.types[n.group] ?? p.types.other) : p.untyped;
}

function legendGroup(n: GraphNodeView): string {
  return n.kind === "doc" ? DOC_GROUP : n.group || UNTYPED;
}

function nodeRadius(n: GraphNodeView): number {
  return n.kind === "entity"
    ? Math.min(11, 3.5 + Math.sqrt(n.degree) * 1.25)
    : 2.6 + Math.min(1.4, Math.sqrt(n.degree) * 0.3);
}

/** A link end: the id string as fetched, or the node object force-graph
 *  swaps in once the simulation starts. */
const linkEnd = (end: unknown): string =>
  typeof end === "object" && end !== null
    ? String((end as Node).id)
    : String(end);

/** A link end as a positioned node — force-graph swaps the fetched id string
 *  for the node object once the simulation starts; null before that. */
const endNode = (end: unknown): Node | null =>
  typeof end === "object" && end !== null ? (end as Node) : null;

/** Drop the YAML frontmatter and leading title from a preview — the panel
 *  already shows both. */
const previewBody = (md: string) =>
  md
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/^\s*#\s+[^\n]*\n/, "");

/** The graph node a [[wikilink]] target names — a doc by path / bare
 *  filename first, then an entity by name/alias (the index's own rules). */
function resolveWikiTarget(nodes: GraphNodeView[], target: string) {
  const t = target.replace(/#.*$/, "").trim();
  const key = entityKey(t);
  const file = t.toLowerCase().replace(/\.md$/, "");
  return (
    nodes.find((n) => {
      const p = n.path?.toLowerCase().replace(/\.md$/, "");
      return !!p && (p === file || p.split("/").pop() === file);
    }) ??
    nodes.find(
      (n) =>
        n.kind === "entity" &&
        (entityKey(n.label) === key ||
          n.aliases?.some((a) => entityKey(a) === key)),
    )
  );
}

/** Structural fingerprint — polling while the backfill runs only swaps the
 *  data (and restarts the layout) when the graph actually changed. */
const fingerprint = (v: GraphView) =>
  `${v.nodes.map((n) => `${n.id}|${n.group}|${n.path}|${n.degree}`).join(";")}#${v.links
    .map((l) => `${l.source}>${l.target}`)
    .join(";")}`;

/** Interactive view of ONE workspace's knowledge graph: entities and the
 *  docs that mention them, force-laid-out, with search, focus-on-hover and a
 *  detail panel. Remounted per workspace (keyed by the caller), so no state
 *  from one workspace's graph can carry into another's. */
export function KnowledgeGraphView({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<GraphView | null>(null);
  const [backfill, setBackfill] = useState<GraphBackfillStatus | null>(null);
  const [startError, setStartError] = useState("");
  const [loading, setLoading] = useState(false);
  const [includeDocs, setIncludeDocs] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [legendFocus, setLegendFocus] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<Node, Link> | undefined>(undefined);
  const fittedRef = useRef(false);
  const ticksRef = useRef(0);
  const printRef = useRef("");
  /** The previous layout's nodes by id — force-graph moves them in place, so
   *  this always holds where each node was last drawn. */
  const layoutRef = useRef(new Map<string, Node>());

  const scheme = useResolvedScheme();
  const themeId = useThemeId();
  // Re-read on theme/scheme change: the canvas can't follow CSS variables.
  // biome-ignore lint/correctness/useExhaustiveDependencies: theme changes are the trigger
  const palette = useMemo(readPalette, [scheme, themeId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.knowledgeGraph(workspaceId, includeDocs);
      setBackfill(res.backfill);
      const print = fingerprint(res);
      if (print !== printRef.current) {
        printRef.current = print;
        fittedRef.current = false;
        ticksRef.current = 0;
        setData(res);
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, includeDocs]);

  useEffect(() => {
    void load();
  }, [load]);

  // While the one-off linking pass runs, its edits land in knowledge/ doc by
  // doc — follow along.
  useEffect(() => {
    if (backfill?.state !== "running") return;
    const t = setInterval(() => void load(), 6_000);
    return () => clearInterval(t);
  }, [backfill?.state, load]);

  const startBackfill = async () => {
    setStartError("");
    const res = await api.graphBackfillStart(workspaceId);
    if (!res.ok) setStartError(res.error ?? "Couldn't start.");
    void load();
  };

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setSize({
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // force-graph mutates what it's given (positions; link ends become node
  // objects), so it gets its own copy and the fetched view stays pristine.
  // A refresh carries the last layout over and grows new nodes out of it
  // (a pop-in, unless reduced motion is on) instead of reshuffling the lot.
  const { graphData, born, carried } = useMemo(() => {
    const nodes = (data?.nodes ?? []).map((n) => ({ ...n })) as Node[];
    const prev = layoutRef.current;
    const added = carryLayout(prev, nodes, data?.links ?? []);
    const now = performance.now();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return {
      graphData: {
        nodes,
        links: (data?.links ?? []).map((l) => ({ ...l })) as Link[],
      },
      born: new Map(still ? [] : [...added].map((id) => [id, now])),
      carried: prev.size > 0,
    };
  }, [data]);

  useEffect(() => {
    layoutRef.current = new Map(graphData.nodes.map((n) => [String(n.id), n]));
  }, [graphData]);

  /** A node's entrance progress — scale and opacity, both 1 once settled. */
  const entrance = useCallback(
    (id: string) => popIn(born.get(id), performance.now()),
    [born],
  );

  const byId = useMemo(
    () => new Map(graphData.nodes.map((n) => [String(n.id), n])),
    [graphData],
  );

  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of data?.links ?? []) {
      if (!m.has(l.source)) m.set(l.source, new Set());
      if (!m.has(l.target)) m.set(l.target, new Set());
      m.get(l.source)?.add(l.target);
      m.get(l.target)?.add(l.source);
    }
    return m;
  }, [data]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(
      (data?.nodes ?? [])
        .filter(
          (n) =>
            n.label.toLowerCase().includes(q) ||
            n.aliases?.some((a) => a.toLowerCase().includes(q)),
        )
        .map((n) => n.id),
    );
  }, [data, query]);

  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    let pageless = 0;
    for (const n of data?.nodes ?? []) {
      const g = legendGroup(n);
      counts.set(g, (counts.get(g) ?? 0) + 1);
      if (n.kind === "entity" && !n.path) pageless++;
    }
    return { counts, pageless };
  }, [data]);

  // What's lit: the hovered/selected node and its neighbors, else a legend
  // group, else the search matches; null = everything at full strength.
  const focusId = hoverId ?? selectedId;
  const focus = useMemo(() => {
    if (focusId) return new Set([focusId, ...(neighbors.get(focusId) ?? [])]);
    if (legendFocus !== null)
      return new Set(
        (data?.nodes ?? [])
          .filter((n) => legendGroup(n) === legendFocus)
          .map((n) => n.id),
      );
    return matches;
  }, [focusId, neighbors, legendFocus, data, matches]);

  const focusRGB = useMemo(() => {
    const n = focusId ? byId.get(focusId) : undefined;
    return n ? nodeRGB(n, palette) : palette.focus;
  }, [focusId, byId, palette]);

  const selected = selectedId
    ? (data?.nodes.find((n) => n.id === selectedId) ?? null)
    : null;

  useEffect(() => {
    setPreview("");
    if (!selected?.path) return;
    let live = true;
    api
      .readKnowledge(selected.path, workspaceId)
      .then((r) => live && setPreview(previewBody(r.content).slice(0, 2_000)))
      .catch(() => live && setPreview(""));
    return () => {
      live = false;
    };
  }, [selected?.path, workspaceId]);

  // A selected node that vanished (docs toggled off) must not linger in the
  // panel.
  useEffect(() => {
    if (selectedId && data && !data.nodes.some((n) => n.id === selectedId))
      setSelectedId(null);
  }, [data, selectedId]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !data) return;
    const charge = fg.d3Force("charge") as unknown as {
      strength?: (v: number) => { distanceMax?: (v: number) => void };
    };
    charge?.strength?.(includeDocs ? -70 : -120)?.distanceMax?.(280);
    fg.d3Force("link")?.distance?.((l: Link) =>
      l.rel === "co-mentioned"
        ? 80
        : l.rel === "mentions"
          ? 38
          : l.rel === "links"
            ? 60
            : 55,
    );
    // Room around every node so discs and their labels don't pile up, plus a
    // gentle pull to the center so disconnected clusters stay in view.
    fg.d3Force(
      "collide",
      forceCollide<Node>(
        (n) => nodeRadius(n) + (n.kind === "entity" ? 10 : 6),
      ).iterations(3),
    );
    fg.d3Force("x", forceX(0).strength(0.05));
    fg.d3Force("y", forceY(0).strength(0.05));
    fg.d3ReheatSimulation();
  }, [data, includeDocs]);

  const selectNode = (id: string) => {
    setSelectedId(id);
    const n = byId.get(id);
    if (n?.x !== undefined && n.y !== undefined)
      fgRef.current?.centerAt(n.x, n.y, 450);
  };

  const zoomBy = (factor: number) => {
    const fg = fgRef.current;
    if (fg) fg.zoom(fg.zoom() * factor, 250);
  };

  /** Every node at least `dx`/`dy` px inside the canvas — a refresh that
   *  grew the graph in view leaves the camera where it is. */
  const allInView = (dx = 0, dy = dx) => {
    const fg = fgRef.current;
    if (!fg) return true;
    const a = fg.screen2GraphCoords(dx, dy);
    const b = fg.screen2GraphCoords(size.width - dx, size.height - dy);
    return graphData.nodes.every(
      (n) =>
        n.x !== undefined &&
        n.y !== undefined &&
        n.x >= a.x &&
        n.x <= b.x &&
        n.y >= a.y &&
        n.y <= b.y,
    );
  };

  const fit = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.zoomToFit(450, 64);
    // A small graph would otherwise fill the canvas with giant discs.
    setTimeout(() => {
      if (fg.zoom() > 2.6) fg.zoom(2.6, 250);
    }, 480);
  }, []);

  /** Dot grid in graph space: it pans and zooms with the content, and its
   *  spacing snaps to powers of two so the density stays even on screen. */
  const paintGrid = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number) => {
      const inv = ctx.getTransform().inverse();
      const a = inv.transformPoint(new DOMPoint(0, 0));
      const b = inv.transformPoint(
        new DOMPoint(ctx.canvas.width, ctx.canvas.height),
      );
      const step = 2 ** Math.round(Math.log2(24 / scale));
      const cols = (b.x - a.x) / step;
      const rows = (b.y - a.y) / step;
      if (cols * rows > 8_000) return;
      ctx.fillStyle = rgba(palette.ink, 0.07);
      const r = 0.9 / scale;
      for (let x = Math.floor(a.x / step) * step; x <= b.x; x += step)
        for (let y = Math.floor(a.y / step) * step; y <= b.y; y += step) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 2 * Math.PI);
          ctx.fill();
        }
    },
    [palette],
  );

  const paintNode = useCallback(
    (node: Node, ctx: CanvasRenderingContext2D, scale: number) => {
      const id = String(node.id);
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const hot = id === hoverId || id === selectedId;
      const pop = entrance(id);
      if (pop.scale <= 0) return;
      const r = nodeRadius(node) * (hot ? 1.15 : 1) * pop.scale;
      const lit = !focus || focus.has(id);
      const c = nodeRGB(node, palette);
      ctx.globalAlpha = (lit ? 1 : 0.13) * pop.alpha;
      if (node.kind === "doc") {
        ctx.beginPath();
        ctx.roundRect(x - r, y - r, r * 2, r * 2, r * 0.45);
        ctx.fillStyle = rgba(palette.docFill, 1);
        ctx.fill();
        ctx.lineWidth = 1 / scale;
        ctx.strokeStyle = rgba(palette.inkMuted, hot ? 0.95 : 0.55);
        ctx.stroke();
      } else {
        if (hot) {
          ctx.shadowColor = rgba(c, 0.6);
          ctx.shadowBlur = 18;
        }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 2 * Math.PI);
        // Referenced but not written up yet: a tinted disc, not a solid one.
        ctx.fillStyle = rgba(c, node.path ? 1 : 0.3);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (!node.path) {
          ctx.lineWidth = 1.2 / scale;
          ctx.strokeStyle = rgba(c, 0.9);
          ctx.stroke();
        }
      }
      if (id === selectedId) {
        ctx.beginPath();
        ctx.arc(x, y, r + 3.5 / scale, 0, 2 * Math.PI);
        ctx.lineWidth = 1.6 / scale;
        ctx.strokeStyle = rgba(palette.ink, 0.9);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
    [focus, palette, hoverId, selectedId, entrance],
  );

  /** Labels after all nodes, in priority order. Each tries four spots
   *  (below, above, right, left of its node) and takes the first that
   *  overlaps no placed label and no other node; a label with no free spot
   *  is culled rather than drawn over something. Sizes are constant on
   *  screen. */
  const paintLabels = useCallback(
    (ctx: CanvasRenderingContext2D, scale: number) => {
      type Box = { x: number; y: number; w: number; h: number };
      const rank = (n: Node) => {
        const id = String(n.id);
        if (id === selectedId) return 0;
        if (id === hoverId) return 1;
        if (focus?.has(id)) return 2;
        return 3;
      };
      const drawn = graphData.nodes.filter(
        (n) => n.x !== undefined && n.y !== undefined,
      );
      const entityLimit =
        scale < 0.7 ? 8 : scale < 1.2 ? 30 : Number.POSITIVE_INFINITY;
      const candidates = drawn
        .filter((n) =>
          focus ? rank(n) <= 2 : n.kind === "entity" || scale >= 3.4,
        )
        .sort(
          (a, b) =>
            rank(a) - rank(b) ||
            Number(b.kind === "entity") - Number(a.kind === "entity") ||
            b.degree - a.degree,
        );
      const pad = 2.5 / scale;
      const overlaps = (a: Box, b: Box) =>
        a.x - pad < b.x + b.w &&
        a.x + a.w + pad > b.x &&
        a.y - pad < b.y + b.h &&
        a.y + a.h + pad > b.y;
      const discs = drawn.map((n) => {
        const r = nodeRadius(n);
        return {
          id: String(n.id),
          box: { x: (n.x ?? 0) - r, y: (n.y ?? 0) - r, w: r * 2, h: r * 2 },
        };
      });
      const placed: Box[] = [];
      let entityLabels = 0;
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.lineJoin = "round";
      for (const n of candidates) {
        const r0 = rank(n);
        const { alpha } = entrance(String(n.id));
        if (alpha <= 0) continue;
        if (!focus && n.kind === "entity" && ++entityLabels > entityLimit)
          continue;
        const entity = n.kind === "entity";
        const fontPx = entity ? 12 : 10.5;
        ctx.font = `${entity ? 600 : 400} ${fontPx / scale}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
        const text = n.label.length > 30 ? `${n.label.slice(0, 29)}…` : n.label;
        const w = ctx.measureText(text).width;
        const h = (fontPx + 1) / scale;
        const cx = n.x ?? 0;
        const cy = n.y ?? 0;
        const gap = nodeRadius(n) + 3 / scale;
        const spots: Box[] = [
          { x: cx - w / 2, y: cy + gap, w, h },
          { x: cx - w / 2, y: cy - gap - h, w, h },
          { x: cx + gap, y: cy - h / 2, w, h },
          { x: cx - gap - w, y: cy - h / 2, w, h },
        ];
        const id = String(n.id);
        const free = (b: Box) =>
          !placed.some((p) => overlaps(b, p)) &&
          !discs.some((d) => d.id !== id && overlaps(b, d.box));
        // Selected/hovered always get a label, in the best spot available.
        const spot = spots.find(free) ?? (r0 <= 1 ? spots[0] : undefined);
        if (!spot) continue;
        placed.push(spot);
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 3.5 / scale;
        ctx.strokeStyle = rgba(palette.background, 0.85);
        ctx.strokeText(text, spot.x, spot.y);
        ctx.fillStyle = entity
          ? rgba(palette.ink, 0.95)
          : rgba(palette.inkMuted, 1);
        ctx.fillText(text, spot.x, spot.y);
        ctx.globalAlpha = 1;
      }
    },
    [graphData, focus, palette, hoverId, selectedId, entrance],
  );

  const paintHitArea = useCallback(
    (node: Node, color: string, ctx: CanvasRenderingContext2D) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, nodeRadius(node) + 4, 0, 2 * Math.PI);
      ctx.fill();
    },
    [],
  );

  const linkLit = (l: Link) =>
    !!focusId &&
    (linkEnd(l.source) === focusId || linkEnd(l.target) === focusId);

  /** How far from a node's center a line along (ux, uy) leaves its shape —
   *  the drawn radius for discs (outside the ring when selected), the square
   *  boundary for doc tiles. Lines and particles stop here, so nothing shows
   *  through a translucent page-less disc. */
  const edgeDistance = useCallback(
    (n: Node, ux: number, uy: number, scale: number) => {
      const id = String(n.id);
      const r =
        nodeRadius(n) *
        (id === hoverId || id === selectedId ? 1.15 : 1) *
        entrance(id).scale;
      const ring = id === selectedId ? (3.5 + 0.8) / scale : 0;
      return n.kind === "doc"
        ? r / Math.max(Math.abs(ux), Math.abs(uy), 1e-6) + ring
        : r + ring;
    },
    [hoverId, selectedId, entrance],
  );

  /** Links drawn edge to edge instead of center to center. */
  const paintLink = useCallback(
    (l: Link, ctx: CanvasRenderingContext2D, scale: number) => {
      const s = endNode(l.source);
      const t = endNode(l.target);
      if (!s || !t) return;
      const dx = (t.x ?? 0) - (s.x ?? 0);
      const dy = (t.y ?? 0) - (s.y ?? 0);
      const len = Math.hypot(dx, dy);
      if (!len) return;
      const ux = dx / len;
      const uy = dy / len;
      const from = edgeDistance(s, ux, uy, scale);
      const to = edgeDistance(t, -ux, -uy, scale);
      if (from + to >= len) return; // touching/overlapping — nothing between
      const lit = !!focusId && (s.id === focusId || t.id === focusId);
      // A link fades in with whichever end is newer.
      ctx.globalAlpha = Math.min(
        entrance(String(s.id)).alpha,
        entrance(String(t.id)).alpha,
      );
      ctx.strokeStyle = focusId
        ? lit
          ? rgba(focusRGB, 0.75)
          : rgba(palette.ink, 0.04)
        : rgba(palette.ink, l.rel === "co-mentioned" ? 0.1 : 0.14);
      ctx.lineWidth =
        ((lit ? 1.7 : 1) *
          (l.rel === "co-mentioned"
            ? 0.5 + Math.log2(1 + l.weight) * 0.5
            : 0.8)) /
        scale;
      ctx.setLineDash(l.rel === "co-mentioned" ? [3 / scale, 3 / scale] : []);
      ctx.beginPath();
      ctx.moveTo((s.x ?? 0) + ux * from, (s.y ?? 0) + uy * from);
      ctx.lineTo((t.x ?? 0) - ux * to, (t.y ?? 0) - uy * to);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    },
    [edgeDistance, focusId, focusRGB, palette, entrance],
  );

  /** Focus particles, skipped while they're inside either end's shape. */
  const paintParticle = useCallback(
    (
      x: number,
      y: number,
      l: Link,
      ctx: CanvasRenderingContext2D,
      scale: number,
    ) => {
      for (const end of [l.source, l.target]) {
        const n = endNode(end);
        if (!n) continue;
        const dx = x - (n.x ?? 0);
        const dy = y - (n.y ?? 0);
        const d = Math.hypot(dx, dy);
        if (d < edgeDistance(n, dx / (d || 1), dy / (d || 1), scale)) return;
      }
      ctx.fillStyle = rgba(focusRGB, 1);
      ctx.beginPath();
      ctx.arc(x, y, 1.2 / scale, 0, 2 * Math.PI);
      ctx.fill();
    },
    [edgeDistance, focusRGB],
  );

  // Wikilinks in the preview jump to their node; everything else keeps the
  // safe-markdown rules (no remote loads, https opens externally).
  const previewComponents: Components = {
    ...safeMarkdownComponents,
    a(props) {
      if (!String(props.className ?? "").includes("internal"))
        return <SafeLink {...props} />;
      const target = data
        ? resolveWikiTarget(data.nodes, String(props.href ?? ""))
        : undefined;
      // An unaliased [[file-slug]] reads better as the doc's title.
      const href = String(props.href ?? "");
      const text =
        target &&
        typeof props.children === "string" &&
        props.children.toLowerCase() === href.toLowerCase()
          ? target.label
          : props.children;
      return (
        // An anchor, not a button: buttons stay inline-block and break the
        // sentence around a long link.
        <a
          href={`#${href}`}
          aria-disabled={!target}
          className={cn(
            "underline-offset-2",
            target
              ? "text-primary hover:underline"
              : "text-muted-foreground no-underline cursor-default",
          )}
          onClick={(e) => {
            e.preventDefault();
            if (target) selectNode(target.id);
          }}
        >
          {text}
        </a>
      );
    },
  };

  const empty = data !== null && data.nodes.length === 0;
  const neighborNodes = selected
    ? [...(neighbors.get(selected.id) ?? [])]
        .map((id) => data?.nodes.find((n) => n.id === id))
        .filter((n): n is GraphNodeView => !!n)
        .sort(
          (a, b) =>
            Number(b.kind === "entity") - Number(a.kind === "entity") ||
            (b.date ?? "").localeCompare(a.date ?? "") ||
            a.label.localeCompare(b.label),
        )
    : [];

  const legendItems = [
    ...TYPE_SWATCHES.map((s) => ({
      group: s.group as string,
      label: s.label,
      rgb: palette.types[s.group],
    })),
    { group: UNTYPED, label: "Untyped", rgb: palette.untyped },
  ].filter((i) => legend.counts.has(i.group));

  return (
    <div className="space-y-3">
      <BackfillBanner
        status={backfill}
        error={startError}
        untypedShare={
          data?.stats.entities
            ? (legend.counts.get(UNTYPED) ?? 0) / data.stats.entities
            : 0
        }
        onStart={() => void startBackfill()}
      />

      <div className="flex flex-wrap items-center gap-3">
        <InputGroup className="max-w-64">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Find an entity or doc"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches?.size) {
                const first = data?.nodes.find((n) => matches.has(n.id));
                if (first) selectNode(first.id);
              }
              if (e.key === "Escape") setQuery("");
            }}
          />
          {matches && (
            <InputGroupAddon align="inline-end">
              <span className="text-xs tabular-nums text-muted-foreground">
                {matches.size}
              </span>
            </InputGroupAddon>
          )}
        </InputGroup>
        <div className="flex items-center gap-2">
          <Switch
            id="graph-docs"
            checked={includeDocs}
            onCheckedChange={setIncludeDocs}
          />
          <Label htmlFor="graph-docs" className="text-sm font-normal">
            Documents
          </Label>
        </div>
        <span className="flex-1 text-xs tabular-nums text-muted-foreground">
          {data &&
            `${data.stats.entities} entit${data.stats.entities === 1 ? "y" : "ies"}${
              includeDocs ? ` · ${data.stats.docs} docs` : ""
            } · ${data.stats.links} links`}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          title="Refresh from knowledge/"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <Spinner /> : <RefreshCw size={15} />}
        </Button>
      </div>

      <div className="flex h-[min(72vh,680px)] gap-3">
        <div
          ref={boxRef}
          className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-[radial-gradient(ellipse_at_center,var(--color-muted)_0%,transparent_75%)]"
        >
          {empty ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-8 text-center">
              <Waypoints size={22} className="text-muted-foreground" />
              <p className="text-sm font-medium">No entities yet</p>
              <p className="max-w-[44ch] text-[0.8125rem] text-muted-foreground">
                The graph builds itself from{" "}
                <span className="font-mono">knowledge/</span>: people and
                companies listed in a doc's{" "}
                <span className="font-mono">entities:</span> frontmatter,{" "}
                <span className="font-mono">[[wikilinks]]</span>, and pages in{" "}
                <span className="font-mono">knowledge/entities/</span>. Ingest a
                few files and they'll appear here.
              </p>
            </div>
          ) : (
            size.width > 0 && (
              <ForceGraph2D<GraphNodeView, GraphLinkView>
                ref={fgRef}
                width={size.width}
                height={size.height}
                graphData={graphData}
                backgroundColor="rgba(0,0,0,0)"
                nodeId="id"
                nodeLabel={() => ""}
                nodeCanvasObject={paintNode}
                nodePointerAreaPaint={paintHitArea}
                onRenderFramePre={paintGrid}
                onRenderFramePost={paintLabels}
                linkCanvasObjectMode={() => "replace"}
                linkCanvasObject={paintLink}
                linkDirectionalParticles={(l) => (linkLit(l) ? 2 : 0)}
                linkDirectionalParticleSpeed={0.006}
                linkDirectionalParticleCanvasObject={paintParticle}
                onNodeHover={(n) => {
                  setHoverId(n ? String(n.id) : null);
                  if (boxRef.current)
                    boxRef.current.style.cursor = n ? "pointer" : "";
                }}
                onNodeClick={(n) => selectNode(String(n.id))}
                onBackgroundClick={() => {
                  setSelectedId(null);
                  setLegendFocus(null);
                }}
                minZoom={0.25}
                maxZoom={8}
                // Pre-settling is for a fresh layout only: on a carried one it
                // would jump the existing nodes before the first frame.
                warmupTicks={carried ? 0 : 60}
                cooldownTicks={220}
                // New nodes push the layout outward while it settles: follow
                // them rather than leave labels cut off at the edge until
                // the engine stops. The margin fits a label centred under
                // its node.
                onEngineTick={() => {
                  if (!carried || fittedRef.current) return;
                  ticksRef.current += 1;
                  if (
                    ticksRef.current % 30 === 0 &&
                    !allInView(LABEL_MARGIN, 40)
                  )
                    fit();
                }}
                onEngineStop={() => {
                  if (fittedRef.current) return;
                  fittedRef.current = true;
                  if (!carried || !allInView(LABEL_MARGIN, 40)) fit();
                }}
              />
            )
          )}

          {!empty && data && (
            <>
              <div className="absolute bottom-3 left-3 flex max-w-[calc(100%-5rem)] flex-wrap items-center gap-1 rounded-xl border border-border/60 bg-background/75 p-1 text-[0.6875rem] shadow-sm backdrop-blur-md">
                {legendItems.map((i) => (
                  <LegendChip
                    key={i.group || "untyped"}
                    label={i.label}
                    count={legend.counts.get(i.group) ?? 0}
                    active={legendFocus === i.group}
                    onClick={() =>
                      setLegendFocus((g) => (g === i.group ? null : i.group))
                    }
                    swatch={
                      <span
                        className="size-2 rounded-full"
                        style={{ background: rgba(i.rgb) }}
                      />
                    }
                  />
                ))}
                {includeDocs && legend.counts.has(DOC_GROUP) && (
                  <LegendChip
                    label="Document"
                    count={legend.counts.get(DOC_GROUP) ?? 0}
                    active={legendFocus === DOC_GROUP}
                    onClick={() =>
                      setLegendFocus((g) =>
                        g === DOC_GROUP ? null : DOC_GROUP,
                      )
                    }
                    swatch={
                      <span
                        className="size-2 rounded-[2px] border"
                        style={{
                          background: rgba(palette.docFill),
                          borderColor: rgba(palette.inkMuted, 0.7),
                        }}
                      />
                    }
                  />
                )}
                {legend.pageless > 0 && (
                  <span
                    className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground"
                    title="Mentioned in docs but no knowledge/entities/ page yet"
                  >
                    <span
                      className="size-2 rounded-full border"
                      style={{
                        background: rgba(palette.untyped, 0.3),
                        borderColor: rgba(palette.untyped, 0.9),
                      }}
                    />
                    No page yet
                  </span>
                )}
                {!includeDocs && (
                  <span className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground">
                    <span className="w-3 border-t border-dashed border-current" />
                    Share a doc
                  </span>
                )}
              </div>

              <div className="absolute right-3 bottom-3 flex flex-col overflow-hidden rounded-xl border border-border/60 bg-background/75 shadow-sm backdrop-blur-md">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="rounded-none"
                  title="Zoom in"
                  onClick={() => zoomBy(1.4)}
                >
                  <Plus size={14} />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="rounded-none"
                  title="Zoom out"
                  onClick={() => zoomBy(1 / 1.4)}
                >
                  <Minus size={14} />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="rounded-none border-t border-border/60"
                  title="Fit to view"
                  onClick={fit}
                >
                  <Maximize2 size={13} />
                </Button>
              </div>
            </>
          )}
        </div>

        {selected && (
          <aside className="w-72 shrink-0 overflow-y-auto rounded-xl border border-border p-4">
            <div className="flex items-start gap-2">
              <span
                className={cn(
                  "mt-1.5 size-2.5 shrink-0",
                  selected.kind === "doc"
                    ? "rounded-[3px] border"
                    : "rounded-full",
                  selected.kind === "entity" && !selected.path && "border",
                )}
                style={
                  selected.kind === "doc"
                    ? {
                        background: rgba(palette.docFill),
                        borderColor: rgba(palette.inkMuted, 0.7),
                      }
                    : {
                        background: rgba(
                          nodeRGB(selected, palette),
                          selected.path ? 1 : 0.3,
                        ),
                        borderColor: rgba(nodeRGB(selected, palette)),
                      }
                }
              />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-semibold leading-snug">
                  {selected.label}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">
                    {selected.kind === "doc"
                      ? "document"
                      : selected.group || "untyped"}
                  </Badge>
                  {selected.date && (
                    <span className="text-[0.6875rem] text-muted-foreground">
                      {selected.kind === "doc"
                        ? selected.date
                        : `last mentioned ${selected.date}`}
                    </span>
                  )}
                </div>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                title="Close"
                onClick={() => setSelectedId(null)}
              >
                <X size={15} />
              </Button>
            </div>

            {(selected.aliases?.length || selected.crmId) && (
              <dl className="mt-3 space-y-1 text-[0.75rem]">
                {selected.aliases?.length ? (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-muted-foreground">Also</dt>
                    <dd className="min-w-0">{selected.aliases.join(", ")}</dd>
                  </div>
                ) : null}
                {selected.crmId && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-muted-foreground">CRM</dt>
                    <dd
                      className="min-w-0 truncate font-mono"
                      title={selected.crmId}
                    >
                      {selected.crmId}
                    </dd>
                  </div>
                )}
              </dl>
            )}

            {selected.path ? (
              <>
                <p
                  className="mt-3 truncate font-mono text-[0.6875rem] text-muted-foreground"
                  title={`knowledge/${selected.path}`}
                >
                  knowledge/{selected.path}
                </p>
                {preview && (
                  <div className="prose prose-sm mt-2 max-h-56 max-w-none overflow-y-auto rounded-lg bg-muted/40 p-3 text-[0.75rem] prose-headings:mt-3 prose-headings:mb-1 prose-headings:text-[0.8125rem] prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0.5">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, wikiLinkPlugin]}
                      components={previewComponents}
                    >
                      {preview}
                    </ReactMarkdown>
                  </div>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  onClick={() =>
                    selected.path &&
                    void api.revealKnowledge(selected.path, workspaceId)
                  }
                >
                  <Folder size={14} /> Reveal in Finder
                </Button>
              </>
            ) : (
              <p className="mt-3 text-[0.75rem] text-muted-foreground">
                Mentioned in docs but has no page yet. The agent creates{" "}
                <span className="font-mono">knowledge/entities/</span> pages —
                with type, aliases and CRM id — for recurring entities.
              </p>
            )}

            {neighborNodes.length > 0 && (
              <div className="mt-4">
                <p className="mb-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                  Connections · {neighborNodes.length}
                </p>
                <ul className="space-y-0.5">
                  {neighborNodes.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[0.8125rem] hover:bg-muted/60"
                        onClick={() => selectNode(n.id)}
                        onMouseEnter={() => setHoverId(n.id)}
                        onMouseLeave={() => setHoverId(null)}
                      >
                        {n.kind === "doc" ? (
                          <FileText
                            size={13}
                            className="shrink-0 text-muted-foreground"
                          />
                        ) : (
                          <span
                            className={cn(
                              "size-2.5 shrink-0 rounded-full",
                              !n.path && "border",
                            )}
                            style={{
                              background: rgba(
                                nodeRGB(n, palette),
                                n.path ? 1 : 0.3,
                              ),
                              borderColor: rgba(nodeRGB(n, palette)),
                            }}
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {n.label}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

function LegendChip({
  label,
  count,
  active,
  onClick,
  swatch,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  swatch: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={active ? "Show everything" : `Highlight ${label.toLowerCase()}`}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-2 py-1 transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {swatch}
      {label}
      <span className="tabular-nums opacity-60">{count}</span>
    </button>
  );
}

/** Status of the one-off pass that links pre-graph knowledge (entity pages,
 *  types, [[links]]). Quiet once it's done; loud only when it needs a hand. */
function BackfillBanner({
  status,
  error,
  untypedShare,
  onStart,
}: {
  status: GraphBackfillStatus | null;
  error: string;
  untypedShare: number;
  onStart: () => void;
}) {
  if (!status || status.state === "empty") return null;
  if (status.state === "running")
    return (
      <Alert variant="info">
        <Spinner />
        <AlertTitle>Connecting existing knowledge to the graph</AlertTitle>
        <AlertDescription>
          Monad is creating entity pages (types, aliases, CRM ids) and adding
          links to your docs. The graph updates as it goes; every change lands
          in the review queue, where rejecting an edit restores the original.
        </AlertDescription>
      </Alert>
    );
  if (status.state === "failed" || error)
    return (
      <Alert variant="destructive">
        <Sparkles />
        <AlertTitle>Linking existing knowledge didn't finish</AlertTitle>
        <AlertDescription>
          {error || status.error || "The run stopped with an error."} Anything
          it already changed is in the review queue.
        </AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={onStart}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    );
  if (status.state === "pending" || status.state === "stopped")
    return (
      <Alert>
        <Sparkles />
        <AlertTitle>
          {status.state === "stopped"
            ? "Linking existing knowledge was stopped"
            : "Existing knowledge isn't connected yet"}
        </AlertTitle>
        <AlertDescription>
          Entity types, aliases and CRM ids come from entity pages, which older
          docs don't have. Monad links them automatically shortly after launch,
          or start it now. Changes go to the review queue.
        </AlertDescription>
        <AlertAction>
          <Button size="sm" onClick={onStart}>
            Connect now
          </Button>
        </AlertAction>
      </Alert>
    );
  // Done: one quiet line — plus a nudge if most entities are still untyped.
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Sparkles size={13} />
      <span className="flex-1">
        Existing knowledge linked
        {status.finishedAt &&
          ` ${new Date(status.finishedAt).toLocaleDateString()}`}
        {status.reviewCount
          ? ` · ${status.reviewCount} change(s) sent to review`
          : ""}
        {untypedShare > 0.5 && " · most entities are still untyped"}
      </span>
      <Button size="xs" variant="ghost" onClick={onStart}>
        Run again
      </Button>
    </div>
  );
}

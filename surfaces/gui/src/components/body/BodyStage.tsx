import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BodyParameter, BodyRender, BodyTopology } from "../../api";
import { GridLines } from "@arwes/react-bgs";
import { FrameCorners } from "@arwes/react-frames";
import { GarmentFallback, type AtlasView } from "./GarmentPlate";
import { Hologram, type BodyPreview } from "./hologram";
import { decodeBase64 } from "./values";

const LABEL_HEIGHT = 46;
const LABEL_GAP = 6;
const MARGIN_TOP = 138;
const MARGIN_BOTTOM = 22;
const NARROW = 1320;

const floats = (text: string) => new Float32Array(decodeBase64(text).buffer);

/** Places each column's labels at their body height, then pushes them apart without reordering. */
export function layoutColumn(desired: { id: string; y: number }[], top: number, bottom: number, height = LABEL_HEIGHT, gap = LABEL_GAP) {
  const order = [...desired].sort((a, b) => a.y - b.y);
  const ys = order.map(d => Math.min(Math.max(d.y - height / 2, top), bottom - height));
  for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + height + gap);
  const overflow = ys.length ? ys[ys.length - 1] + height - bottom : 0;
  if (overflow > 0) {
    ys[ys.length - 1] -= overflow;
    for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - height - gap);
  }
  return { positions: Object.fromEntries(order.map((d, i) => [d.id, ys[i]])), fits: ys.length === 0 || ys[0] >= top - 0.5 };
}

export function BodyStage({
  parameters,
  view,
  loadingText,
  topology,
  render,
  ghost,
  ghostChanges,
  focus,
  selected,
  label,
  details,
  landmarks,
  onSelect,
  onHover,
  onDismiss,
  children,
}: {
  parameters: BodyParameter[];
  view: AtlasView;
  loadingText: string;
  topology: BodyTopology | null;
  render: BodyRender | null;
  ghost: BodyRender | null;
  ghostChanges: Record<string, number>;
  focus: string | null;
  selected: string | null;
  label: (p: BodyParameter, open: boolean) => ReactNode;
  details: ReactNode;
  landmarks: string[];
  onSelect: (id: string) => void;
  onHover: (pid: string | null) => void;
  onDismiss: () => void;
  children?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const hologram = useRef<Hologram | null>(null);
  const labels = useRef<Record<string, HTMLDivElement | null>>({});
  const tags = useRef<Record<string, HTMLButtonElement | null>>({});
  const lines = useRef<Record<string, SVGPathElement | null>>({});
  const dots = useRef<Record<string, SVGCircleElement | null>>({});
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [positions, setPositions] = useState<Record<string, number> | null>(null);
  const [crowded, setCrowded] = useState(false);
  const [preview, setPreview] = useState<BodyPreview>("loading");
  const showingModel = preview === "ready";
  const narrow = size.width > 0 && (size.width < NARROW || crowded || !showingModel);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  const showingModelRef = useRef(showingModel);
  showingModelRef.current = showingModel;
  const byId = useRef<Record<string, BodyParameter>>({});
  byId.current = Object.fromEntries(parameters.map(p => [p.id, p]));

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setSize({ width: node.clientWidth, height: node.clientHeight }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!viewport.current) return;
    let instance: Hologram;
    try {
      instance = new Hologram(viewport.current);
    } catch {
      setPreview("fallback");
      return;
    }
    hologram.current = instance;
    instance.onPreview = setPreview;
    instance.onFrame = () => drawLines(instance);
    return () => {
      instance.dispose();
      hologram.current = null;
    };
  }, []);

  useEffect(() => {
    if (!topology || !hologram.current) return;
    const masks = Object.fromEntries(Object.entries(topology.masks).map(([k, v]) => [k, decodeBase64(v)]));
    hologram.current.setTopology(new Uint32Array(decodeBase64(topology.faces).buffer), topology.vertex_count, masks, {
      uv: topology.uv ? floats(topology.uv) : undefined,
      faceUV: topology.face_uv ? new Uint32Array(decodeBase64(topology.face_uv).buffer) : undefined,
      baseVertices: topology.base_vertices ? new Uint32Array(decodeBase64(topology.base_vertices).buffer) : undefined,
    });
  }, [topology]);

  useLayoutEffect(() => {
    if (!render || !hologram.current) return;
    hologram.current.setBody(floats(render.vertices), render.geometry);
  }, [render]);

  const changeKey = JSON.stringify(ghostChanges);
  useEffect(() => {
    hologram.current?.setGhost(ghost ? floats(ghost.vertices) : null, ghostChanges);
    // ghostChanges is compared by value through changeKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghost, changeKey]);

  useEffect(() => {
    hologram.current?.setFocus(focus);
  }, [focus]);

  const selectedView = selected ? byId.current[selected]?.view ?? null : null;
  useEffect(() => {
    hologram.current?.setSelection(selected, selectedView);
  }, [selected, selectedView]);

  useLayoutEffect(() => {
    if (narrow && selected) labels.current[selected]?.scrollIntoView({ block: "nearest" });
  }, [narrow, selected]);

  useLayoutEffect(() => {
    const h = hologram.current;
    const node = stage.current;
    if (!h || !node || !showingModel || !size.width) return;
    const rect = node.getBoundingClientRect();
    const next: Record<string, number> = {};
    let fits = true;
    for (const column of ["left", "right"] as const) {
      const desired = parameters
        .filter(p => p.column === column)
        .map((p, i) => ({ id: p.id, y: (h.homeAnchor(p.id, column)?.y ?? rect.top + MARGIN_TOP + i * 50) - rect.top }));
      const result = layoutColumn(desired, MARGIN_TOP, size.height - MARGIN_BOTTOM);
      Object.assign(next, result.positions);
      fits &&= result.fits;
    }
    setPositions(next);
    setCrowded(!fits);
  }, [showingModel, size.width, size.height, parameters]);

  function drawLines(h: Hologram) {
    const node = stage.current;
    if (!node || !showingModelRef.current) return;
    const rect = node.getBoundingClientRect();
    const current = focusRef.current;
    for (const [pid, line] of Object.entries(lines.current)) {
      const tag = narrowRef.current && !current ? tags.current[pid] : null;
      const box = tag || labels.current[pid];
      const p = byId.current[pid];
      const dot = dots.current[pid];
      if (!line || !box || !p) continue;
      const visible = !narrowRef.current || pid === current || !!tag;
      const b = box.getBoundingClientRect();
      const left = tag ? tag.dataset.side === "left" : !narrowRef.current && p.column === "left";
      const sx = (left ? b.right : b.left) - rect.left;
      const sy = (tag ? b.top + b.height / 2 : Math.min(b.top + LABEL_HEIGHT / 2, b.bottom - 8)) - rect.top;
      const a = visible ? h.anchor(pid, left ? "left" : "right", { x: sx + rect.left, y: sy + rect.top }) : null;
      if (!a) {
        line.setAttribute("d", "");
        dot?.setAttribute("r", "0");
        continue;
      }
      const ax = a.x - rect.left;
      const ay = a.y - rect.top;
      const elbow = sx + (left ? 22 : -22);
      line.setAttribute("d", `M${sx.toFixed(1)},${sy.toFixed(1)} L${elbow.toFixed(1)},${sy.toFixed(1)} L${ax.toFixed(1)},${ay.toFixed(1)}`);
      dot?.setAttribute("cx", ax.toFixed(1));
      dot?.setAttribute("cy", ay.toFixed(1));
      dot?.setAttribute("r", pid === current ? "3.2" : "1.8");
    }
  }

  return (
    <div
      ref={stage}
      className={`body-stage${narrow ? " is-narrow" : ""}${selected ? " has-details" : ""}${focus ? " has-focus" : ""}`}
      onKeyDown={event => {
        if (event.key !== "Escape" || !selected) return;
        if (event.target instanceof HTMLElement && event.target.closest(".body-card")) {
          labels.current[selected]?.querySelector("button")?.focus({ preventScroll: true });
        }
        onDismiss();
      }}
    >
      <div className="atlas-grid" aria-hidden="true"><GridLines distance={28} lineColor="#86837b" horizontalLineDash={[]} verticalLineDash={[]}/></div>
      <div className="atlas-frame" aria-hidden="true"><FrameCorners animated={false} cornerLength={17} strokeWidth={1.3}/></div>
      <div
        ref={viewport}
        className="body-viewport"
        onPointerDown={event => { press.current = { x: event.clientX, y: event.clientY }; }}
        onPointerUp={event => {
          const start = press.current;
          press.current = null;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4) onDismiss();
        }}
      />
      {!showingModel && <GarmentFallback view={view} active={focus ? byId.current[focus] : undefined}
        message={preview === "fallback" ? "当前使用服装线稿，量体记录可继续编辑" : render ? "正在准备穿衣预览…" : loadingText}/>}
      <svg className="body-leaders" aria-hidden="true" style={{ visibility: showingModel ? undefined : "hidden" }}>
        {parameters.map(p => (
          <g key={p.id} className={`body-leader${p.id === focus ? " is-active" : ""} kind-${p.kind}`}>
            <path ref={el => { lines.current[p.id] = el; }} />
            <circle ref={el => { dots.current[p.id] = el; }} r="0" />
          </g>
        ))}
      </svg>
      {narrow && showingModel && !focus && <div className="atlas-tags">{landmarks.map((id, i) => {
        const p = byId.current[id];
        if (!p) return null;
        return <button type="button" key={id} ref={el => { tags.current[id] = el; }}
          data-side={i % 2 ? "right" : "left"} style={{ top: (17 + i * 19) + "%" }}
          onClick={() => onSelect(id)}>
          <small>{id}</small>{p.name.zh}
        </button>;
      })}</div>}
      {children}
      <div className={narrow ? "body-list" : "body-columns"}>
        {parameters.map(p => {
          const open = selected === p.id;
          const top = positions?.[p.id];
          return (
            <div
              key={p.id}
              ref={el => { labels.current[p.id] = el; }}
              className={`body-label column-${p.column}${open ? " is-active" : ""}`}
              style={narrow ? undefined : { top }}
              onPointerEnter={() => onHover(p.id)}
              onPointerLeave={() => onHover(null)}
              onFocus={event => { if (event.target.matches(":focus-visible")) onHover(p.id); }}
              onBlur={() => onHover(null)}
              data-testid={`body-label-${p.id}`}
            >
              {label(p, open)}
            </div>
          );
        })}
      </div>
      {details}
    </div>
  );
}

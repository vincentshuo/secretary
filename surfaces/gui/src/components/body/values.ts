import type { BodyEntry, BodyField, BodyParameter, BodyRender, BodyValues } from "../../api";

export const TEXT_KEYS = ["position", "note"] as const;
export const SIDE_LABEL: Record<string, string> = { L: "左", R: "右" };

export function decodeBase64(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export const bilateral = (p: BodyParameter) => p.fields[0]?.key === "left";

export function recorded(entry: BodyEntry | undefined, key: string): number | null {
  const v = entry?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export const hasRecord = (p: BodyParameter, entry: BodyEntry | undefined) =>
  p.fields.some(f => recorded(entry, f.key) !== null);

/** Parse what the person typed: null for blank, NaN for anything outside the field's range. */
export function parseField(field: BodyField, text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return null;
  if (!/^\d+(\.\d*)?$/.test(t)) return NaN;
  const v = Math.round(Number(t) * 10) / 10;
  return v >= field.min && v <= field.max ? v : NaN;
}

/** Immutable update; blank entries disappear so an unmeasured item never reads as zero. */
export function setEntry(values: BodyValues, pid: string, key: string, value: number | string | null): BodyValues {
  const entry: BodyEntry = { ...(values[pid] ?? {}) };
  if (value === null || value === "") delete entry[key];
  else entry[key] = value;
  const next = { ...values };
  const meaningful = Object.keys(entry).some(k => k !== "side");
  if (meaningful) next[pid] = entry;
  else delete next[pid];
  return next;
}

export type Reading = { key: string; label: string; value: number | null; source: "recorded" | "mirrored" | "inferred" | "none" };

/** What each field of a parameter shows: the recorded value, its mirror, or the body's inferred value. */
export function readings(p: BodyParameter, entry: BodyEntry | undefined, render: BodyRender | null, lang: "zh" | "en"): Reading[] {
  const measured = render?.measured[p.id] ?? {};
  return p.fields.map(f => {
    const label = f.label[lang];
    const own = recorded(entry, f.key);
    if (own !== null) return { key: f.key, label, value: own, source: "recorded" };
    if (bilateral(p)) {
      const other = recorded(entry, f.key === "left" ? "right" : "left");
      if (other !== null) return { key: f.key, label, value: other, source: "mirrored" };
      const side = f.key === "left" ? "L" : "R";
      if (measured[side] !== undefined) return { key: f.key, label, value: measured[side], source: "inferred" };
      return { key: f.key, label, value: null, source: "none" };
    }
    if (f.key === "value" && measured[""] !== undefined) return { key: f.key, label, value: measured[""], source: "inferred" };
    return { key: f.key, label, value: null, source: "none" };
  });
}

/** Largest gap between a recorded value and what the body can reach, when it is worth saying. */
export function shortfall(p: BodyParameter, render: BodyRender | null, threshold = 0.5) {
  const residual = render?.residual[p.id];
  if (!residual) return null;
  let worst: { side: string; gap: number; reached: number } | null = null;
  for (const [side, gap] of Object.entries(residual)) {
    if (Math.abs(gap) < threshold) continue;
    if (!worst || Math.abs(gap) > Math.abs(worst.gap)) worst = { side, gap, reached: render!.measured[p.id]?.[side] };
  }
  return worst;
}

export const formatCm = (v: number | null) => (v === null ? "—" : v.toFixed(1));

export function recordedCount(params: BodyParameter[], values: BodyValues) {
  return params.filter(p => hasRecord(p, values[p.id])).length;
}

/** Recorded values only: what a snapshot or the draft carries to the sidecar. */
export function sameValues(a: BodyValues, b: BodyValues) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}
function sortKeys(v: unknown): unknown {
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sortKeys((v as any)[k])]));
}

/** One series per field over dated snapshots, for the history curves. */
export function series(p: BodyParameter, snapshots: { measured_on: string; values: BodyValues }[]) {
  return p.fields.map(f => ({
    key: f.key,
    points: snapshots
      .map(s => ({ date: s.measured_on, value: recorded(s.values[p.id], f.key) }))
      .filter((x): x is { date: string; value: number } => x.value !== null),
  })).filter(s => s.points.length > 0);
}

/** How strongly each parameter changed between two recordings, 0–1, for the ghost comparison glow. */
export function changes(params: BodyParameter[], now: BodyValues, then: BodyValues): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of params) {
    let weight = 0;
    for (const f of p.fields) {
      const a = recorded(now[p.id], f.key);
      const b = recorded(then[p.id], f.key);
      if (a === null && b === null) continue;
      if (a === null || b === null) weight = Math.max(weight, 0.5);
      else if (Math.abs(a - b) >= 0.1) weight = Math.max(weight, Math.min(1, 0.3 + Math.abs(a - b) / 3));
    }
    if (weight > 0) out[p.id] = weight;
  }
  return out;
}

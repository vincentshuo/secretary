import { describe, expect, it } from "vitest";
import type { BodyParameter, BodyRender } from "../../api";
import { layoutColumn } from "./BodyStage";
import { standTo } from "./hologram";
import { changes, parseField, readings, series, setEntry, shortfall } from "./values";

const field = (key: string, min = 10, max = 200) => ({ key, label: { zh: key, en: key }, min, max, unit: "cm" });
const single = { id: "C08", name: { zh: "胸围", en: "Chest" }, fields: [field("value")] } as unknown as BodyParameter;
const paired = { id: "H09", name: { zh: "大腿", en: "Thigh" }, fields: [field("left"), field("right")] } as unknown as BodyParameter;
const render = (measured: BodyRender["measured"], residual: BodyRender["residual"] = {}) => ({ measured, residual }) as BodyRender;

describe("recorded values", () => {
  it("parses centimetres to 0.1 and rejects anything outside the field", () => {
    expect(parseField(field("value", 60, 160), " 101.26 ")).toBe(101.3);
    expect(parseField(field("value", 60, 160), "101,5")).toBe(101.5);
    expect(parseField(field("value", 60, 160), "61.")).toBe(61);
    expect(parseField(field("value", 60, 160), "")).toBeNull();
    expect(parseField(field("value", 60, 160), "12")).toBeNaN();
    expect(parseField(field("value", 60, 160), "1o1")).toBeNaN();
  });

  it("drops a parameter once it has nothing recorded, so blank never reads as zero", () => {
    const one = setEntry({}, "C08", "value", 101);
    expect(one).toEqual({ C08: { value: 101 } });
    expect(setEntry(one, "C08", "value", null)).toEqual({});
    expect(setEntry({ F13: { girth: 20, side: "R" } }, "F13", "girth", null)).toEqual({});
  });

  it("shows recorded, mirrored and inferred readings in that order of precedence", () => {
    const body = render({ H09: { L: 58.1, R: 58.3 }, C08: { "": 99.9 } });
    expect(readings(paired, { left: 60 }, body, "en").map(r => [r.value, r.source])).toEqual([[60, "recorded"], [60, "mirrored"]]);
    expect(readings(paired, undefined, body, "en").map(r => r.source)).toEqual(["inferred", "inferred"]);
    expect(readings(single, undefined, body, "en")[0]).toMatchObject({ value: 99.9, source: "inferred" });
    expect(readings(single, undefined, null, "en")[0].source).toBe("none");
  });

  it("reports only the largest gap the body cannot close", () => {
    const body = render({ H09: { L: 70, R: 64 } }, { H09: { L: -3, R: 0.2 } });
    expect(shortfall(paired, body)).toEqual({ side: "L", gap: -3, reached: 70 });
    expect(shortfall(paired, render({}, { H09: { L: 0.3 } }))).toBeNull();
  });

  it("weights changed parameters for the ghost comparison", () => {
    const now = { C08: { value: 104 }, H09: { left: 60 } };
    const then = { C08: { value: 100 }, H09: { left: 60 }, E01: { value: 90 } };
    const out = changes([single, paired, { ...single, id: "E01" }], now, then);
    expect(out.C08).toBe(1);
    expect(out.H09).toBeUndefined();
    expect(out.E01).toBe(0.5);
  });

  it("builds one dated series per recorded field", () => {
    const lines = series(paired, [
      { measured_on: "2026-01-01", values: { H09: { left: 60 } } },
      { measured_on: "2026-02-01", values: { H09: { left: 61, right: 62 } } },
    ]);
    expect(lines).toEqual([
      { key: "left", points: [{ date: "2026-01-01", value: 60 }, { date: "2026-02-01", value: 61 }] },
      { key: "right", points: [{ date: "2026-02-01", value: 62 }] },
    ]);
  });
});

describe("label layout", () => {
  it("keeps body order and pushes labels apart without overlap", () => {
    const { positions, fits } = layoutColumn([{ id: "b", y: 200 }, { id: "a", y: 100 }, { id: "c", y: 205 }], 0, 1000, 40, 4);
    expect(fits).toBe(true);
    expect(positions.a).toBeLessThan(positions.b);
    expect(positions.c - positions.b).toBeGreaterThanOrEqual(44);
  });

  it("shifts up from the bottom and reports when a column cannot fit", () => {
    const crowded = layoutColumn(Array.from({ length: 4 }, (_, i) => ({ id: String(i), y: 190 })), 0, 200, 40, 4);
    expect(crowded.positions["3"]).toBe(160);
    expect(crowded.positions["0"]).toBe(28);
    expect(crowded.fits).toBe(true);
    expect(layoutColumn(Array.from({ length: 6 }, (_, i) => ({ id: String(i), y: 100 })), 0, 200, 40, 4).fits).toBe(false);
  });
});

describe("ghost alignment", () => {
  it("stands an earlier body on the same floor at the current height", () => {
    const earlier = new Float32Array([0, 0.1, 0, 1, 1.9, 2]);
    const current = new Float32Array([0, 0, 0, 1, 1.75, 2]);
    expect(Array.from(standTo(earlier, current))).toEqual([0, 0, 0, 1, 1.75, 2]);
  });
});

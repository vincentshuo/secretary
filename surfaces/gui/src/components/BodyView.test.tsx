import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BodyCatalog, BodyRender, BodySnapshot } from "../api";

const api = vi.hoisted(() => ({
  getBodyCatalog: vi.fn(),
  getBodyStatus: vi.fn(),
  getBodyTopology: vi.fn(),
  fitBody: vi.fn(),
  getBodyProfile: vi.fn(),
  saveBodyDraft: vi.fn(),
  createBodySnapshot: vi.fn(),
  reviseBodySnapshot: vi.fn(),
  deleteBodySnapshot: vi.fn(),
  getBodyRevisions: vi.fn(),
  getSnapshotBody: vi.fn(),
  downloadBodyExport: vi.fn(),
}));
vi.mock("../api", () => api);

const hologram = vi.hoisted(() => ({ focus: [] as (string | null)[], ghosts: [] as (Record<string, number> | null)[] }));
vi.mock("./body/hologram", () => ({
  Hologram: class {
    canvas = document.createElement("canvas");
    onFrame = null;
    setTopology() {}
    setBody() {}
    setGhost(v: Float32Array | null, changed: Record<string, number>) { hologram.ghosts.push(v ? changed : null); }
    setFocus(pid: string | null) { hologram.focus.push(pid); }
    anchor() { return null; }
    homeAnchor() { return null; }
    dispose() {}
  },
}));

import { BodyView } from "./BodyView";

const field = (key: string) => ({ key, label: { zh: key, en: key === "value" ? "Value" : key }, min: 40, max: 160, unit: "cm" });
const catalog: BodyCatalog = {
  parameters: [
    { id: "C08", name: { zh: "胸围", en: "Chest girth" }, as_needed: false, kind: "drive", group: "torso", column: "left", view: "front", fields: [field("value")], how: "经胸部最丰满处水平绕一圈。", use: "上衣选码。", categories: [], landmarks: [], model: "水平截面。" },
    { id: "H09", name: { zh: "大腿最大围", en: "Fullest thigh girth" }, as_needed: true, kind: "drive", group: "leg", column: "left", view: "front", fields: [field("left"), field("right")], how: "单腿最丰满处。", use: "裤子。", categories: [], landmarks: [], model: "垂直于大腿轴线。" },
  ],
  landmarks: {},
  rules: ["自然站立。"],
  compare: ["测身体还是成衣？"],
  source: "test",
};
const body: BodyRender = { fitter: "test", vertices: "", bounds: { min: [0, 0, 0], max: [1, 1, 1] }, measured: { C08: { "": 98.6 }, H09: { L: 55.2, R: 55.4 } }, residual: {}, geometry: {} };
const snapshot: BodySnapshot = { id: "s1", measured_on: "2026-01-05", values: { C08: { value: 97 } }, created_at: "2026-01-05T08:00:00+00:00", updated_at: "2026-01-05T08:00:00+00:00", revisions: 0 };

class Observer { observe() {} disconnect() {} }

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", Observer);
  hologram.focus = [];
  hologram.ghosts = [];
  api.getBodyCatalog.mockResolvedValue(catalog);
  api.getBodyStatus.mockResolvedValue({ state: "ready", fitter: "test" });
  api.getBodyTopology.mockResolvedValue({ fitter: "test", vertex_count: 0, faces: "", masks: {} });
  api.fitBody.mockResolvedValue(body);
  api.getBodyProfile.mockResolvedValue({ draft: { values: {}, updated_at: null }, snapshots: [snapshot] });
  api.saveBodyDraft.mockImplementation(async (values: unknown) => ({ values, updated_at: "now" }));
  api.createBodySnapshot.mockResolvedValue({ ...snapshot, id: "s2" });
  api.deleteBodySnapshot.mockResolvedValue({ deleted: "s1" });
  api.getSnapshotBody.mockResolvedValue(body);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const openCard = async (name: RegExp) => {
  fireEvent.click(await screen.findByRole("button", { name }));
  return screen.findByRole("group");
};

describe("BodyView", () => {
  it("shows inferred values, then refits and keeps the draft locally as values are entered", async () => {
    render(<BodyView />);
    expect(await screen.findByRole("button", { name: /C08 胸围 98\.6 模型估计/ })).toBeTruthy();
    const card = await openCard(/C08 胸围/);
    expect(hologram.focus.at(-1)).toBe("C08");
    fireEvent.change(within(card).getByRole("textbox", { name: /value/ }), { target: { value: "101.4" } });
    await waitFor(() => expect(api.fitBody).toHaveBeenLastCalledWith({ C08: { value: 101.4 } }, expect.anything()));
    await waitFor(() => expect(api.saveBodyDraft).toHaveBeenCalledWith({ C08: { value: 101.4 } }), { timeout: 2000 });
  });

  it("rejects out-of-range input without sending it", async () => {
    render(<BodyView />);
    const card = await openCard(/C08 胸围/);
    fireEvent.change(within(card).getByRole("textbox", { name: /value/ }), { target: { value: "400" } });
    expect(await within(card).findByText("有效范围 40–160")).toBeTruthy();
    await act(() => new Promise(r => setTimeout(r, 900)));
    expect(api.saveBodyDraft).not.toHaveBeenCalled();
  });

  it("explains a measurement from the guide behind the question mark", async () => {
    render(<BodyView />);
    const card = await openCard(/C08 胸围/);
    fireEvent.click(within(card).getByRole("button", { name: "测量说明" }));
    expect(within(card).getByText("经胸部最丰满处水平绕一圈。")).toBeTruthy();
    expect(within(card).getByText("水平截面。")).toBeTruthy();
  });

  it("saves a dated snapshot of the draft", async () => {
    render(<BodyView />);
    const card = await openCard(/H09 大腿最大围/);
    fireEvent.change(within(card).getByRole("textbox", { name: /left/ }), { target: { value: "56" } });
    fireEvent.click(screen.getByRole("button", { name: "保存测量" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("测量日期"), { target: { value: "2026-02-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存测量" }));
    await waitFor(() => expect(api.createBodySnapshot).toHaveBeenCalledWith("2026-02-01", { H09: { left: 56 } }));
  });

  it("compares against a snapshot and deletes it only after confirmation", async () => {
    api.getBodyProfile.mockResolvedValue({ draft: { values: { C08: { value: 100 } }, updated_at: "x" }, snapshots: [snapshot] });
    render(<BodyView />);
    fireEvent.click(await screen.findByRole("button", { name: /历史/ }));
    const panel = await screen.findByRole("complementary", { name: "历史" });
    fireEvent.click(within(panel).getByRole("button", { name: "对比" }));
    await waitFor(() => expect(hologram.ghosts.at(-1)).toEqual({ C08: 1 }));
    fireEvent.click(within(panel).getByRole("button", { name: "删除 2026-01-05 的快照" }));
    const dialog = await screen.findByRole("dialog");
    expect(api.deleteBodySnapshot).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "永久删除" }));
    await waitFor(() => expect(api.deleteBodySnapshot).toHaveBeenCalledWith("s1"));
  });
});

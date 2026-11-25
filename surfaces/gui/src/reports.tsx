import { createContext, useContext, useEffect, useState } from "react";
import { invokeStrict } from "./tauri";

export type Report = {
  id: string; path: string; title: string; channel: string; modified: string; date: string;
};
type Channel = { id: string; name: string; documents: Report[] };
type Catalog = { channels: Channel[]; error: string; loaded: boolean };
const empty: Catalog = { channels: [], error: "", loaded: false };
export const ReportsContext = createContext<Catalog>(empty);
export const useReports = () => useContext(ReportsContext);
export const openReport = (path: string) => invokeStrict<void>("open_local_report", { path });

export function useLocalCatalog() {
  const [catalog, setCatalog] = useState(empty);
  useEffect(() => {
    let active = true;
    let running = false;
    let dirty = false;
    let unlisten: (() => void) | undefined;
    async function refresh() {
      dirty = true;
      if (running) return;
      running = true;
      while (active && dirty) {
        dirty = false;
        try {
          const channels = await invokeStrict<Channel[]>("list_local_reports");
          if (active) {
            saveReading(reconcileReading(loadReading(), channels.flatMap(channel => channel.documents)));
            setCatalog({ channels, error: "", loaded: true });
          }
        } catch (e) {
          if (active) setCatalog(previous => ({ ...previous, loaded: true, error: String(e) }));
        }
      }
      running = false;
    }
    async function start() {
      try {
        const stop = await (window as any).__TAURI__.event.listen("reports-changed", refresh);
        if (!active) { stop(); return; }
        unlisten = stop;
        await refresh();
      } catch (e) {
        if (active) setCatalog({ ...empty, loaded: true, error: String(e) });
      }
    }
    void start();
    window.addEventListener("focus", refresh);
    return () => { active = false; unlisten?.(); window.removeEventListener("focus", refresh); };
  }, []);
  return catalog;
}

type ReadingState = { read: Set<string>; featured: Set<string>; paths: Record<string, string> };
function load<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; }
  catch { return fallback; }
}
export function loadReading(): ReadingState {
  const featured = new Set(load<string[]>("reading-report-featured", []));
  const read = new Set([...load<string[]>("reading-report-read", []), ...featured]);
  return { read, featured, paths: load("reading-report-paths", {}) };
}
export function saveReading(state: ReadingState) {
  localStorage.setItem("reading-report-read", JSON.stringify([...state.read]));
  localStorage.setItem("reading-report-featured", JSON.stringify([...state.featured]));
  localStorage.setItem("reading-report-paths", JSON.stringify(state.paths));
}
export function reconcileReading(state: ReadingState, reports: Report[]): ReadingState {
  const read = new Set(state.read), featured = new Set(state.featured);
  const paths: Record<string, string> = {};
  for (const report of reports) {
    const path = report.path.normalize("NFC");
    // Older versions stored paths. An atomic rewrite can also replace a file's inode.
    for (const old of [path, state.paths[path]]) {
      if (old && old !== report.id) {
        if (read.delete(old)) read.add(report.id);
        if (featured.delete(old)) featured.add(report.id);
      }
    }
    paths[path] = report.id;
  }
  return { read, featured, paths };
}

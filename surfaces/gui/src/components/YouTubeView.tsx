import { useEffect, useMemo, useState } from "react";
import { loadReading, openReport, saveReading, useReports } from "../reports";
import "./youtube.css";

const filters = { unread: "未读", read: "已读", featured: "精选" } as const;
type Filter = keyof typeof filters;

export function YouTubeView({ channel }: { channel: string }) {
  const { channels, loaded, error } = useReports();
  const [filter, setFilter] = useState<Filter>("unread");
  const [reading, setReading] = useState(loadReading);
  const [openError, setOpenError] = useState("");
  const reports = useMemo(() => channels.flatMap(c => c.documents)
    .sort((a, b) => b.modified.localeCompare(a.modified) || b.path.localeCompare(a.path)), [channels]);
  useEffect(() => {
    setReading(loadReading());
  }, [channels]);
  function toggle(id: string, action: "read" | "featured") {
    const state = loadReading();
    if (state[action].delete(id)) {
      if (action === "read") state.featured.delete(id);
    } else {
      state[action].add(id);
      state.read.add(id);
    }
    saveReading(state);
    setReading(state);
  }
  const group = reports.filter(doc => !channel || doc.channel === channel);
  const visible = group.filter(doc =>
    (reading.featured.has(doc.id) ? "featured" : reading.read.has(doc.id) ? "read" : "unread") === filter);
  return <section className="youtube-feed" aria-label="YouTube · 精读报告">
    <header><h1>YouTube</h1><nav aria-label="阅读状态">
      {(Object.keys(filters) as Filter[]).map(key => <button key={key}
        aria-current={filter === key ? "page" : undefined} onClick={() => setFilter(key)}>{filters[key]}</button>)}
    </nav></header>
    <div className="tools"><span id="channel-name">{channel || "全部频道"}</span>
      <output id="count">{visible.length} 份报告</output>
      {filter === "unread" && visible.length > 0 && <button onClick={() => {
        const state = loadReading();
        group.forEach(doc => state.read.add(doc.id));
        saveReading(state);
        setReading(state);
      }}>全部标为已读</button>}
    </div>
    <ul id="documents">{visible.map((doc, i) => <li key={doc.id}>
      <span className="number">{String(i + 1).padStart(2, "0")}</span>
      <button className="title" title={doc.channel + " · " + doc.title} onClick={async () => {
        try { await openReport(doc.path); setOpenError(""); }
        catch (e) { setOpenError("无法打开报告：" + String(e)); }
      }}>{doc.title}</button>
      <time className="date" dateTime={doc.modified}>{doc.date}</time>
      <div className="actions"><button aria-pressed={reading.read.has(doc.id)}
        onClick={() => toggle(doc.id, "read")}>{reading.read.has(doc.id) ? "已读" : "未读"}</button>
        <button aria-label="精选" aria-pressed={reading.featured.has(doc.id)}
          title={reading.featured.has(doc.id) ? "取消精选" : "设为精选"}
          onClick={() => toggle(doc.id, "featured")}>{reading.featured.has(doc.id) ? "★" : "☆"}</button></div>
    </li>)}</ul>
    <p role="status">{error ? "报告目录加载失败：" + error : openError ||
      (!loaded ? "正在读取报告…" : visible.length ? "" : "当前筛选下没有报告。")}</p>
  </section>;
}

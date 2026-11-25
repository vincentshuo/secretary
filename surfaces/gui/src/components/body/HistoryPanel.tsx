import { useState } from "react";
import { useTranslation } from "react-i18next";
import { getBodyRevisions, type BodyParameter, type BodyRevision, type BodySnapshot } from "../../api";
import { Icon } from "../Icon";
import { recordedCount, series } from "./values";

type Lang = "zh" | "en";

export function HistoryPanel({
  parameters,
  snapshots,
  ghost,
  editing,
  focus,
  lang,
  onGhost,
  onRevise,
  onDelete,
  onFocus,
  onClose,
}: {
  parameters: BodyParameter[];
  snapshots: BodySnapshot[];
  ghost: string | null;
  editing: string | null;
  focus: string | null;
  lang: Lang;
  onGhost: (id: string | null) => void;
  onRevise: (snapshot: BodySnapshot) => void;
  onDelete: (snapshot: BodySnapshot) => void;
  onFocus: (pid: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [revisions, setRevisions] = useState<Record<string, BodyRevision[] | "loading">>({});
  const ordered = [...snapshots].sort((a, b) => b.measured_on.localeCompare(a.measured_on) || b.created_at.localeCompare(a.created_at));
  const chronological = [...ordered].reverse();
  const curves = parameters
    .map(p => ({ p, lines: series(p, chronological) }))
    .filter(c => c.lines.length > 0);

  const toggleRevisions = async (id: string) => {
    if (revisions[id]) {
      setRevisions(({ [id]: _, ...rest }) => rest);
      return;
    }
    setRevisions(r => ({ ...r, [id]: "loading" }));
    try {
      const data = await getBodyRevisions(id);
      setRevisions(r => ({ ...r, [id]: data.revisions }));
    } catch {
      setRevisions(({ [id]: _, ...rest }) => rest);
    }
  };

  return (
    <aside className="body-history" aria-label={t("body.history")}>
      <header>
        <h3>{t("body.history")}</h3>
        <button type="button" className="body-icon-button" aria-label={t("body.close")} onClick={onClose}><Icon name="x" size={14} /></button>
      </header>
      {ordered.length === 0 ? (
        <p className="body-empty">{t("body.no_snapshots")}</p>
      ) : (
        <>
          <ol className="body-snapshots">
            {ordered.map(s => {
              const list = revisions[s.id];
              return (
                <li key={s.id} className={`${ghost === s.id ? "is-ghost" : ""}${editing === s.id ? " is-editing" : ""}`}>
                  <div className="body-snapshot-row">
                    <div>
                      <strong>{s.measured_on}</strong>
                      <span>{t("body.items", { count: recordedCount(parameters, s.values) })}</span>
                    </div>
                    <div className="body-snapshot-actions">
                      <button type="button" aria-pressed={ghost === s.id} onClick={() => onGhost(ghost === s.id ? null : s.id)}>{t("body.compare")}</button>
                      <button type="button" onClick={() => onRevise(s)} disabled={editing === s.id}>{t("body.revise")}</button>
                      <button type="button" className="is-danger" aria-label={t("body.delete_named", { date: s.measured_on })} onClick={() => onDelete(s)}><Icon name="trash" size={13} /></button>
                    </div>
                  </div>
                  {s.revisions > 0 && (
                    <button type="button" className="body-revisions-toggle" aria-expanded={!!list} onClick={() => toggleRevisions(s.id)}>
                      {t("body.revisions", { count: s.revisions })}
                    </button>
                  )}
                  {Array.isArray(list) && (
                    <ul className="body-revisions">
                      {list.map(r => (
                        <li key={r.replaced_at}>
                          {t("body.revision_line", { date: r.measured_on, count: recordedCount(parameters, r.values), at: r.replaced_at.slice(0, 16).replace("T", " ") })}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
          <h4 className="body-curves-title">{t("body.curves")}</h4>
          <div className="body-curves">
            {curves.map(({ p, lines }) => (
              <button
                key={p.id}
                type="button"
                className={`body-curve${focus === p.id ? " is-active" : ""}`}
                onClick={() => onFocus(p.id)}
              >
                <span className="body-curve-title"><b>{p.id}</b> {p.name[lang]}</span>
                <Sparkline lines={lines} labels={Object.fromEntries(p.fields.map(f => [f.key, f.label[lang]]))} />
              </button>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

function Sparkline({ lines, labels }: { lines: { key: string; points: { date: string; value: number }[] }[]; labels: Record<string, string> }) {
  const width = 268;
  const height = 54;
  const all = lines.flatMap(l => l.points);
  const dates = [...new Set(all.map(p => p.date))].sort();
  const min = Math.min(...all.map(p => p.value));
  const max = Math.max(...all.map(p => p.value));
  const pad = Math.max((max - min) * 0.2, 0.5);
  const x = (date: string) => (dates.length === 1 ? width / 2 : 8 + (dates.indexOf(date) / (dates.length - 1)) * (width - 16));
  const y = (v: number) => 6 + (1 - (v - (min - pad)) / (max - min + 2 * pad)) * (height - 12);
  return (
    <span className="body-sparkline">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={lines.map(l => `${labels[l.key]} ${l.points.map(p => `${p.date} ${p.value}`).join(", ")}`).join("; ")}>
        {lines.map((l, i) => (
          <g key={l.key} className={`series-${i}`}>
            <polyline points={l.points.map(p => `${x(p.date)},${y(p.value)}`).join(" ")} />
            {l.points.map(p => <circle key={p.date} cx={x(p.date)} cy={y(p.value)} r="2.4" />)}
          </g>
        ))}
      </svg>
      <span className="body-sparkline-values">
        {lines.map(l => {
          const first = l.points[0].value;
          const last = l.points[l.points.length - 1].value;
          const delta = last - first;
          return (
            <span key={l.key}>
              {lines.length > 1 && <small>{labels[l.key]} </small>}
              {last.toFixed(1)}
              {l.points.length > 1 && <em className={delta === 0 ? "" : delta > 0 ? "up" : "down"}> {delta > 0 ? "+" : ""}{delta.toFixed(1)}</em>}
            </span>
          );
        })}
      </span>
    </span>
  );
}

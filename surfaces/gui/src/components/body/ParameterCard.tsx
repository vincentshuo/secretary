import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BodyCatalog, BodyEntry, BodyField, BodyParameter, BodyRender } from "../../api";
import { Icon } from "../Icon";
import { GarmentPlate, type AtlasView } from "./GarmentPlate";
import { bilateral, formatCm, parseField, readings, recorded, shortfall, type Reading } from "./values";

type Lang = "zh" | "en";

export function ParameterLabel({
  parameter: p,
  entry,
  render,
  open,
  detailId,
  lang,
  onToggle,
}: {
  parameter: BodyParameter;
  entry: BodyEntry | undefined;
  render: BodyRender | null;
  open: boolean;
  detailId: string;
  lang: Lang;
  onToggle: () => void;
}) {
  const { t } = useTranslation(undefined, { lng: "zh" });
  const shown = readings(p, entry, render, lang);
  const gap = shortfall(p, render);
  return (
    <button type="button" className="body-label-head" aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={onToggle}>
      <span className="body-label-id">{p.id}</span>
      <span className="body-label-name">{p.name[lang]}</span>
      <span className="body-label-value">
        <Summary parameter={p} shown={shown} entry={entry} />
        {shown.some(r => r.source === "recorded") && <em>{p.group === "target" ? "目标" : "实测"}{shown.some(r => r.source === "mirrored") && "／对侧参照"}</em>}
        {gap && <span className="body-label-warn" title={t("body.shortfall_short")}>!</span>}
      </span>
    </button>
  );
}

function Summary({ parameter: p, shown, entry }: { parameter: BodyParameter; shown: Reading[]; entry: BodyEntry | undefined }) {
  const { t } = useTranslation(undefined, { lng: "zh" });
  const known = shown.filter(r => r.value !== null);
  if (!known.length) return <span className="is-empty">{p.kind === "reference" ? t("body.reference_unset") : "—"}</span>;
  const inferred = known.every(r => r.source === "inferred");
  if (bilateral(p) && known.length === 2) {
    const same = formatCm(known[0].value) === formatCm(known[1].value) || (inferred && Math.abs(known[0].value! - known[1].value!) < 0.3);
    if (same) return <span className={`source-${known[0].source}`}>{formatCm(known[0].value)}{inferred && <em>{t("body.inferred")}</em>}</span>;
    return (
      <span>
        {known.map((r, i) => (
          <span key={r.key} className={`source-${r.source}`}>{i > 0 && <span className="sep"> / </span>}{formatCm(r.value)}</span>
        ))}
        {inferred && <em>{t("body.inferred")}</em>}
      </span>
    );
  }
  const side = p.side_choice && entry?.side ? `${t(entry.side === "R" ? "body.right_wrist" : "body.left_wrist")} ` : "";
  return (
    <span className={inferred ? "source-inferred" : undefined}>
      {side}
      {known.map((r, i) => (
        <span key={r.key} className={`source-${r.source}`}>
          {i > 0 && <span className="sep"> · </span>}
          {known.length > 1 && <small>{r.label} </small>}
          {formatCm(r.value)}
        </span>
      ))}
      {inferred && <em>{t("body.inferred")}</em>}
    </span>
  );
}

export function ParameterCard({
  id,
  parameter: p,
  catalog,
  entry,
  render,
  lang,
  view,
  onView,
  onChange,
  onClose,
}: {
  id: string;
  parameter: BodyParameter;
  catalog: BodyCatalog;
  entry: BodyEntry | undefined;
  render: BodyRender | null;
  lang: Lang;
  view: AtlasView;
  onView: (view: AtlasView) => void;
  onChange: (key: string, value: number | string | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(undefined, { lng: "zh" });
  const shown = readings(p, entry, render, lang);
  const gap = shortfall(p, render);
  const titleId = `${id}-title`;
  return (
    <aside id={id} className="body-card" aria-labelledby={titleId}>
      <div className="body-card-top">
        <h3 id={titleId}>{p.name[lang]}</h3>
        <button type="button" className="body-icon-button" aria-label={t("body.close")} onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
      <div className="body-card-kinds">
        <span className={`body-kind kind-${p.kind}`}>{t(`body.kind.${p.kind}`)}</span>
        {p.as_needed && <span className="body-kind">{t("body.as_needed")}</span>}
      </div>
      {p.side_choice && (
        <div className="body-segment" role="radiogroup" aria-label={t("body.watch_side")}>
          {(["L", "R"] as const).map(side => (
            <button
              key={side}
              type="button"
              role="radio"
              aria-checked={(entry?.side ?? "L") === side}
              onClick={() => onChange("side", side)}
            >{t(side === "L" ? "body.left_wrist" : "body.right_wrist")}</button>
          ))}
        </div>
      )}
      <div className="body-fields">
        {p.fields.map((f, i) => (
          <FieldInput key={f.key} field={f} lang={lang} value={recorded(entry, f.key)} reading={shown[i]} onCommit={v => onChange(f.key, v)} />
        ))}
      </div>
      {bilateral(p) && <p className="body-hint">{t("body.mirror_hint")}</p>}
      {gap && (
        <p className="body-shortfall" role="status">
          {t("body.shortfall", {
            side: gap.side ? t(gap.side === "L" ? "body.left" : "body.right") : "",
            reached: formatCm(gap.reached),
            gap: formatCm(Math.abs(gap.gap)),
          })}
        </p>
      )}
      <TextField label={t("body.position")} placeholder={t("body.position_placeholder")} value={(entry?.position as string) ?? ""} onCommit={v => onChange("position", v)} />
      <TextField label={t("body.note")} value={(entry?.note as string) ?? ""} onCommit={v => onChange("note", v)} multiline />
      <GarmentPlate view={view} active={p} onView={onView} />
      <details className="body-help" lang="zh">
        <summary>测量细节</summary>
        <Help parameter={p} catalog={catalog} />
      </details>
    </aside>
  );
}

function FieldInput({ field, lang, value, reading, onCommit }: {
  field: BodyField;
  lang: Lang;
  value: number | null;
  reading: Reading;
  onCommit: (v: number | null) => void;
}) {
  const { t } = useTranslation(undefined, { lng: "zh" });
  const [text, setText] = useState(value === null ? "" : String(value));
  const parsed = parseField(field, text);
  const invalid = Number.isNaN(parsed);
  useEffect(() => {
    if (parsed !== value && !(invalid && document.activeElement?.getAttribute("data-field") === field.key)) {
      setText(value === null ? "" : String(value));
    }
    // Only external changes to the stored value resync the text the person is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const hint = reading.source === "mirrored" ? t("body.mirrored", { value: formatCm(reading.value) })
    : reading.source === "inferred" ? t("body.inferred_value", { value: formatCm(reading.value) })
      : "";
  return (
    <label className={`body-field${invalid ? " is-invalid" : ""}`}>
      <span className="body-field-label">{field.label[lang]}</span>
      <span className="body-field-input">
        <input
          data-field={field.key}
          inputMode="decimal"
          value={text}
          placeholder={reading.value !== null ? formatCm(reading.value) : ""}
          aria-invalid={invalid}
          onChange={event => {
            const next = event.target.value;
            setText(next);
            const v = parseField(field, next);
            if (!Number.isNaN(v)) onCommit(v);
          }}
          onBlur={() => { if (!invalid && parsed !== null) setText(String(parsed)); }}
        />
        <span className="unit">{field.unit}</span>
      </span>
      <span className="body-field-hint">{invalid ? t("body.range", { min: field.min, max: field.max }) : hint}</span>
    </label>
  );
}

function TextField({ label, value, placeholder, multiline, onCommit }: {
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onCommit: (v: string | null) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => { if (text.trim() !== value) onCommit(text.trim() || null); };
  const props = {
    value: text,
    placeholder,
    maxLength: 500,
    onChange: (event: { target: { value: string } }) => setText(event.target.value),
    onBlur: commit,
  };
  return (
    <label className="body-text">
      <span>{label}</span>
      {multiline ? <textarea rows={2} {...props} /> : <input {...props} onKeyDown={event => { if (event.key === "Enter") commit(); }} />}
    </label>
  );
}

function Help({ parameter: p, catalog }: { parameter: BodyParameter; catalog: BodyCatalog }) {
  return (
    <div className="body-help-content">
      {p.categories.length > 0 && (
        <section>
          <h4>适用品类</h4>
          <ul className="body-help-tags">
            {p.categories.map(c => <li key={c.name}><span>{c.stage}</span>{c.name}</li>)}
          </ul>
        </section>
      )}
      {p.landmarks.length > 0 && (
        <section>
          <h4>定位点</h4>
          <dl>
            {p.landmarks.map(name => (
              <div key={name}><dt>{name}</dt><dd>{catalog.landmarks[name]}</dd></div>
            ))}
          </dl>
        </section>
      )}
      <section className="body-help-model">
        <h4>人体模型中的测量路径</h4>
        <p>{p.model}</p>
      </section>
    </div>
  );
}

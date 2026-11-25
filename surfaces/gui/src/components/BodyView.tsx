import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createBodySnapshot,
  deleteBodySnapshot,
  downloadBodyExport,
  fitBody,
  getBodyCatalog,
  getBodyProfile,
  getBodyStatus,
  getBodyTopology,
  getSnapshotBody,
  reviseBodySnapshot,
  saveBodyDraft,
  type BodyCatalog,
  type BodyRender,
  type BodySnapshot,
  type BodyStatus,
  type BodyTopology,
  type BodyValues,
} from "../api";
import { Icon } from "./Icon";
import { BodyStage } from "./body/BodyStage";
import { HistoryPanel } from "./body/HistoryPanel";
import { ParameterCard, ParameterLabel } from "./body/ParameterCard";
import { changes, recordedCount, sameValues, setEntry } from "./body/values";
import { shanghaiToday } from "./curriculum/timetable";
import "./body/body.css";

type Editing = { id: string; measured_on: string; values: BodyValues };
type DraftState = "idle" | "saving" | "saved" | "error";
type Dialog = { kind: "save" } | { kind: "delete"; snapshot: BodySnapshot } | { kind: "rules" } | null;

const FIT_DELAY = 160;
const DRAFT_DELAY = 700;
const HOVER_DWELL = 140;

export function BodyView() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith("zh") ? "zh" : "en";
  const [catalog, setCatalog] = useState<BodyCatalog | null>(null);
  const [status, setStatus] = useState<BodyStatus>({ state: "loading" });
  const [topology, setTopology] = useState<BodyTopology | null>(null);
  const [draft, setDraft] = useState<BodyValues | null>(null);
  const [snapshots, setSnapshots] = useState<BodySnapshot[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [render, setRender] = useState<BodyRender | null>(null);
  const [fitting, setFitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [draftState, setDraftState] = useState<DraftState>("idle");
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [ghostId, setGhostId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<BodyRender | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [saveDate, setSaveDate] = useState(shanghaiToday);
  const [busy, setBusy] = useState(false);
  const savedDraft = useRef<BodyValues | null>(null);
  const hoverTimer = useRef<number>();

  const values = editing ? editing.values : draft;
  const ready = status.state === "ready";
  const focus = pinned ?? hovered;

  const fail = useCallback((cause: unknown) => {
    setProblem(cause instanceof Error ? cause.message : String(cause));
  }, []);

  useEffect(() => {
    getBodyCatalog().then(setCatalog, fail);
    getBodyProfile().then(profile => {
      savedDraft.current = profile.draft.values;
      setDraft(profile.draft.values);
      setSnapshots(profile.snapshots);
    }, fail);
  }, [fail]);

  useEffect(() => {
    if (status.state !== "loading") return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await getBodyStatus();
        if (stopped) return;
        setStatus(next);
        if (next.state === "loading") timer = window.setTimeout(poll, 1200);
      } catch {
        if (!stopped) timer = window.setTimeout(poll, 2000);
      }
    };
    poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [status.state]);

  useEffect(() => {
    if (ready && !topology) getBodyTopology().then(setTopology, fail);
  }, [ready, topology, fail]);

  useEffect(() => {
    if (!ready || !topology || !values) return;
    const control = new AbortController();
    const timer = window.setTimeout(async () => {
      setFitting(true);
      try {
        setRender(await fitBody(values, control.signal));
        setProblem(null);
      } catch (cause) {
        if (!control.signal.aborted) fail(cause);
      } finally {
        if (!control.signal.aborted) setFitting(false);
      }
    }, render ? FIT_DELAY : 0);
    return () => { window.clearTimeout(timer); control.abort(); };
    // The previous render only decides whether to debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, topology, values, fail]);

  useEffect(() => {
    if (!draft || !savedDraft.current || sameValues(draft, savedDraft.current)) return;
    setDraftState("saving");
    const timer = window.setTimeout(async () => {
      try {
        await saveBodyDraft(draft);
        savedDraft.current = draft;
        setDraftState("saved");
      } catch {
        setDraftState("error");
      }
    }, DRAFT_DELAY);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    if (!ghostId || !ready) {
      setGhost(null);
      return;
    }
    let live = true;
    getSnapshotBody(ghostId).then(body => { if (live) setGhost(body); }, fail);
    return () => { live = false; };
  }, [ghostId, ready, fail]);

  const change = (pid: string, key: string, value: number | string | null) => {
    if (editing) setEditing({ ...editing, values: setEntry(editing.values, pid, key, value) });
    else setDraft(d => setEntry(d ?? {}, pid, key, value));
  };

  const hover = (pid: string | null) => {
    window.clearTimeout(hoverTimer.current);
    if (pid === null) setHovered(null);
    else hoverTimer.current = window.setTimeout(() => setHovered(pid), HOVER_DWELL);
  };

  const refreshSnapshots = async () => setSnapshots((await getBodyProfile()).snapshots);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await createBodySnapshot(saveDate, draft);
      await refreshSnapshots();
      setDialog(null);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const saveRevision = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await reviseBodySnapshot(editing.id, editing.measured_on, editing.values);
      await refreshSnapshots();
      if (ghostId === editing.id) {
        setGhostId(null);
        window.setTimeout(() => setGhostId(editing.id));
      }
      setEditing(null);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (snapshot: BodySnapshot) => {
    setBusy(true);
    try {
      await deleteBodySnapshot(snapshot.id);
      if (ghostId === snapshot.id) setGhostId(null);
      if (editing?.id === snapshot.id) setEditing(null);
      await refreshSnapshots();
      setDialog(null);
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const exportProfile = () => downloadBodyExport().catch(fail);

  const parameters = catalog?.parameters ?? [];
  const count = values ? recordedCount(parameters, values) : 0;
  const ghostSnapshot = snapshots.find(s => s.id === ghostId);
  const loadingText = status.state === "error" ? t("body.model_error", { error: status.error }) : t("body.model_loading");

  return (
    <div className="body-view" data-testid="body-view">
      <BodyStage
        parameters={parameters}
        topology={topology}
        render={render}
        ghost={ghost}
        ghostChanges={ghostSnapshot && values ? changes(parameters, values, ghostSnapshot.values) : {}}
        focus={focus}
        expanded={pinned}
        onHover={hover}
        onDismiss={() => setPinned(null)}
        label={(p, open) => (
          <>
            <ParameterLabel
              parameter={p}
              entry={values?.[p.id]}
              render={render}
              open={open}
              lang={lang}
              onToggle={() => setPinned(current => (current === p.id ? null : p.id))}
            />
            {open && catalog && (
              <ParameterCard
                parameter={p}
                catalog={catalog}
                entry={values?.[p.id]}
                render={render}
                lang={lang}
                onChange={(key, value) => change(p.id, key, value)}
                onClose={() => setPinned(null)}
              />
            )}
          </>
        )}
      >
        <header className="body-header">
          <div className="body-title">
            <h2>{t("body.module")}</h2>
            <span>{t("body.recorded", { count, total: parameters.length || 22 })}</span>
            <span className={`body-draft-state state-${editing ? "editing" : draftState}`} aria-live="polite">
              {editing ? t("body.editing_hint") : draftState === "idle" ? t("body.draft_local") : t(`body.draft_${draftState}`)}
            </span>
            {fitting && <span className="body-fitting">{t("body.fitting")}</span>}
          </div>
          <div className="body-actions">
            <button type="button" onClick={() => setDialog({ kind: "rules" })}>{t("body.rules")}</button>
            <button type="button" aria-pressed={history} onClick={() => setHistory(v => !v)}>
              <Icon name="clock" size={14} />{t("body.history")}{snapshots.length > 0 && <span className="body-count">{snapshots.length}</span>}
            </button>
            <button type="button" onClick={exportProfile}><Icon name="file" size={14} />{t("body.export")}</button>
            <button
              type="button"
              className="is-primary"
              disabled={!draft || count === 0 || !!editing}
              onClick={() => { setSaveDate(shanghaiToday()); setDialog({ kind: "save" }); }}
            >{t("body.save")}</button>
          </div>
        </header>
        {editing && (
          <div className="body-banner" role="status">
            <span>{t("body.editing", { date: snapshots.find(s => s.id === editing.id)?.measured_on })}</span>
            <label>
              {t("body.measured_on")}
              <input type="date" value={editing.measured_on} max={shanghaiToday()} onChange={e => setEditing({ ...editing, measured_on: e.target.value })} />
            </label>
            <button type="button" className="is-primary" disabled={busy || recordedCount(parameters, editing.values) === 0} onClick={saveRevision}>{t("body.save_revision")}</button>
            <button type="button" onClick={() => setEditing(null)}>{t("body.discard")}</button>
          </div>
        )}
        {ghostSnapshot && (
          <div className="body-ghost-chip">
            <span className="swatch" />
            {t("body.ghost", { date: ghostSnapshot.measured_on })}
            <button type="button" aria-label={t("body.clear_ghost")} onClick={() => setGhostId(null)}><Icon name="x" size={12} /></button>
          </div>
        )}
        {problem && (
          <div className="body-problem" role="alert">
            <Icon name="warning" size={14} />
            {problem}
            <button type="button" aria-label={t("body.close")} onClick={() => setProblem(null)}><Icon name="x" size={12} /></button>
          </div>
        )}
        {!render && <div className="body-veil" role="status">{loadingText}</div>}
        {history && (
          <HistoryPanel
            parameters={parameters}
            snapshots={snapshots}
            ghost={ghostId}
            editing={editing?.id ?? null}
            focus={focus}
            lang={lang}
            onGhost={setGhostId}
            onRevise={s => { setEditing({ id: s.id, measured_on: s.measured_on, values: s.values }); setHistory(false); }}
            onDelete={s => setDialog({ kind: "delete", snapshot: s })}
            onFocus={pid => setPinned(pid)}
            onClose={() => setHistory(false)}
          />
        )}
      </BodyStage>
      {dialog && (
        <div className="body-dialog-backdrop" onClick={() => !busy && setDialog(null)}>
          <div className="body-dialog" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
            {dialog.kind === "save" && (
              <>
                <h3>{t("body.save_title")}</h3>
                <p>{t("body.save_body", { count })}</p>
                <label className="body-text">
                  <span>{t("body.measured_on")}</span>
                  <input type="date" value={saveDate} max={shanghaiToday()} onChange={e => setSaveDate(e.target.value)} />
                </label>
                <div className="body-dialog-actions">
                  <button type="button" onClick={() => setDialog(null)}>{t("body.cancel")}</button>
                  <button type="button" className="is-primary" disabled={busy || !saveDate} onClick={save}>{t("body.save")}</button>
                </div>
              </>
            )}
            {dialog.kind === "delete" && (
              <>
                <h3>{t("body.delete_title", { date: dialog.snapshot.measured_on })}</h3>
                <p>{t("body.delete_body")}</p>
                <div className="body-dialog-actions">
                  <button type="button" onClick={() => setDialog(null)}>{t("body.cancel")}</button>
                  <button type="button" className="is-danger" disabled={busy} onClick={() => remove(dialog.snapshot)}>{t("body.delete")}</button>
                </div>
              </>
            )}
            {dialog.kind === "rules" && catalog && (
              <div lang="zh" className="body-rules">
                <h3>测量须知</h3>
                <ol>{catalog.rules.map(r => <li key={r}>{r}</li>)}</ol>
                <h4>比较尺码前确认三件事</h4>
                <ol>{catalog.compare.map(r => <li key={r}>{r}</li>)}</ol>
                <p className="body-source">{catalog.source}</p>
                <div className="body-dialog-actions">
                  <button type="button" onClick={() => setDialog(null)}>{t("body.close")}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

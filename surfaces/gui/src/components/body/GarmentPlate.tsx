import type { BodyParameter } from "../../api";

export type AtlasView = "全身总览" | "上装" | "裤装";
const shirt = ["B07", "C03", "C04", "C08", "E01", "E06", "E08", "F03", "F05", "F07", "F12", "F13", "D11", "D12"];
const trousers = ["E01", "E05", "E06", "E08", "H09", "H13", "H18"];
export function inView(id: string, view: AtlasView) {
  return view === "全身总览" || (view === "上装" ? shirt : trousers).includes(id);
}

// Technical flats show construction and the garment region served by each measurement.
const marks: Record<string, string> = {
  B07: "M49 18 Q60 28 71 18", C03: "M37 22 Q60 14 83 22", C04: "M69 16 L83 22",
  C08: "M35 43 H85", E01: "M38 60 H82", E06: "M38 67 H82", E08: "M38 76 H82",
  F03: "M84 23 L101 74", F05: "M60 15 L84 23 L101 74", F07: "M84 36 L94 32",
  F12: "M94 73 L105 69", F13: "M94 73 L105 69", D11: "M48 17 V82", D12: "M60 16 V82",
};
const trouserMarks: Record<string, string> = {
  E01: "M37 9 H83", E05: "M37 16 Q60 20 83 16", E06: "M36 24 H84", E08: "M35 32 H85",
  H09: "M34 44 L59 46", H13: "M35 68 L54 70", H18: "M84 17 L86 87 M61 41 L68 87",
};
function Flat({ pants, focus, back }: { pants: boolean; focus?: string; back: boolean }) {
  const mark = focus && (pants ? trouserMarks : marks)[focus];
  return <svg className="atlas-flat" viewBox="0 0 120 96" aria-label={pants ? (back ? "裤装后视技术线稿" : "裤装技术线稿") : back ? "上装后视技术线稿" : "上装前视技术线稿"} role="img">
    <g fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round">
      {pants ? <>
        <path d="M37 14 Q60 18 83 14 L85 34 L86 88 L68 88 L60 42 L53 88 L34 88 L35 34 Z"/>
        <path d="M36 19 Q60 23 84 19 M34 84 H54 M67 84 H86"/>
        {back ? <path d="M37 23 L59 28 L83 23 M39 28 L55 31 L53 39 L40 36 Z M65 31 L81 28 L80 36 L67 39 Z M59 24 L60 42"/> :
          <path d="M40 21 Q40 29 35 32 M80 21 Q80 29 85 32 M59 21 V37 Q64 36 64 23"/>}
        <path strokeDasharray="2 2" d="M45 36 L42 82 M75 36 L77 82"/>
      </> : <>
        <path d="M49 15 Q60 18 71 15 L84 21 Q89 23 91 30 L106 70 L96 76 L83 46 L85 81 Q60 88 35 81 L37 46 L24 76 L14 70 L29 30 Q31 23 36 21 Z"/>
        {back ? <path d="M48 16 Q60 24 72 16 M35 28 Q60 35 85 28 M59 31 L56 39 M61 31 L64 39"/> :
          <path d="M49 15 L46 22 L54 29 L60 21 L66 29 L74 22 L71 15 M60 22 V84 M63 22 V84 M68 36 H79 V45 L74 48 L68 45 Z"/>}
        <path strokeDasharray="2 2" d="M35 78 Q60 85 85 78 M16 67 L26 72 M94 72 L104 67 M36 22 Q32 34 37 46 M84 22 Q88 34 83 46"/>
      </>}
      {mark && <path className="atlas-mark" d={mark} strokeWidth="2.7"/>}
    </g>
  </svg>;
}

export function GarmentFallback({ active, view, message }: {
  active?: BodyParameter; view: AtlasView; message: string;
}) {
  const id = active?.id;
  const upper = view === "上装" || (view === "全身总览" && (!id || !trouserMarks[id] || !!marks[id]));
  const lower = view === "裤装" || (view === "全身总览" && (!id || !!trouserMarks[id] || !marks[id]));
  return <section className="body-preview-fallback" role="status" data-testid="body-preview-fallback">
    <div className="body-fallback-flats">
      {upper && <Flat pants={false} back={active?.view === "back"} focus={id}/>}
      {lower && <Flat pants back={active?.view === "back"} focus={id}/>}
    </div>
    {active && <strong>{active.name.zh}</strong>}
    <span>{message}</span>
  </section>;
}

export function GarmentPlate({ view, active, onView }: { view: AtlasView; active?: BodyParameter; onView: (v: AtlasView) => void }) {
  const showShirt = view === "上装" || (view === "全身总览" && (!active || shirt.includes(active.id)));
  const showPants = view === "裤装" || (view === "全身总览" && (!active || trousers.includes(active.id)));
  return <section className="atlas-plate" aria-label="服装用途">
    <div className="atlas-flats">
      {showShirt && <button onClick={() => onView("上装")} aria-label="查看上装量体"><Flat pants={false} back={active?.view === "back"} focus={active?.id}/></button>}
      {showPants && <button onClick={() => onView("裤装")} aria-label="查看裤装量体"><Flat pants back={false} focus={active?.id}/></button>}
    </div>
    <div className="atlas-caption"><h3>{active?.name.zh ?? (view === "全身总览" ? "服装量体图册" : view + "量体")}</h3>
      <p>{active?.how ?? "选择量体项目，查看软尺路径与服装对应部位。"}</p>
      {active && <p>{active.use}</p>}
    </div>
  </section>;
}

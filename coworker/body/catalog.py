"""The 22 dimensions and target lengths kept by the personal clothing measurement guide.

`how` and `use` are the guide's own wording (§3) and stay Chinese-only; `categories`
come from its shopping table (§7) and `landmarks` from its positioning table (§2).
`model` says how the hologram represents the item; it is the only text written here.
"""

from __future__ import annotations

DRIVE, INDIRECT, REFERENCE = "drive", "indirect", "reference"

LANDMARKS = {
    "后颈点": "颈根后正中、自然领口附近的骨性突起区域；量后颈至腕时固定起点。无需自行判断具体椎骨。",
    "侧颈点": "颈部向肩部过渡的位置，接近正常肩缝的起点。",
    "肩端点": "肩部转向上臂的位置，接近肩峰；不要用落肩衣服的肩缝代替。",
    "自然腰线": "侧弯时腰部折痕附近的腰线；与日常裤腰可能不在同一位置。",
    "实际裤腰线": "穿合身裤子时腰头贴身体的路线；高腰、中腰、低腰分别记录。",
    "腕部终点": "固定采用腕横纹或商家指定位置；袖长比较时不能混用起终点。",
}

RULES = [
    "穿薄而贴体的衣物，自然站立，肩放松，不挺胸、不收腹。围度贴合但不勒出凹痕，不擅自塞手指或加厘米数。",
    "胸、腰、腹围在平静自然呼气末读取；放置胸围软尺后，放下手臂再读数。",
    "同一项完全松尺后再量一次；两次相差超过 0.5 cm 时重新定位并复测。这只是家庭复测规则，不是专业精度标准。",
    "单位统一用 cm，可记到 0.1 cm；不要把小数位数当作准确度。",
    "双侧项目分别记录，尤其是肩、手臂、手和腿。复测保持相同路线和姿势；体型或穿着需求明显变化时再更新。",
    "商家要求的测点、姿势或加量方式与本档案不同时，另记「品牌测量」，不要覆盖身体基准。",
]

COMPARE = [
    "表格测的是身体还是成衣？身体胸围 100 cm 与成衣平铺胸宽 50 cm 不能直接视为合身。衣物还涉及穿着空间、设计量和面料弹性。",
    "测量路线是否一致？肩端起量的袖长不能与后颈起量的袖长比较；腰宽、臀宽、裤长也须核对测点。",
    "参照衣物的穿着效果是否正是自己想要的？合身衬衫不能直接给宽松外套规定尺寸，修身裤也不能决定阔腿裤的腿宽。",
]


def _f(key, zh, en, lo, hi, unit="cm"):
    return {"key": key, "label": {"zh": zh, "en": en}, "min": lo, "max": hi, "unit": unit}


def _value(lo, hi):
    return [_f("value", "数值", "Value", lo, hi)]


def _sides(lo, hi):
    return [_f("left", "左", "Left", lo, hi), _f("right", "右", "Right", lo, hi)]


PARAMETERS: list[dict] = [
    {
        "id": "B01", "name": {"zh": "帽位头围", "en": "Hat-line head girth"}, "as_needed": True,
        "kind": INDIRECT, "group": "head", "column": "left", "view": "head", "fields": _value(45, 70),
        "how": "沿帽口预计经过的眉上、耳上、后脑路线绕一圈，贴合不勒；记录路线与发型。",
        "use": "对照帽子的头围范围；帽深与头型适配靠试戴确认。",
        "categories": [{"name": "帽子／手套", "stage": "先看"}], "landmarks": [],
        "model": "以头部宽度、深度与饱满度形变近似；模型无头发。",
    },
    {
        "id": "B07", "name": {"zh": "领位颈净围", "en": "Collar neck girth"}, "as_needed": True,
        "kind": DRIVE, "group": "head", "column": "right", "view": "front", "fields": _value(28, 55),
        "how": "在衬衫领座对应位置、通常喉结下方绕一圈，头自然，不塞手指。",
        "use": "对照衬衫的人体颈围表。成衣领围需留舒适空间，依品牌说明判断。",
        "categories": [{"name": "衬衫", "stage": "先看"}], "landmarks": [],
        "model": "在喉结下方、前低后高的领座线上量取。",
    },
    {
        "id": "C03", "name": {"zh": "背肩表面宽", "en": "Back shoulder surface width"}, "as_needed": False,
        "kind": DRIVE, "group": "torso", "column": "left", "view": "back", "fields": _value(30, 70),
        "how": "从左肩端沿后肩／上背表面直接量到右肩端，不绕经后颈；保存路线。",
        "use": "为正常肩款提供身体参照；不能直接等同成衣平铺肩宽。",
        "categories": [], "landmarks": ["肩端点"],
        "model": "沿上背表面从右肩端到左肩端，软尺跨过肩胛间的凹陷。",
    },
    {
        "id": "C04", "name": {"zh": "左右单肩长", "en": "Single shoulder length"}, "as_needed": True,
        "kind": INDIRECT, "group": "torso", "column": "right", "view": "front", "fields": _sides(8, 22),
        "how": "从侧颈点沿肩部量到同侧肩端，左右分别记录。",
        "use": "常遇到肩缝不合适、左右差异时辅助判断；购物优先比较合身衣物的肩宽。",
        "categories": [], "landmarks": ["侧颈点", "肩端点"],
        "model": "上游模型的肩部形变左右对称，左右差异只在参数卡上显示。",
    },
    {
        "id": "C08", "name": {"zh": "胸围", "en": "Chest girth"}, "as_needed": False,
        "kind": DRIVE, "group": "torso", "column": "left", "view": "front", "fields": _value(60, 160),
        "how": "经胸部最丰满处水平绕一圈，手臂自然放下，平静呼气末读取。",
        "use": "上衣、衬衫、西装和外套的主要选码依据之一。",
        "categories": [
            {"name": "T 恤／针织衫", "stage": "先看"}, {"name": "衬衫", "stage": "先看"},
            {"name": "西装／外套", "stage": "先看"},
        ],
        "landmarks": [], "model": "取乳头线至腋下之间最丰满的水平截面。",
    },
    {
        "id": "E01", "name": {"zh": "自然腰围", "en": "Natural waist girth"}, "as_needed": True,
        "kind": DRIVE, "group": "torso", "column": "left", "view": "front", "fields": _value(50, 160),
        "how": "沿已确定的自然腰线绕一圈，固定路线。",
        "use": "品牌明确要求自然腰围时调用；不替代实际裤腰围。",
        "categories": [], "landmarks": ["自然腰线"],
        "model": "采用 Anny 自带的人体测量腰线。",
    },
    {
        "id": "E05", "name": {"zh": "实际裤腰净围", "en": "Trouser waistband girth"}, "as_needed": False,
        "kind": INDIRECT, "group": "torso", "column": "left", "view": "front", "fields": _value(50, 160),
        "how": "穿一条腰位合适的裤子标出腰头位置，脱下后沿对应身体路线测量；高、中、低腰分开记。",
        "use": "裤子选码的主要身体参照；先确认品牌表格给的是身体腰围还是成衣腰围。",
        "categories": [{"name": "裤子／牛仔裤／短裤", "stage": "先看"}], "landmarks": ["实际裤腰线"],
        "model": "以自然腰线与髋关节之间、前低后高的中腰线近似；腰位请写在备注里。",
    },
    {
        "id": "E06", "name": {"zh": "最大腹围", "en": "Fullest abdomen girth"}, "as_needed": True,
        "kind": INDIRECT, "group": "torso", "column": "right", "view": "side", "fields": _value(50, 170),
        "how": "在腹部寻找最丰满的水平位置绕一圈，记下测量位置。",
        "use": "腹部常顶住衬衫、外套或裤腰时，检查是否只按胸围／腰围选码而漏掉腹部空间。",
        "categories": [{"name": "西装／外套", "stage": "先看"}], "landmarks": [],
        "model": "取裤腰线与自然腰线之间最丰满的水平截面。",
    },
    {
        "id": "E08", "name": {"zh": "最大臀围", "en": "Fullest hip girth"}, "as_needed": False,
        "kind": DRIVE, "group": "torso", "column": "left", "view": "back", "fields": _value(60, 170),
        "how": "双脚并拢或接近并拢、稳定站立，水平绕臀部最丰满处，软尺贴合不勒。",
        "use": "裤子和盖臀外套的空间判断；避免腰合适但臀部紧。",
        "categories": [{"name": "裤子／牛仔裤／短裤", "stage": "先看"}], "landmarks": [],
        "model": "取裆部以上、裤腰线以下最丰满的水平截面。",
    },
    {
        "id": "F03", "name": {"zh": "肩端至腕长", "en": "Shoulder-to-wrist length"}, "as_needed": False,
        "kind": DRIVE, "group": "arm", "column": "right", "view": "arm", "fields": _sides(40, 85),
        "how": "手臂屈肘约 90°，从肩端经肘外侧到腕部终点量连续长度；记录姿势。",
        "use": "对照采用同路线的身体袖长表；商家要求自然垂臂时另测。",
        "categories": [{"name": "衬衫", "stage": "先看"}], "landmarks": ["肩端点", "腕部终点"],
        "model": "模型为自然站姿，以肩端—肘外侧—腕部终点的两段骨段路径近似屈肘长度。",
    },
    {
        "id": "F05", "name": {"zh": "后颈至腕长", "en": "Nape-to-wrist length"}, "as_needed": True,
        "kind": INDIRECT, "group": "arm", "column": "right", "view": "back", "fields": _sides(60, 110),
        "how": "从后颈经肩端、肘外侧到腕部，固定并记录屈肘姿势。",
        "use": "用于以后颈为起点的衬衫袖长表；不能与 F03 混用。",
        "categories": [{"name": "衬衫", "stage": "先看"}], "landmarks": ["后颈点", "肩端点", "腕部终点"],
        "model": "后颈点沿肩上表面到肩端，再接 F03 的骨段路径。",
    },
    {
        "id": "F07", "name": {"zh": "放松上臂最大围", "en": "Relaxed upper-arm girth"}, "as_needed": True,
        "kind": DRIVE, "group": "arm", "column": "right", "view": "arm", "fields": _sides(18, 55),
        "how": "手臂自然放松，在上臂最丰满处绕一圈，软尺不斜绕。",
        "use": "肩胸合适但袖子偏紧时，检查袖肥。",
        "categories": [{"name": "T 恤／针织衫", "stage": "再检查"}], "landmarks": [],
        "model": "垂直于上臂轴线，取上臂中段最丰满的截面。",
    },
    {
        "id": "F12", "name": {"zh": "腕围", "en": "Wrist girth"}, "as_needed": True,
        "kind": DRIVE, "group": "arm", "column": "right", "view": "hand", "fields": _sides(12, 25),
        "how": "在腕部最细处贴合绕一圈。",
        "use": "衬衫袖口和腕饰的身体参照；实际袖口仍需活动余量。",
        "categories": [], "landmarks": [],
        "model": "垂直于前臂轴线，取腕部附近最细的截面。",
    },
    {
        "id": "F13", "name": {"zh": "戴表后的袖口需求", "en": "Cuff room over a watch"}, "as_needed": True,
        "kind": REFERENCE, "group": "arm", "column": "right", "view": "hand",
        "fields": [_f("girth", "带表外包络围", "Envelope girth", 12, 35)],
        "side_choice": True,
        "how": "记录戴表侧、佩戴位置及带表后的外包络围；同时试穿参考衬衫。",
        "use": "判断袖口能否覆盖手表、屈腕是否受阻；不覆盖腕部净围。",
        "categories": [{"name": "衬衫", "stage": "再检查"}], "landmarks": [],
        "model": "在戴表侧腕部画出外包络环，不改变人体。",
    },
    {
        "id": "H09", "name": {"zh": "大腿最大围", "en": "Fullest thigh girth"}, "as_needed": True,
        "kind": DRIVE, "group": "leg", "column": "left", "view": "front", "fields": _sides(35, 90),
        "how": "双脚略分、自然站立，在臀褶以下寻找单腿最丰满处绕一圈。",
        "use": "修身裤、牛仔裤的腿部空间判断；成衣大腿宽的测点须另核对。",
        "categories": [{"name": "裤子／牛仔裤／短裤", "stage": "再检查"}], "landmarks": [],
        "model": "垂直于大腿轴线，取臀褶以下最丰满的截面。",
    },
    {
        "id": "H13", "name": {"zh": "小腿最大围", "en": "Fullest calf girth"}, "as_needed": True,
        "kind": DRIVE, "group": "leg", "column": "left", "view": "back", "fields": _sides(25, 55),
        "how": "自然站立，绕小腿最粗处一圈。",
        "use": "小腿容易卡裤腿、购买窄筒裤或靴子时调用。",
        "categories": [
            {"name": "裤子／牛仔裤／短裤", "stage": "再检查"}, {"name": "鞋／靴／袜子", "stage": "再检查"},
        ],
        "landmarks": [], "model": "垂直于小腿轴线，取小腿上半段最粗的截面。",
    },
    {
        "id": "H15", "name": {"zh": "靴口处腿围", "en": "Boot-top leg girth"}, "as_needed": True,
        "kind": REFERENCE, "group": "leg", "column": "left", "view": "side",
        "fields": [_f("girth", "腿围", "Girth", 18, 60), _f("height", "靴口离地高度", "Boot-top height", 8, 60)],
        "how": "在目标靴筒口位置绕腿一圈，位置与围度一起记；裤腿塞靴内时穿目标裤子另量。",
        "use": "判断靴口是否紧、裤腿能否塞入；配合具体靴筒高度。",
        "categories": [{"name": "鞋／靴／袜子", "stage": "再检查"}], "landmarks": [],
        "model": "在给定离地高度处画出靴口环，不改变人体。",
    },
    {
        "id": "D11", "name": {"zh": "目标前衣长", "en": "Target front length"}, "as_needed": False,
        "kind": REFERENCE, "group": "target", "column": "right", "view": "front", "fields": _value(30, 130),
        "how": "按商家的起点，如侧颈点或前领口，量至希望的前下摆位置；最好在参考上衣上确认。",
        "use": "判断露腰、遮腰及搭配比例；不同起点不能直接比较。",
        "categories": [], "landmarks": ["侧颈点"],
        "model": "从侧颈点沿前身表面量出长度，画出前下摆参考线，不改变人体。",
    },
    {
        "id": "D12", "name": {"zh": "目标后衣长", "en": "Target back length"}, "as_needed": False,
        "kind": REFERENCE, "group": "target", "column": "left", "view": "back", "fields": _value(30, 130),
        "how": "按商家后领缝或其他指定起点量至希望的后下摆位置。",
        "use": "判断背后遮盖长度；短上衣、常规上衣、长外套分别保存目标。",
        "categories": [], "landmarks": ["后颈点"],
        "model": "从后颈点沿后中线量出长度，画出后下摆参考线，不改变人体。",
    },
    {
        "id": "H18", "name": {"zh": "目标裤外长／内长", "en": "Target outseam / inseam"}, "as_needed": False,
        "kind": REFERENCE, "group": "target", "column": "left", "view": "side",
        "fields": [_f("outseam", "外长", "Outseam", 40, 130), _f("inseam", "内长", "Inseam", 30, 110)],
        "how": "穿目标鞋，用一条腰位合适的裤子确定裤脚位置，再按商家路线测外长和内长。",
        "use": "判断九分、无堆积、轻微堆积等效果；腰位、鞋型不同可保留多个目标。",
        "categories": [{"name": "裤子／牛仔裤／短裤", "stage": "先看"}], "landmarks": ["实际裤腰线"],
        "model": "外长从裤腰线侧缝、内长从裆部沿腿量出，画出裤脚参考线；模型赤足，含鞋的长度可能落到地面以下。",
    },
    {
        "id": "G01", "name": {"zh": "手长", "en": "Hand length"}, "as_needed": True,
        "kind": INDIRECT, "group": "hand", "column": "right", "view": "hand", "fields": _sides(14, 26),
        "how": "手自然摊平，从腕横纹中点量到中指尖；品牌起点不同时按其图重测。",
        "use": "对照手套的手长范围，左右分别保存。",
        "categories": [{"name": "帽子／手套", "stage": "先看"}], "landmarks": [],
        "model": "从腕部截面中心量到中指尖，以手部比例与手指长度形变近似。",
    },
    {
        "id": "G04", "name": {"zh": "掌围", "en": "Palm girth"}, "as_needed": True,
        "kind": INDIRECT, "group": "hand", "column": "right", "view": "hand", "fields": _sides(15, 30),
        "how": "四指自然并拢，软尺绕手掌最宽处一圈，不含拇指。",
        "use": "对照手套的掌围尺码表；最后检查指尖空间和握拳舒适度。",
        "categories": [{"name": "帽子／手套", "stage": "先看"}], "landmarks": [],
        "model": "在指根关节处横截手掌，拇指不在截面内。",
    },
]

BY_ID = {p["id"]: p for p in PARAMETERS}
assert len(PARAMETERS) == 22


def catalog() -> dict:
    return {
        "parameters": PARAMETERS,
        "landmarks": LANDMARKS,
        "rules": RULES,
        "compare": COMPARE,
        "source": "个人服装人体测量指南（男性日常购衣实用版，修订 2026-11-16）",
    }


def targets(values: dict) -> dict[tuple[str, str], float]:
    """Body targets in metres from recorded values; one recorded side mirrors to the other."""
    out: dict[tuple[str, str], float] = {}
    for pid, entry in (values or {}).items():
        p = BY_ID.get(pid)
        if not p or p["kind"] == REFERENCE or not isinstance(entry, dict):
            continue
        if p["fields"][0]["key"] == "value":
            if _num(entry.get("value")) is not None:
                out[(pid, "")] = _num(entry["value"]) / 100
            continue
        left, right = _num(entry.get("left")), _num(entry.get("right"))
        left, right = left if left is not None else right, right if right is not None else left
        if left is not None:
            out[(pid, "L")] = left / 100
            out[(pid, "R")] = right / 100
    return out


def _num(x) -> float | None:
    if isinstance(x, bool) or x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v and abs(v) != float("inf") else None


def clean(values: dict) -> dict:
    """Keep only known parameters and fields, with numbers inside their plausible range."""
    out: dict = {}
    for pid, entry in (values or {}).items():
        p = BY_ID.get(pid)
        if not p or not isinstance(entry, dict):
            continue
        kept: dict = {}
        for f in p["fields"]:
            v = _num(entry.get(f["key"]))
            if v is not None:
                if not f["min"] <= v <= f["max"]:
                    raise ValueError(f"{pid}.{f['key']} out of range")
                kept[f["key"]] = round(v, 1)
        if p.get("side_choice") and entry.get("side") in ("L", "R"):
            kept["side"] = entry["side"]
        for text in ("position", "note"):
            if isinstance(entry.get(text), str) and entry[text].strip():
                kept[text] = entry[text].strip()[:500]
        if kept:
            out[pid] = kept
    return out

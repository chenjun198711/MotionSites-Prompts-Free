#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Consolidate ALL prompts in the MotionSites website into:
  - all_prompts.csv  (machine-readable, full copyable prompt_text)
  - all_prompts.md   (human-readable catalog grouped by category)

Sources:
  1. data/ms_prompts_with_text.json  (544 entries, metadata + prompt_text)
  2. prompts/*.md                    (10 curated structured markdown prompts)
"""
import json
import os
import re
import csv
import glob
from collections import Counter, OrderedDict

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data")
PROMPTS_DIR = os.path.join(BASE, "prompts")

OUT_CSV = os.path.join(BASE, "all_prompts.csv")
OUT_MD = os.path.join(BASE, "all_prompts.md")

CSV_COLUMNS = [
    "ID", "提示词名称", "提示词描述", "类型", "分类",
    "访问权限", "标签", "来源", "完整提示词",
]


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def parse_md(path):
    txt = open(path, "r", encoding="utf-8").read()
    fm = re.match(r"^---\n(.*?)\n---\n(.*)", txt, re.DOTALL)
    if not fm:
        return None
    fm_text, body = fm.group(1), fm.group(2)
    meta = {}
    for line in fm_text.split("\n"):
        m = re.match(r"^(\w+):\s*(.*)$", line)
        if m:
            k, v = m.group(1), m.group(2).strip()
            if v.startswith("[") and v.endswith("]"):
                v = [x.strip().strip('"').strip("'") for x in v[1:-1].split(",") if x.strip()]
            else:
                v = v.strip('"').strip("'")
            meta[k] = v
    pm = re.search(r"```text\n(.*?)\n```", body, re.DOTALL)
    meta["_text"] = pm.group(1).strip() if pm else ""
    dm = re.search(r"^>\s*(.+)$", body, re.MULTILINE)
    meta["_desc"] = dm.group(1).strip() if dm else ""
    return meta


def main():
    rows = []  # unified dicts

    # ---- Source 1: data catalog ----
    cat = load_json(os.path.join(DATA, "ms_prompts_with_text.json"))
    for c in cat:
        src_parts = []
        if c.get("source_kind"):
            src_parts.append(str(c["source_kind"]))
        if c.get("source_repo"):
            src_parts.append(str(c["source_repo"]))
        src = " / ".join(src_parts) if src_parts else ""
        rows.append({
            "id": c.get("id", ""),
            "title": c.get("title", ""),
            "description": (c.get("description") or "").strip(),
            "type": c.get("type", ""),
            "category": c.get("category", ""),
            "access": "开放" if c.get("is_free") else "付费",
            "tags": "",
            "source": src,
            "prompt_text": (c.get("prompt_text") or "").strip(),
        })

    # ---- Source 2: curated markdown prompts ----
    md_files = sorted(
        f for f in glob.glob(os.path.join(PROMPTS_DIR, "**", "*.md"), recursive=True)
        if os.path.basename(f) != "_TEMPLATE.md"
    )
    for f in md_files:
        m = parse_md(f)
        if not m:
            continue
        tags = m.get("tags")
        if isinstance(tags, list):
            tags = ", ".join(tags)
        # source from 'Source'/'Origin'
        src = ""
        for key in ("source", "Origin", "origin"):
            if m.get(key):
                src = str(m[key])
                break
        access = m.get("access", "")
        access_cn = "开放" if str(access).lower() == "open" else ("付费" if str(access).lower() == "premium" else access)
        rows.append({
            "id": m.get("id", ""),
            "title": m.get("title", ""),
            "description": (m.get("_desc") or "").strip(),
            "type": m.get("type", ""),
            "category": m.get("category", ""),
            "access": access_cn,
            "tags": tags or "",
            "source": src,
            "prompt_text": (m.get("_text") or "").strip(),
        })

    # de-dup by id (keep first)
    seen = set()
    uniq = []
    for r in rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        uniq.append(r)
    rows = uniq

    # sort: catalog first by category then title; curated keep ids 001..010 at front?
    # Put curated (ids like 001-010) first for visibility, then catalog by category+title.
    def sort_key(r):
        is_curated = bool(re.match(r"^\d{3}-", r["id"]))
        return (0 if is_curated else 1, r["category"], r["title"])
    rows.sort(key=sort_key)

    # ---- Write CSV ----
    with open(OUT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS, quoting=csv.QUOTE_MINIMAL)
        w.writeheader()
        for r in rows:
            w.writerow({
                "ID": r["id"],
                "提示词名称": r["title"],
                "提示词描述": r["description"],
                "类型": r["type"],
                "分类": r["category"],
                "访问权限": r["access"],
                "标签": r["tags"],
                "来源": r["source"],
                "完整提示词": r["prompt_text"],
            })

    # ---- Write MD ----
    cat_counter = Counter(r["category"] for r in rows)
    type_counter = Counter(r["type"] for r in rows)
    access_counter = Counter(r["access"] for r in rows)

    md = []
    md.append("# MotionSites 网站提示词全集\n")
    md.append(f"> 自动整理自网站数据源，共 **{len(rows)}** 条提示词。\n")
    md.append("## 统计概览\n")
    md.append(f"- **总条数**：{len(rows)}")
    md.append(f"- **访问权限**：开放 {access_counter.get('开放',0)} 条 / 付费 {access_counter.get('付费',0)} 条")
    md.append(f"- **分类数**：{len(cat_counter)} 个")
    md.append(f"- **类型数**：{len(type_counter)} 种")
    md.append("")
    md.append("### 按分类分布（Top 20）\n")
    for cat_name, cnt in cat_counter.most_common(20):
        md.append(f"- {cat_name}：{cnt}")
    md.append("")

    # Group by category
    groups = OrderedDict()
    for r in rows:
        groups.setdefault(r["category"] or "未分类", []).append(r)

    # TOC
    md.append("## 目录（按分类）\n")
    for i, (cat_name, items) in enumerate(groups.items(), 1):
        anchor = re.sub(r"[^\w一-龥-]", "-", cat_name)
        md.append(f"{i}. [{cat_name}（{len(items)}）](#{anchor})")
    md.append("")

    for cat_name, items in groups.items():
        anchor = re.sub(r"[^\w一-龥-]", "-", cat_name)
        md.append(f"\n## {cat_name}（{len(items)}）\n")
        md.append(f'<a id="{anchor}"></a>\n')
        for r in items:
            md.append(f"### {r['title']}  \n")
            md.append("| 字段 | 内容 |")
            md.append("| --- | --- |")
            md.append(f"| ID | `{r['id']}` |")
            md.append(f"| 类型 | {r['type']} |")
            md.append(f"| 访问权限 | {r['access']} |")
            md.append(f"| 标签 | {r['tags'] or '—'} |")
            md.append(f"| 来源 | {r['source'] or '—'} |")
            md.append(f"| 描述 | {r['description'] or '—'} |")
            md.append("")
            md.append("**完整提示词：**\n")
            md.append("`````text")
            md.append(r["prompt_text"])
            md.append("`````")
            md.append("")

    with open(OUT_MD, "w", encoding="utf-8") as f:
        f.write("\n".join(md))

    print("DONE")
    print("rows:", len(rows))
    print("csv:", OUT_CSV, os.path.getsize(OUT_CSV), "bytes")
    print("md:", OUT_MD, os.path.getsize(OUT_MD), "bytes")


if __name__ == "__main__":
    main()

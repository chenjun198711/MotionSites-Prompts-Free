#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
English-version export of ALL MotionSites prompts.
Outputs (does NOT overwrite the Chinese version):
  - all_prompts_en.csv
  - all_prompts_en.md
Chinese descriptions are translated to English (English text kept as-is).
"""
import json
import os
import re
import csv
import glob
import time
import urllib.request
import urllib.parse
from collections import Counter, OrderedDict

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data")
PROMPTS_DIR = os.path.join(BASE, "prompts")

OUT_CSV = os.path.join(BASE, "all_prompts_en.csv")
OUT_MD = os.path.join(BASE, "all_prompts_en.md")

CSV_COLUMNS = [
    "ID", "Prompt Name", "Prompt Description", "Type", "Category",
    "Access", "Tags", "Source", "Full Prompt",
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


def has_cjk(s):
    return any('\u4e00' <= ch <= '\u9fff' for ch in s)


_tr_cache = {}


def translate(text):
    if not text:
        return text
    if not has_cjk(text):
        return text  # already English (or non-Chinese) -> keep
    if text in _tr_cache:
        return _tr_cache[text]
    for attempt in range(3):
        try:
            url = ("https://translate.googleapis.com/translate_a/single?client=gtx"
                   "&sl=zh-CN&tl=en&dt=t&q=" + urllib.parse.quote(text))
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read().decode("utf-8"))
            out = "".join(seg[0] for seg in data[0] if seg[0])
            _tr_cache[text] = out
            return out
        except Exception:
            time.sleep(0.5)
    return text  # on failure keep original


def main():
    rows = []

    # Source 1: catalog
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
            "access": "Open" if c.get("is_free") else "Premium",
            "tags": "",
            "source": src,
            "prompt_text": (c.get("prompt_text") or "").strip(),
        })

    # Source 2: curated md
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
        src = ""
        for key in ("source", "Origin", "origin"):
            if m.get(key):
                src = str(m[key])
                break
        access = m.get("access", "")
        access_en = "Open" if str(access).lower() == "open" else ("Premium" if str(access).lower() == "premium" else access)
        rows.append({
            "id": m.get("id", ""),
            "title": m.get("title", ""),
            "description": (m.get("_desc") or "").strip(),
            "type": m.get("type", ""),
            "category": m.get("category", ""),
            "access": access_en,
            "tags": tags or "",
            "source": src,
            "prompt_text": (m.get("_text") or "").strip(),
        })

    # de-dup by id
    seen = set()
    uniq = []
    for r in rows:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        uniq.append(r)
    rows = uniq

    # translate descriptions
    print("Translating %d descriptions..." % len(rows))
    done = 0
    for r in rows:
        r["description_en"] = translate(r["description"])
        done += 1
        if done % 50 == 0:
            print("  translated", done, "/", len(rows))
    print("Translation done.")

    # sort: curated first
    def sort_key(r):
        is_curated = bool(re.match(r"^\d{3}-", r["id"]))
        return (0 if is_curated else 1, r["category"], r["title"])
    rows.sort(key=sort_key)

    # CSV
    with open(OUT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS, quoting=csv.QUOTE_MINIMAL)
        w.writeheader()
        for r in rows:
            w.writerow({
                "ID": r["id"],
                "Prompt Name": r["title"],
                "Prompt Description": r["description_en"],
                "Type": r["type"],
                "Category": r["category"],
                "Access": r["access"],
                "Tags": r["tags"],
                "Source": r["source"],
                "Full Prompt": r["prompt_text"],
            })

    # MD
    cat_counter = Counter(r["category"] for r in rows)
    type_counter = Counter(r["type"] for r in rows)
    access_counter = Counter(r["access"] for r in rows)

    md = []
    md.append("# MotionSites Website Prompts — Full Collection\n")
    md.append(f"> Auto-compiled from the site data sources. **{len(rows)}** prompts in total.\n")
    md.append("## Statistics Overview\n")
    md.append(f"- **Total**: {len(rows)}")
    md.append(f"- **Access**: Open {access_counter.get('Open',0)} / Premium {access_counter.get('Premium',0)}")
    md.append(f"- **Categories**: {len(cat_counter)}")
    md.append(f"- **Types**: {len(type_counter)}")
    md.append("")
    md.append("### Category distribution (Top 20)\n")
    for cat_name, cnt in cat_counter.most_common(20):
        md.append(f"- {cat_name}: {cnt}")
    md.append("")

    groups = OrderedDict()
    for r in rows:
        groups.setdefault(r["category"] or "Uncategorized", []).append(r)

    md.append("## Table of Contents (by category)\n")
    for i, (cat_name, items) in enumerate(groups.items(), 1):
        anchor = re.sub(r"[^\w-]", "-", cat_name)
        md.append(f"{i}. [{cat_name} ({len(items)})](#{anchor})")
    md.append("")

    for cat_name, items in groups.items():
        anchor = re.sub(r"[^\w-]", "-", cat_name)
        md.append(f"\n## {cat_name} ({len(items)})\n")
        md.append(f'<a id="{anchor}"></a>\n')
        for r in items:
            md.append(f"### {r['title']}  \n")
            md.append("| Field | Value |")
            md.append("| --- | --- |")
            md.append(f"| ID | `{r['id']}` |")
            md.append(f"| Type | {r['type']} |")
            md.append(f"| Access | {r['access']} |")
            md.append(f"| Tags | {r['tags'] or '—'} |")
            md.append(f"| Source | {r['source'] or '—'} |")
            md.append(f"| Description | {r['description_en'] or '—'} |")
            md.append("")
            md.append("**Full Prompt:**\n")
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

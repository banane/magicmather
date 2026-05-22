"""
Parse the Camp Mather openings PDF into structured JSON.

Detects strikethrough lines (text struck through = not available) and only
emits entries that are still open. Maps the PDF's week names + date ranges
to the app's 1-12 week numbering via start date.

Output: public/openings.json
{
  "scrapedAt": "...",
  "openings": [{"week": 1, "size": "6t", "raw": "6PTS", "dateRange": "5/31-6/3"}, ...]
}

Usage:
    python scripts/parse_openings_pdf.py public/Openings-as-of-2026-05-13.pdf
"""

import json
import re
import sys
from datetime import datetime, timezone

import pdfplumber

# Map week start date (m/d) -> app week number
WEEK_START_TO_NUM = {
    "5/31": 1, "6/3": 2, "6/7": 3, "6/14": 4, "6/21": 5,
    "6/28": 6, "7/5": 7, "7/12": 8, "7/19": 9, "7/26": 10,
    "8/2": 11, "8/9": 12,
}

# Lodging code -> engine size code
LODGING_MAP = {
    "2PC": "2c",
    "3PC": "3c",
    "4PC": "4c",
    "5PC": "4c",   # 5-person not in inventory, nearest match
    "6PC": "6c",
    "6PTS": "6t",  # 6-person tent site
    "6TS": "6t",   # PDF typo variant
}

# Column x-ranges (Full Week / Partial 1A / Partial 1B), (date_x_lo, date_x_hi, lodge_x_lo, lodge_x_hi)
COLUMNS = [
    (50, 165, 185, 225),
    (260, 365, 390, 425),
    (470, 570, 595, 630),
]


def parse_date_range(text):
    """Extract the start date 'm/d' from a string like 'Week_04 (6/21 - 6/27)' or 'Week_1A (5/31-6/3)'."""
    m = re.search(r"\((\d+/\d+)\s*-\s*(\d+/\d+)\)", text)
    if not m:
        return None, None
    return m.group(1), m.group(2)


def parse_page(page):
    """Return list of {date_text, lodge_text, week, size, raw, struck, col, y}."""
    chars = sorted(page.chars, key=lambda c: (-c["top"], c["x0"]))
    rows = []
    for ch in chars:
        if rows and abs(ch["top"] - rows[-1][0]["top"]) < 3:
            rows[-1].append(ch)
        else:
            rows.append([ch])

    hlines = [
        l for l in page.lines if abs(l["y0"] - l["y1"]) < 0.5 and l["width"] > 3
    ]

    entries = []
    for row in rows:
        text_all = "".join(c["text"] for c in sorted(row, key=lambda c: c["x0"]))
        if "Week_" not in text_all:
            continue
        y0 = min(c["y0"] for c in row)
        y1 = max(c["y1"] for c in row)
        ymid = (y0 + y1) / 2

        for col_idx, (dx0, dx1, lx0, lx1) in enumerate(COLUMNS):
            date_chars = sorted(
                [c for c in row if dx0 <= c["x0"] <= dx1], key=lambda c: c["x0"]
            )
            lodge_chars = sorted(
                [c for c in row if lx0 <= c["x0"] <= lx1], key=lambda c: c["x0"]
            )
            if not date_chars or not lodge_chars:
                continue
            date_text = "".join(c["text"] for c in date_chars).strip()
            lodge_text = "".join(c["text"] for c in lodge_chars).strip()
            if not date_text or not lodge_text:
                continue

            cell_x_min = min(date_chars[0]["x0"], lodge_chars[0]["x0"])
            cell_x_max = max(date_chars[-1]["x1"], lodge_chars[-1]["x1"])

            struck = any(
                abs(l["y0"] - ymid) <= 2
                and max(l["x0"], l["x1"]) >= cell_x_min - 2
                and min(l["x0"], l["x1"]) <= cell_x_max + 2
                for l in hlines
            )

            start, end = parse_date_range(date_text)
            week_num = WEEK_START_TO_NUM.get(start) if start else None
            size = LODGING_MAP.get(lodge_text.upper())

            entries.append(
                {
                    "date_text": date_text,
                    "lodge_text": lodge_text,
                    "date_range": f"{start}-{end}" if start else date_text,
                    "week": week_num,
                    "size": size,
                    "raw": lodge_text.upper(),
                    "struck": struck,
                    "col": col_idx,
                    "y": ymid,
                }
            )
    return entries


def main():
    if len(sys.argv) < 2:
        print("Usage: parse_openings_pdf.py <pdf_path>")
        sys.exit(1)
    pdf_path = sys.argv[1]

    all_entries = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            all_entries.extend(parse_page(page))

    # Validate + warn about anything unmapped
    for e in all_entries:
        if e["week"] is None:
            print(f"  WARN: unknown week for {e['date_text']!r}")
        if e["size"] is None:
            print(f"  WARN: unknown lodging {e['raw']!r}")

    available = [e for e in all_entries if not e["struck"] and e["week"] and e["size"]]
    openings = [
        {
            "week": e["week"],
            "size": e["size"],
            "raw": e["raw"],
            "dateRange": e["date_range"],
        }
        for e in available
    ]
    openings.sort(key=lambda o: (o["week"], o["size"]))

    payload = {
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
        "openings": openings,
    }
    out_path = "public/openings.json"
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2)

    # Summary
    total = len(all_entries)
    struck = sum(1 for e in all_entries if e["struck"])
    print(
        f"Parsed {total} entries: {struck} struck-through (excluded), {len(openings)} available"
    )
    print(f"Wrote {out_path}")

    # Per-week summary
    from collections import Counter

    by_week_size = Counter((o["week"], o["size"]) for o in openings)
    for (week, size), count in sorted(by_week_size.items()):
        print(f"  Week {week} {size}: {count}")


if __name__ == "__main__":
    main()

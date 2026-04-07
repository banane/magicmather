"""
PDF to CSV + JSON extractor for Camp Mather waitlist PDFs.

Uses pdfplumber for text-based extraction (no OCR/Tesseract needed).
Processes all PDFs in public/ and outputs:
  - public/<name>.csv   (raw table data)
  - public/data.json    (structured data for mather-engine)

Usage:
    python scripts/parse_pdf.py                    # all public/*.pdf
    python scripts/parse_pdf.py public/specific.pdf # single file
"""

import csv
import glob
import json
import re
import sys
import os

import pdfplumber

OUTPUT_JSON = "public/data.json"

CABIN_MAP = {
    "2": "2c",
    "3": "3c",
    "4": "4c",
    "5": "4c",  # 5-person not in inventory; nearest match
    "6": "6c",
}


def extract_tables_to_rows(pdf_path):
    """Extract tabular data from a PDF using pdfplumber's table detection."""
    all_rows = []

    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            tables = page.extract_tables()

            if tables:
                for table in tables:
                    for row in table:
                        cleaned = [cell.strip() if cell else "" for cell in row]
                        if any(cleaned):
                            all_rows.append(cleaned)
            else:
                # Fallback: extract raw text lines when no table structure detected
                text = page.extract_text()
                if text:
                    for line in text.split("\n"):
                        line = line.strip()
                        if line:
                            all_rows.append([line])

    return all_rows


def normalize_columns(rows):
    """Pad all rows to the same column count."""
    if not rows:
        return rows
    max_cols = max(len(r) for r in rows)
    return [r + [""] * (max_cols - len(r)) for r in rows]


def write_csv(rows, output_path):
    """Write rows to a CSV file."""
    rows = normalize_columns(rows)
    with open(output_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(rows)
    print(f"  -> {output_path} ({len(rows)} rows)")


def parse_cabin_code(code):
    """Map a cabin code like '4PC', '6PTS', '3PC' to engine format ('4c', '6c', '3c')."""
    code = code.strip().upper()
    match = re.match(r"(\d)", code)
    if match:
        return CABIN_MAP.get(match.group(1))
    return None


def rows_to_families(rows):
    """Convert extracted CSV rows into the family preference format for mather-engine.

    Each row: [rank, week1_cell, week2_cell, ..., week12_cell]
    Each cell: "" or "4PC,4PC" (comma-separated cabin codes)
    """
    if not rows:
        return []

    # Skip the header row
    data_rows = rows[1:]
    families = []

    for row in data_rows:
        if not row or not row[0]:
            continue

        # Parse rank from first column
        rank_str = re.sub(r"\D", "", row[0])
        if not rank_str:
            continue
        rank = int(rank_str)

        preferences = []
        # Columns 1-12 are weeks 1-12
        for col_idx in range(1, min(len(row), 13)):
            cell = row[col_idx].strip()
            if not cell:
                continue

            week = col_idx
            # Each cell can have multiple cabin codes (e.g. "4PC,3PC")
            codes = [c.strip() for c in cell.split(",") if c.strip()]
            seen = set()
            for code in codes:
                size = parse_cabin_code(code)
                if size and (week, size) not in seen:
                    seen.add((week, size))
                    preferences.append({"week": week, "size": size})

        if preferences:
            families.append({"rank": rank, "preferences": preferences})

    # Sort by rank, deduplicate
    unique = {f["rank"]: f for f in families}
    return sorted(unique.values(), key=lambda f: f["rank"])


def write_json(families, output_path):
    """Write families + scrape timestamp to JSON for mather-engine consumption."""
    from datetime import datetime, timezone
    payload = {
        "scrapedAt": datetime.now(timezone.utc).isoformat(),
        "families": families,
    }
    with open(output_path, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"  -> {output_path} ({len(families)} families)")


def process_pdf(pdf_path):
    """Process a single PDF: write CSV + build family data for JSON."""
    base = os.path.splitext(pdf_path)[0]
    csv_path = base + ".csv"

    print(f"Processing: {pdf_path}")
    rows = extract_tables_to_rows(pdf_path)

    if not rows:
        print(f"  -> No extractable content found in {pdf_path}")
        return None, []

    write_csv(rows, csv_path)
    families = rows_to_families(rows)
    return csv_path, families


def main():
    if len(sys.argv) > 1:
        pdf_files = sys.argv[1:]
    else:
        pdf_files = sorted(glob.glob("public/*.pdf"))

    if not pdf_files:
        print("No PDF files found in public/")
        sys.exit(1)

    print(f"Found {len(pdf_files)} PDF(s)\n")

    all_families = []
    csv_count = 0

    for pdf_path in pdf_files:
        if not os.path.exists(pdf_path):
            print(f"Skipping (not found): {pdf_path}")
            continue
        csv_path, families = process_pdf(pdf_path)
        if csv_path:
            csv_count += 1
        all_families.extend(families)

    # Deduplicate across PDFs and sort by rank
    unique = {f["rank"]: f for f in all_families}
    all_families = sorted(unique.values(), key=lambda f: f["rank"])

    write_json(all_families, OUTPUT_JSON)

    print(f"\nDone. Generated {csv_count} CSV file(s) and {OUTPUT_JSON}.")


if __name__ == "__main__":
    main()

"""
PDF to CSV extractor for Camp Mather waitlist PDFs.

Uses pdfplumber for text-based extraction (no OCR/Tesseract needed).
Processes all PDFs in public/ and writes corresponding CSV files.

Usage:
    python scripts/pdf_to_csv.py                    # all public/*.pdf
    python scripts/pdf_to_csv.py public/specific.pdf # single file
"""

import csv
import glob
import sys
import os

import pdfplumber


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


def process_pdf(pdf_path):
    """Process a single PDF and write a CSV alongside it."""
    base = os.path.splitext(pdf_path)[0]
    output_path = base + ".csv"

    print(f"Processing: {pdf_path}")
    rows = extract_tables_to_rows(pdf_path)

    if not rows:
        print(f"  -> No extractable content found in {pdf_path}")
        return None

    write_csv(rows, output_path)
    return output_path


def main():
    if len(sys.argv) > 1:
        pdf_files = sys.argv[1:]
    else:
        pdf_files = sorted(glob.glob("public/*.pdf"))

    if not pdf_files:
        print("No PDF files found in public/")
        sys.exit(1)

    print(f"Found {len(pdf_files)} PDF(s)\n")

    outputs = []
    for pdf_path in pdf_files:
        if not os.path.exists(pdf_path):
            print(f"Skipping (not found): {pdf_path}")
            continue
        result = process_pdf(pdf_path)
        if result:
            outputs.append(result)

    print(f"\nDone. Generated {len(outputs)} CSV file(s).")


if __name__ == "__main__":
    main()

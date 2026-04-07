import pytesseract
from pdf2image import convert_from_path
import csv
import re
import os

LOCAL_PATH = "public/WaitListCrosstab2026.pdf"
OUTPUT_CSV = "public/raw_dump.csv"

def fuzzy_match_cabin(text):
    """Simplified: just returns the cabin if it looks remotely like one."""
    t = text.lower().strip()
    if 'pc' in t or 'rc' in t or '4c' in t or '3c' in t or '6c' in t:
        # Standardize to a 2-character code if possible
        match = re.search(r'(\d)[pr]?c', t)
        return f"{match.group(1)}c" if match else t
    return None

def dump_to_csv():
    if not os.path.exists(LOCAL_PATH):
        print("Error: PDF not found.")
        return

    print("Converting PDF... this will take a moment.")
    # DPI 300 is usually enough for a raw dump and faster than 400
    pages = convert_from_path(LOCAL_PATH, dpi=300)
    
    with open(OUTPUT_CSV, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['Page', 'X', 'Y', 'RawText', 'InterpretedCabin'])

        for i, page in enumerate(pages):
            print(f"Scanning Page {i+1}...")
            data = pytesseract.image_to_data(page, output_type=pytesseract.Output.DICT)
            
            for j in range(len(data['text'])):
                text = data['text'][j].strip()
                if not text: continue
                
                cabin = fuzzy_match_cabin(text)
                # We save everything, but flag if we think it's a cabin
                writer.writerow([
                    i + 1, 
                    data['left'][j], 
                    data['top'][j], 
                    text, 
                    cabin if cabin else ""
                ])

    print(f"✅ Done! Raw data saved to {OUTPUT_CSV}")

if __name__ == "__main__":
    dump_to_csv()

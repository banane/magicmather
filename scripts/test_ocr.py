import pytesseract
from pdf2image import convert_from_path
import os

LOCAL_PATH = "public/WaitListCrosstab2026.pdf"

def test_raw_ocr():
    if not os.path.exists(LOCAL_PATH):
        print(f"Error: {LOCAL_PATH} not found. Please download it first.")
        return

    print(f"--- Starting Diagnostic Scan on {LOCAL_PATH} ---")
    
    try:
        # Increased DPI to 400 for better character recognition
        print("Converting PDF to Image (High Res)...")
        pages = convert_from_path(LOCAL_PATH, last_page=1, dpi=400)
    except Exception as e:
        print(f"Poppler Error: Could not convert PDF. {e}")
        return

    if not pages:
        print("Error: No pages found in PDF.")
        return

    page = pages[0]
    
    # 1. Simple String Dump
    print("\n--- ATTEMPT 1: RAW STRING DUMP ---")
    raw_text = pytesseract.image_to_string(page)
    
    if not raw_text.strip():
        print("RESULT: Page is blank. Tesseract found zero text.")
    else:
        print("CONTENT PREVIEW (First 1000 chars):")
        print("-" * 40)
        print(raw_text[:1000])
        print("-" * 40)

    # 2. Coordinate Check
    print("\n--- ATTEMPT 2: POSITION CHECK (Top 15 items) ---")
    data = pytesseract.image_to_data(page, output_type=pytesseract.Output.DICT)
    
    found_count = 0
    for i in range(len(data['text'])):
        text = data['text'][i].strip()
        if text and found_count < 15:
            print(f"[{found_count}] Found '{text}' at X={data['left'][i]}, Y={data['top'][i]}")
            found_count += 1

if __name__ == "__main__":
    test_raw_ocr() # Removed the trailing colon here

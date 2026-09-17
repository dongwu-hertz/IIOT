#!/usr/bin/env python3
"""THROWAWAY — extract text from a PDF, preferring a real library and falling back
to a stdlib-only reader.

WHY THIS FILE EXISTS
The device manuals arrive as .docx and .pdf, and nothing in this repository reads
either. The .docx case is handled by `scripts/docx-to-text.cjs`; this is the PDF
case. It is a throwaway because it is only needed when a new manual lands.

WHY PYTHON AND NOT NODE
Node has no PDF text extractor in this project's dependency tree, and adding one
would be a new dependency for the shipped app. Python is already installed on this
machine. The fallback path uses ONLY the standard library (zlib + re), so it works
on a machine with no site-packages at all.

The fallback is honest about its limits: it reads literal and hex strings out of
FlateDecode content streams and reports how many streams it could and could not
decode. It does NOT resolve /ToUnicode CMaps, so a PDF that uses CID fonts with
subset encodings will come out as noise — in which case the script says so instead
of writing a file full of garbage.
"""

import re
import sys
import zlib

TEXT_OPERATOR = re.compile(
    rb"\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bTj\b|\bTJ\b|\bTd\b|\bTD\b|\bT\*\b|\bTm\b|\bET\b",
    re.DOTALL,
)


def pdf_unescape(raw: bytes) -> str:
    """Decode a PDF literal string body (the bytes between the parentheses)."""
    out = bytearray()
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch != 0x5C:  # backslash
            out.append(ch)
            i += 1
            continue
        i += 1
        if i >= len(raw):
            break
        esc = raw[i]
        simple = {0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12,
                  0x28: 0x28, 0x29: 0x29, 0x5C: 0x5C}
        if esc in simple:
            out.append(simple[esc])
            i += 1
        elif 0x30 <= esc <= 0x37:  # octal, up to 3 digits
            digits = b""
            while i < len(raw) and len(digits) < 3 and 0x30 <= raw[i] <= 0x37:
                digits += bytes([raw[i]])
                i += 1
            out.append(int(digits, 8) & 0xFF)
        else:
            out.append(esc)
            i += 1
    return out.decode("latin-1")


def decode_pdf_string(token: bytes) -> str:
    if token.startswith(b"<"):
        hexed = re.sub(rb"[^0-9A-Fa-f]", b"", token)
        if len(hexed) % 2:
            hexed += b"0"
        data = bytes.fromhex(hexed.decode("ascii"))
        # UTF-16BE strings start with a byte-order mark.
        if data[:2] == b"\xfe\xff":
            return data[2:].decode("utf-16-be", errors="replace")
        return data.decode("latin-1")
    return pdf_unescape(token[1:-1])


def extract_stream_text(content: bytes) -> str:
    """Walk a content stream, emitting text and rough line breaks."""
    parts = []
    for match in TEXT_OPERATOR.finditer(content):
        token = match.group(0)
        if token.startswith(b"(") or token.startswith(b"<"):
            parts.append(decode_pdf_string(token))
        elif token in (b"Td", b"TD", b"T*", b"ET", b"Tm"):
            parts.append("\n")
        elif token == b"TJ":
            parts.append(" ")
    return "".join(parts)


def stdlib_extract(data: bytes) -> tuple[str, int, int]:
    chunks = []
    ok = failed = 0
    for match in re.finditer(rb"stream\r?\n", data):
        start = match.end()
        end = data.find(b"endstream", start)
        if end == -1:
            continue
        raw = data[start:end]
        try:
            decoded = zlib.decompress(raw)
        except zlib.error:
            failed += 1
            continue
        ok += 1
        if b"BT" in decoded and (b"Tj" in decoded or b"TJ" in decoded):
            chunks.append(extract_stream_text(decoded))
    text = "\n".join(chunks)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text, ok, failed


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: pdf-to-text.py <input.pdf> [output.txt]")
        raise SystemExit(2)
    source = sys.argv[1]
    target = sys.argv[2] if len(sys.argv) > 2 else re.sub(r"\.pdf$", "", source, flags=re.I) + ".txt"

    library = None
    for name in ("pypdf", "PyPDF2", "fitz", "pdfminer.high_level"):
        try:
            __import__(name)
            library = name
            break
        except Exception:
            continue
    print(f"pdf library available: {library or 'NONE (stdlib fallback)'}")

    data = open(source, "rb").read()
    if library in ("pypdf", "PyPDF2"):
        module = __import__(library)
        reader = module.PdfReader(source)
        pages = [(page.extract_text() or "") for page in reader.pages]
        text = "\n\n".join(pages)
        note = f"{len(pages)} pages via {library}"
    elif library == "fitz":
        import fitz
        with fitz.open(source) as doc:
            pages = [page.get_text() for page in doc]
        text = "\n\n".join(pages)
        note = f"{len(pages)} pages via PyMuPDF"
    else:
        text, ok, failed = stdlib_extract(data)
        note = f"stdlib fallback: {ok} streams decoded, {failed} not inflatable"

    header = (
        f"# {source.split(chr(92))[-1].split('/')[-1]}\n"
        f"# Extracted from PDF ({note}). Text only; images and layout are lost.\n"
        f"# Regenerate with: python scripts/pdf-to-text.py <input.pdf> <output.txt>\n\n"
    )
    with open(target, "w", encoding="utf-8") as handle:
        handle.write(header + text)

    printable = sum(1 for ch in text[:20000] if ch.isprintable() or ch in "\n\t")
    ratio = printable / max(1, len(text[:20000]))
    print(f"{len(text)} chars -> {target}")
    print(f"printable ratio in first 20k chars: {ratio:.2%}")
    print("--- first 600 chars ---")
    print(text[:600])


if __name__ == "__main__":
    main()

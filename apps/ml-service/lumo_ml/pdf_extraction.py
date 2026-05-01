from __future__ import annotations

import os
import tempfile
import urllib.request
from collections import defaultdict
from typing import Any

from .schemas import ExtractPdfRequest, ExtractPdfResponse, PdfBlock, PdfPage

MAX_PDF_BYTES = 100 * 1024 * 1024


def extract_pdf_document(req: ExtractPdfRequest) -> ExtractPdfResponse:
    partition_pdf = _load_partition_pdf()
    if partition_pdf is None:
        return ExtractPdfResponse(
            status="not_configured",
            pages=[],
            total_pages=0,
            language=None,
            _lumo_summary="PDF extraction is scaffolded, but unstructured[pdf] is not installed.",
        )

    tmp_path: str | None = None
    try:
        tmp_path = _download_pdf(req.pdf_url)
        elements = partition_pdf(
            filename=tmp_path,
            strategy="fast",
            infer_table_structure=True,
        )
        pages = _elements_to_pages(elements)
        total_pages = max((page.page_number for page in pages), default=0)
        return ExtractPdfResponse(
            status="ok",
            pages=pages,
            total_pages=total_pages,
            language=_language_from_elements(elements),
            _lumo_summary=(
                f"Extracted {sum(len(page.blocks) for page in pages)} PDF block"
                f"{'s' if sum(len(page.blocks) for page in pages) != 1 else ''} "
                f"from {total_pages} page{'s' if total_pages != 1 else ''}."
            ),
        )
    except Exception as exc:
        return ExtractPdfResponse(
            status="error",
            pages=[],
            total_pages=0,
            language=None,
            _lumo_summary=f"PDF extraction failed: {str(exc)[:180]}",
        )
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _load_partition_pdf() -> Any | None:
    try:
        from unstructured.partition.pdf import partition_pdf
    except Exception:
        return None
    return partition_pdf


def _download_pdf(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Lumo-ML-Service/0.1 PDF extractor"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        content_type = response.headers.get("content-type", "")
        if content_type and "pdf" not in content_type.lower() and "octet-stream" not in content_type.lower():
            raise ValueError(f"URL did not return a PDF content type: {content_type[:80]}")
        remaining = MAX_PDF_BYTES + 1
        chunks: list[bytes] = []
        while remaining > 0:
            chunk = response.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > MAX_PDF_BYTES:
            raise ValueError("PDF exceeds 100MB limit")

    handle = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
    try:
        handle.write(data)
        return handle.name
    finally:
        handle.close()


def _elements_to_pages(elements: list[Any]) -> list[PdfPage]:
    by_page: dict[int, list[PdfBlock]] = defaultdict(list)
    for element in elements:
        text = str(getattr(element, "text", "") or "").strip()
        if not text:
            continue
        metadata = getattr(element, "metadata", None)
        page_number = getattr(metadata, "page_number", None)
        if not isinstance(page_number, int) or page_number < 1:
            page_number = 1
        by_page[page_number].append(
            PdfBlock(
                type=_block_type(element),
                text=text,
                bbox=_bbox_from_element(element),
            )
        )
    return [
        PdfPage(page_number=page_number, blocks=blocks)
        for page_number, blocks in sorted(by_page.items())
    ]


def _block_type(element: Any) -> str:
    category = str(getattr(element, "category", "") or type(element).__name__).lower()
    if any(term in category for term in ["title", "heading", "header"]):
        return "heading"
    if "table" in category:
        return "table"
    if any(term in category for term in ["list", "bulleted"]):
        return "list"
    return "paragraph"


def _bbox_from_element(element: Any) -> list[float] | None:
    metadata = getattr(element, "metadata", None)
    coordinates = getattr(metadata, "coordinates", None)
    points = getattr(coordinates, "points", None)
    if not points:
        return None
    try:
        xs = [float(point[0]) for point in points]
        ys = [float(point[1]) for point in points]
    except (TypeError, ValueError, IndexError):
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def _language_from_elements(elements: list[Any]) -> str | None:
    for element in elements:
        metadata = getattr(element, "metadata", None)
        languages = getattr(metadata, "languages", None)
        if isinstance(languages, list) and languages:
            first = languages[0]
            if isinstance(first, str) and first:
                return first
    return None

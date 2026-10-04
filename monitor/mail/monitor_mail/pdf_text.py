"""PDF 文本提取（pypdf）。疑似扫描版只标记、不做 OCR（方案 8.2 第 7 条）。"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass

from pypdf import PdfReader
from pypdf.errors import PyPdfError

#: 与 openapi ParseResult.parse_status 一致。
PARSED = "parsed"
SUSPECTED_SCANNED = "suspected_scanned"
FAILED = "failed"


@dataclass(frozen=True)
class PdfTextResult:
    parse_status: str
    text: str
    page_count: int | None
    error: str | None = None


def is_pdf(data: bytes) -> bool:
    """按内容头判断（邮件附件的扩展名与 content_type 常常不可信）。"""
    return data.startswith(b"%PDF-")


def extract_pdf_text(data: bytes, *, min_chars_per_page: int = 20) -> PdfTextResult:
    """提取文本层。平均每页非空白字符少于阈值时判为疑似扫描版（不 OCR）。

    损坏、加密或不是 PDF 时返回 ``failed`` 并给出原因，不抛异常。
    """
    if not is_pdf(data):
        return PdfTextResult(FAILED, "", None, "not_a_pdf")
    # pypdf 遇到轻微格式问题会打警告日志，这里不需要。
    logging.getLogger("pypdf").setLevel(logging.ERROR)
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            return PdfTextResult(FAILED, "", None, "encrypted_pdf")
        pages = [page.extract_text() or "" for page in reader.pages]
    except (PyPdfError, ValueError, KeyError, TypeError, OSError) as exc:
        return PdfTextResult(FAILED, "", None, f"pdf_unreadable: {type(exc).__name__}"[:500])
    page_count = len(pages)
    text = "\n\f\n".join(p.strip() for p in pages).strip()
    meaningful = sum(1 for ch in text if not ch.isspace())
    if page_count == 0 or meaningful < min_chars_per_page * page_count:
        return PdfTextResult(SUSPECTED_SCANNED, text, page_count)
    return PdfTextResult(PARSED, text, page_count)

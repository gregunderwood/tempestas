"""One timestamp parser for every command judge."""

from __future__ import annotations

import re
from datetime import datetime

# As strict as the TypeScript judge; a naive time cannot be compared.
ISO_8601_INSTANT = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", re.ASCII
)


def parse_instant(text: str) -> datetime | None:
    if not ISO_8601_INSTANT.fullmatch(text):
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        # The pattern checks shape only; month 13 still gets here.
        return None

"""Reading a command's timestamps the one way every command judge expects."""

from __future__ import annotations

import re
from datetime import datetime

# Stricter than fromisoformat, like the reference; an offset too, as a naive time cannot compare.
ISO_8601_INSTANT = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", re.ASCII
)


def parse_instant(text: str) -> datetime | None:
    if not ISO_8601_INSTANT.fullmatch(text):
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        # The pattern checks the shape only, so a month 13 still reaches here.
        return None

"""Redact known secret values from Worker log and error text.

The Worker never intentionally logs credentials, but prepare commands, Prime
Agent stderr, and SDK errors can echo the environment. This module removes the
exact values of secret-looking environment variables plus common
``Authorization`` header forms before text is logged or reported.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable, Mapping

REDACTED = "[REDACTED]"

_SECRET_NAME = re.compile(r"(_TOKEN|_KEY|_SECRET|_PASSWORD)$", re.IGNORECASE)
_AUTHORIZATION = re.compile(
    r"(?i)(\bauthorization\b\s*[:=]\s*bearer\s+)[^\s,;\"']+"
)
_BEARER = re.compile(r"(?i)(\bbearer\s+)[A-Za-z0-9._~+/=\-]+")
_MIN_SECRET_LENGTH = 4


def secret_values(
    env: Mapping[str, str] | None = None,
    extra: Iterable[str] = (),
) -> list[str]:
    """Return secret-looking values from ``env`` (the process environment by default)."""
    source = env if env is not None else os.environ
    values = {
        value
        for name, value in source.items()
        if value and len(value) >= _MIN_SECRET_LENGTH and _SECRET_NAME.search(name)
    }
    values.update(value for value in extra if value and len(value) >= _MIN_SECRET_LENGTH)
    return sorted(values, key=len, reverse=True)


def redact_secrets(
    text: str,
    env: Mapping[str, str] | None = None,
    extra: Iterable[str] = (),
) -> str:
    """Replace known secret values and Authorization/Bearer tokens in ``text``."""
    if not text:
        return text
    redacted = text
    for value in secret_values(env, extra):
        redacted = redacted.replace(value, REDACTED)
    redacted = _AUTHORIZATION.sub(lambda match: match.group(1) + REDACTED, redacted)
    redacted = _BEARER.sub(lambda match: match.group(1) + REDACTED, redacted)
    return redacted

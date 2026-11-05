"""Command-name shims that block configured commands for one Assignment.

These shims are a policy aid, not a sandbox: an absolute path or an unlisted
interpreter can still run the same program.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Iterable

BLOCKED_BIN_DIR = ".super-rlm-bin"
BLOCKED_EXIT_CODE = 127


def install_blocked_shims(workspace: Path, commands: Iterable[str]) -> Path | None:
    """(Re)create ``<workspace>/.super-rlm-bin`` with one shim per command.

    The directory is always rebuilt so a retry with a different profile cannot
    leave stale shims behind. Returns the shim directory, or ``None`` when no
    command is blocked.
    """
    names = list(commands)
    bin_dir = workspace / BLOCKED_BIN_DIR
    if bin_dir.exists():
        shutil.rmtree(bin_dir)
    if not names:
        return None
    bin_dir.mkdir(parents=True)
    for name in names:
        shim = bin_dir / name
        shim.write_text(
            "#!/bin/sh\n"
            f"echo \"blocked by super-rlm profile: {name}\" >&2\n"
            f"exit {BLOCKED_EXIT_CODE}\n",
            encoding="utf-8",
            newline="\n",
        )
        try:
            shim.chmod(0o755)
        except OSError:
            pass
    return bin_dir

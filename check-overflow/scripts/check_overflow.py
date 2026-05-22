#!/usr/bin/env python3
"""Compatibility wrapper for the JS reveal.js overflow checker.

The old checker rendered through decktape/PDF and scanned edge pixels. That was
slow and missed content that was clipped before it reached the slide edge.
`check_overflow.js` now performs the primary check in Chromium via DOM layout
metrics, with screenshot edge scanning as a secondary guard.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    script = Path(__file__).with_suffix(".js")
    if not script.is_file():
        print(f"missing JS checker: {script}", file=sys.stderr)
        return 2

    node = os.environ.get("NODE", "node")
    completed = subprocess.run([node, str(script), *sys.argv[1:]])
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())

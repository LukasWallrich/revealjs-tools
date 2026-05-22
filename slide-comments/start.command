#!/bin/bash
# Double-click this file on macOS to launch the slide-comments server.
set -e
cd "$(dirname "$0")"
PY=python3
if ! command -v "$PY" >/dev/null 2>&1; then
  if command -v python >/dev/null 2>&1; then
    PY=python
  else
    echo "Python 3 not found. Install from https://www.python.org/ and try again."
    read -n 1 -s -r -p "Press any key to close..."
    exit 1
  fi
fi
exec "$PY" server.py "$@"

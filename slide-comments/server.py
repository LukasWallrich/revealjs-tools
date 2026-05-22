#!/usr/bin/env python3
"""
slide-comments server: serves the parent directory and accepts comment writes.

Run with an HTML file path. The server roots itself at that file's directory
and serves overlay assets from this tool directory.

Endpoints:
  GET  /*                                     static files from project root
  POST /save-comments?file=<htmlname>         body: full comments JSON
  POST /save-snapshot?file=<...>&slide=<cid>  body: {"dataUrl": "data:image/png;base64,..."}
  POST /save-pasted-image?file=<...>&slide=<cid>  body: {"dataUrl": "data:image/<ext>;base64,..."}
                                              -> {"path": "<basename>.comments/pasted/<file>"}
  POST /delete-pasted-image?file=<...>        body: {"path": "<basename>.comments/pasted/<file>"}
  GET  /html-mtime?file=<htmlname>            {"mtime": <epoch_float>}
"""

from __future__ import annotations

import argparse
import base64
import html as html_lib
import json
import os
import re
import secrets
import sys
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("SLIDE_COMMENTS_PORT", "8765"))
TOOL_DIR = Path(__file__).resolve().parent
ROOT = Path.cwd().resolve()
SAFE_NAME = re.compile(r"^[^/\\]+\.html?$", re.IGNORECASE)
OVERLAY_TAGS = """<link rel="stylesheet" href="slide-comments/overlay.css">
<script src="slide-comments/overlay.js" defer></script>"""


def resolve_selected_html(name: str) -> Path:
    candidate = Path(name)
    if candidate.is_absolute():
        p = candidate.resolve()
    else:
        p = (Path.cwd() / candidate).resolve()
    if not p.is_file() or not SAFE_NAME.match(p.name):
        raise ValueError(f"html not found: {name!r}")
    return p


def resolve_html(name: str) -> Path:
    candidate = Path(name)
    if candidate.is_absolute() or candidate.parent != Path("."):
        raise ValueError(f"unsafe html filename: {name!r}")
    if not SAFE_NAME.match(candidate.name):
        raise ValueError(f"unsafe html filename: {name!r}")
    p = (ROOT / candidate.name).resolve()
    if p.parent != ROOT or not p.is_file():
        raise ValueError(f"html not found: {name!r}")
    return p


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp-{secrets.token_hex(4)}")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def atomic_write_text(path: Path, text: str) -> None:
    atomic_write_bytes(path, text.encode("utf-8"))


def sidecar_json(html: Path) -> Path:
    return html.parent / f"{html.stem}.comments.json"


def snapshot_dir(html: Path) -> Path:
    return html.parent / f"{html.stem}.comments"


def pasted_image_dir(html: Path) -> Path:
    return snapshot_dir(html) / "pasted"


# Allowed image MIME types for clipboard paste. Extension is the saved suffix.
PASTED_IMAGE_EXTS = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
}


def short_cid(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(4)}"


def html_files() -> list[Path]:
    return sorted(
        p
        for p in ROOT.iterdir()
        if p.is_file() and p.suffix.lower() in {".html", ".htm"} and not p.name.startswith("_")
    )


def find_slides_marker(source: str) -> int:
    m = re.search(
        r'<[^>]+\bclass=(["\'])(?=[^"\']*\bslides\b)[^"\']*\1',
        source,
        re.IGNORECASE,
    )
    return m.start() if m else -1


def find_matching_close(html: str, open_start: int, tag: str) -> tuple[int, int] | None:
    """Return the closing tag span for the element whose open tag starts at open_start."""
    open_end = html.find(">", open_start)
    if open_end == -1:
        return None
    tag_pat = re.compile(
        r"<(/?)" + re.escape(tag) + r"\b[^>]*>",
        re.IGNORECASE,
    )
    depth = 1
    pos = open_end + 1
    while True:
        m = tag_pat.search(html, pos)
        if not m:
            return None
        if m.group(1) == "/":
            depth -= 1
            if depth == 0:
                return m.start(), m.end()
        else:
            token = m.group(0)
            if not token.rstrip().endswith("/>"):
                depth += 1
        pos = m.end()


def has_data_cid(tag: str) -> str | None:
    m = re.search(r'data-cid="([^"]+)"', tag)
    return m.group(1) if m else None


def inject_attr(tag: str, cid: str) -> str:
    # insert data-cid="cid" right after the tag name
    return re.sub(r"^<(\w+)", lambda m: f"<{m.group(1)} data-cid=\"{cid}\"", tag, count=1)


def has_commentable_class(tag: str) -> bool:
    m = re.search(r'\bclass="([^"]*)"', tag)
    if not m:
        return False
    return bool(
        re.search(
            r"\b(item|tile|row|cell|node|card|step|term|edge|center|box|head|sub|text|num|word|marker|kicker|subtitle|author|caveat|source-note|big-claim)\b",
            m.group(1),
        )
    )


def html_to_text(fragment: str) -> str:
    fragment = re.sub(r"<!--.*?-->", "", fragment, flags=re.DOTALL)
    fragment = re.sub(r"<script\b.*?</script\s*>", "", fragment, flags=re.IGNORECASE | re.DOTALL)
    fragment = re.sub(r"<style\b.*?</style\s*>", "", fragment, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()


def meaningful_text(fragment: str) -> bool:
    return len(html_to_text(fragment)) >= 2


def sanitize_inner_html(html: str) -> str:
    """Strip browser-injected formatting that pollutes contenteditable saves.

    Specifically targets the patterns Chrome/Safari add when typing into
    contenteditable elements (which would otherwise creep into the source HTML
    on every direct edit):
      - <font ...>...</font>   ->  ...
      - <span style="...">...</span>  ->  ...
      - style="..." attributes on other tags  ->  removed
      - &nbsp; (NO-BREAK SPACE) at start/end  ->  regular space
    """
    # Unwrap <font ...>...</font>
    html = re.sub(r"<font\b[^>]*>", "", html, flags=re.IGNORECASE)
    html = re.sub(r"</font\s*>", "", html, flags=re.IGNORECASE)
    # Unwrap span tags that only carry inline style (a span with no other
    # attributes besides style="..."). Leave classed spans alone.
    html = re.sub(
        r'<span\s+style="[^"]*"\s*>',
        "",
        html,
        flags=re.IGNORECASE,
    )
    # Drop any style="..." attribute (regardless of tag).
    html = re.sub(r'\s+style="[^"]*"', "", html, flags=re.IGNORECASE)
    # Closing span tags that no longer have an opening should be kept as-is
    # only when paired; a tiny imbalance is rare in practice. We leave them
    # alone to avoid over-aggressive rewriting.
    return html


VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
}


def parse_fragment_tree(fragment: str) -> dict:
    """Build a tiny source-position tree for the simple slide HTML we emit."""
    root = {"tag": "#root", "children": [], "start": 0, "end": len(fragment)}
    stack = [root]
    tag_pat = re.compile(r"<!--.*?-->|<(/?)([A-Za-z][\w:-]*)(?:\s[^>]*)?>", re.DOTALL)
    for m in tag_pat.finditer(fragment):
        if m.group(0).startswith("<!--"):
            continue
        closing = bool(m.group(1))
        tag = m.group(2).lower()
        if closing:
            for i in range(len(stack) - 1, 0, -1):
                if stack[i]["tag"] == tag:
                    while len(stack) - 1 > i:
                        unclosed = stack.pop()
                        unclosed["close_start"] = m.start()
                        unclosed.setdefault("end", m.start())
                    node = stack.pop()
                    node["close_start"] = m.start()
                    node["end"] = m.end()
                    break
            continue
        node = {
            "tag": tag,
            "children": [],
            "start": m.start(),
            "open_end": m.end(),
            "close_start": m.end(),
            "end": m.end(),
        }
        stack[-1]["children"].append(node)
        token = m.group(0).rstrip()
        if tag not in VOID_TAGS and not token.endswith("/>"):
            stack.append(node)
    while len(stack) > 1:
        node = stack.pop()
        node["close_start"] = len(fragment)
        node["end"] = len(fragment)
    return root


EXCLUDED_TEXT_TAGS = {"aside", "script", "style", "template", "svg", "math"}
FORMAT_ONLY_TAGS = {
    "b", "cite", "code", "dfn", "em", "i", "kbd", "mark", "q", "s", "samp",
    "small", "strong", "sub", "sup", "u", "var",
}


def direct_text_for_node(fragment: str, node: dict) -> str:
    """Return text directly inside node, excluding child element subtrees."""
    start = int(node.get("open_end", node["start"]))
    end = int(node.get("close_start", node.get("end", len(fragment))))
    pieces: list[str] = []
    pos = start
    for child in node.get("children", []):
        child_start = int(child["start"])
        if child_start > pos:
            pieces.append(fragment[pos:child_start])
        pos = max(pos, int(child.get("end", child_start)))
    if pos < end:
        pieces.append(fragment[pos:end])
    return html_to_text(" ".join(pieces))


def node_has_meaningful_subtree(fragment: str, node: dict) -> bool:
    start = int(node.get("open_end", node["start"]))
    end = int(node.get("close_start", node.get("end", len(fragment))))
    return meaningful_text(fragment[start:end])


def collect_commentable_element_spans(fragment: str) -> list[tuple[int, int]]:
    tree = parse_fragment_tree(fragment)
    spans: list[tuple[int, int]] = []

    def walk(node: dict, excluded: bool = False) -> None:
        tag = str(node.get("tag", "")).lower()
        node_excluded = excluded or tag in EXCLUDED_TEXT_TAGS
        for child in node.get("children", []):
            walk(child, node_excluded)
        if node is tree or node_excluded or tag in FORMAT_ONLY_TAGS:
            return
        open_start = int(node["start"])
        open_end = int(node["open_end"])
        open_tag = fragment[open_start:open_end]
        if has_data_cid(open_tag) or not node_has_meaningful_subtree(fragment, node):
            return
        direct_text = direct_text_for_node(fragment, node)
        has_text_child = any(node_has_meaningful_subtree(fragment, c) for c in node.get("children", []))
        if direct_text or has_commentable_class(open_tag) or not has_text_child:
            spans.append((open_start, open_end))

    walk(tree)
    return spans


def augment_html_source(source: str) -> tuple[str, int]:
    inserts: list[tuple[int, int, str]] = []
    count = 0
    if "slide-comments/overlay.js" not in source:
        body_close = re.search(r"</body\s*>", source, re.IGNORECASE)
        overlay_block = f"\n{OVERLAY_TAGS}\n"
        if body_close:
            source = source[:body_close.start()] + overlay_block + source[body_close.start():]
        else:
            source = source.rstrip() + overlay_block
        count += 1

    slides_marker = find_slides_marker(source)
    if slides_marker == -1:
        return source, count

    # Add slide anchors first. This keeps slide identity stable before any
    # element-level work and mirrors the IDs expected by comment records.
    for m in re.finditer(r"<section\b[^>]*>", source[slides_marker:], re.IGNORECASE):
        start = slides_marker + m.start()
        end = slides_marker + m.end()
        tag = source[start:end]
        if not has_data_cid(tag):
            inserts.append((start, end, inject_attr(tag, short_cid("s"))))
    if inserts:
        count += len(inserts)
        for start, end, replacement in sorted(inserts, reverse=True):
            source = source[:start] + replacement + source[end:]
        inserts = []

    for m in re.finditer(r"<section\b[^>]*>", source[slides_marker:], re.IGNORECASE):
        sec_start = slides_marker + m.start()
        sec_end = slides_marker + m.end()
        close = find_matching_close(source, sec_start, "section")
        if close is None:
            continue
        body = source[sec_end:close[0]]
        for body_start, body_end in collect_commentable_element_spans(body):
            tag = body[body_start:body_end]
            inserts.append((sec_end + body_start, sec_end + body_end, inject_attr(tag, short_cid("e"))))

    if not inserts:
        return source, count
    count += len(inserts)
    for start, end, replacement in sorted(inserts, reverse=True):
        source = source[:start] + replacement + source[end:]
    return source, count


def augment_html_file(path: Path) -> int:
    source = path.read_text(encoding="utf-8")
    augmented, count = augment_html_source(source)
    if count:
        atomic_write_text(path, augmented)
    return count


def augment_all_html_files() -> None:
    for html in html_files():
        try:
            count = augment_html_file(html)
        except Exception as e:  # noqa: BLE001
            print(f"[slide-comments] could not augment {html.name}: {type(e).__name__}: {e}")
            continue
        if count:
            print(f"[slide-comments] added {count} missing data-cid anchors to {html.name}")


def find_element_inner_span(html: str, cid: str) -> tuple[int, int] | None:
    """Return (inner_start, inner_end) char offsets for the element with data-cid=cid.

    `inner_start` is the index just after the opening tag's `>`; `inner_end` is the
    index of the matching closing tag's `<`. Replacing [inner_start, inner_end]
    rewrites the element's innerHTML while preserving its outer tag and attributes.
    """
    open_pat = re.compile(
        r'<(\w+)\b[^>]*\bdata-cid="' + re.escape(cid) + r'"[^>]*>',
        re.IGNORECASE,
    )
    m = open_pat.search(html)
    if not m:
        return None
    tag = m.group(1)
    open_end = m.end()
    # Walk forward, counting opens and closes of the same tag name.
    tag_pat = re.compile(
        r"<(/?)" + re.escape(tag) + r"\b[^>]*>",
        re.IGNORECASE,
    )
    depth = 1
    pos = open_end
    while True:
        nm = tag_pat.search(html, pos)
        if not nm:
            return None
        if nm.group(1) == "/":
            depth -= 1
        else:
            depth += 1
        if depth == 0:
            return (open_end, nm.start())
        pos = nm.end()


class Handler(SimpleHTTPRequestHandler):
    # Serve deck files from ROOT and overlay assets from TOOL_DIR.
    def translate_path(self, path: str) -> str:
        path = path.split("?", 1)[0].split("#", 1)[0]
        path = urllib.parse.unquote(path)
        parts = [p for p in path.split("/") if p and p != ".."]
        if parts and parts[0] == "slide-comments":
            return str(TOOL_DIR.joinpath(*parts[1:]))
        return str(ROOT.joinpath(*parts))

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[slide-comments] {self.address_string()} - {fmt % args}\n")

    def end_headers(self) -> None:
        # Aggressive no-cache for everything: this is a dev tool and we don't
        # want stale overlay.js / overlay.css to mask edits.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status: int, message: str) -> None:
        self._send_json({"ok": False, "error": message}, status=status)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _params(self):
        q = urllib.parse.urlparse(self.path).query
        return dict(urllib.parse.parse_qsl(q))

    # --- GET routes ----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/html-mtime":
            self.route_html_mtime()
            return
        if parsed.path == "/__server-info":
            self._send_json({
                "ok": True,
                "root": str(ROOT),
                "toolDir": str(TOOL_DIR),
                "port": PORT,
            })
            return
        self.augment_html_before_serving(parsed.path)
        super().do_GET()

    def augment_html_before_serving(self, request_path: str) -> None:
        name = Path(urllib.parse.unquote(request_path)).name
        if not name.lower().endswith((".html", ".htm")):
            return
        try:
            html = resolve_html(name)
            count = augment_html_file(html)
        except Exception as e:  # noqa: BLE001
            print(f"[slide-comments] could not augment {name}: {type(e).__name__}: {e}")
            return
        if count:
            print(f"[slide-comments] added {count} missing data-cid anchors to {name}")

    def route_html_mtime(self) -> None:
        try:
            html = resolve_html(self._params().get("file", ""))
        except ValueError as e:
            self._send_error(400, str(e))
            return
        self._send_json({"ok": True, "mtime": html.stat().st_mtime})

    # --- POST routes ---------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/save-comments":
                self.route_save_comments()
            elif parsed.path == "/save-snapshot":
                self.route_save_snapshot()
            elif parsed.path == "/save-element-html":
                self.route_save_element_html()
            elif parsed.path == "/save-pasted-image":
                self.route_save_pasted_image()
            elif parsed.path == "/delete-pasted-image":
                self.route_delete_pasted_image()
            else:
                self._send_error(404, f"unknown route: {parsed.path}")
        except ValueError as e:
            self._send_error(400, str(e))
        except Exception as e:  # noqa: BLE001
            self._send_error(500, f"{type(e).__name__}: {e}")

    def route_save_comments(self) -> None:
        html = resolve_html(self._params().get("file", ""))
        payload = self._read_json()
        if not isinstance(payload, dict) or "comments" not in payload:
            raise ValueError("payload must be an object with a 'comments' array")
        if not isinstance(payload["comments"], list):
            raise ValueError("'comments' must be an array")
        payload.setdefault("version", 1)
        payload["presentation"] = html.name
        out = sidecar_json(html)
        atomic_write_text(out, json.dumps(payload, indent=2) + "\n")
        self._send_json({"ok": True, "htmlMtime": html.stat().st_mtime, "path": out.name})

    def route_save_snapshot(self) -> None:
        params = self._params()
        html = resolve_html(params.get("file", ""))
        slide = params.get("slide", "")
        if not re.fullmatch(r"s-[A-Za-z0-9][A-Za-z0-9-]{3,63}", slide):
            raise ValueError(f"unsafe slide id: {slide!r}")
        payload = self._read_json()
        data_url = payload.get("dataUrl", "")
        m = re.match(r"data:image/png;base64,(.+)$", data_url)
        if not m:
            raise ValueError("dataUrl must be a base64-encoded PNG data URL")
        png = base64.b64decode(m.group(1))
        out = snapshot_dir(html) / f"{slide}.png"
        atomic_write_bytes(out, png)
        rel = out.relative_to(ROOT).as_posix()
        self._send_json({"ok": True, "path": rel, "bytes": len(png)})

    def route_save_pasted_image(self) -> None:
        import time

        params = self._params()
        html = resolve_html(params.get("file", ""))
        slide = params.get("slide", "")
        if not re.fullmatch(r"s-[A-Za-z0-9][A-Za-z0-9-]{3,63}", slide):
            raise ValueError(f"unsafe slide id: {slide!r}")
        payload = self._read_json()
        data_url = payload.get("dataUrl", "")
        m = re.match(r"data:(image/[A-Za-z0-9.+-]+);base64,(.+)$", data_url)
        if not m:
            raise ValueError("dataUrl must be a base64-encoded image data URL")
        mime = m.group(1).lower()
        ext = PASTED_IMAGE_EXTS.get(mime)
        if ext is None:
            raise ValueError(f"unsupported image type: {mime}")
        try:
            raw = base64.b64decode(m.group(2), validate=True)
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"could not decode image bytes: {e}") from e
        ts = time.strftime("%Y%m%d-%H%M%S")
        name = f"{ts}-{slide}-{secrets.token_hex(3)}.{ext}"
        out = pasted_image_dir(html) / name
        atomic_write_bytes(out, raw)
        rel = out.relative_to(ROOT).as_posix()
        self._send_json({"ok": True, "path": rel, "bytes": len(raw)})

    def route_delete_pasted_image(self) -> None:
        html = resolve_html(self._params().get("file", ""))
        payload = self._read_json()
        rel = str(payload.get("path", ""))
        # Hard-constrain the path: must be inside this deck's pasted dir.
        prefix = pasted_image_dir(html).relative_to(ROOT).as_posix() + "/"
        if not rel.startswith(prefix) or "/.." in rel or rel.endswith("/.."):
            raise ValueError("path must point inside the deck's pasted/ directory")
        target = (ROOT / rel).resolve()
        if not str(target).startswith(str(pasted_image_dir(html).resolve())):
            raise ValueError("resolved path escapes the pasted/ directory")
        if target.exists():
            target.unlink()
        self._send_json({"ok": True})

    def route_save_element_html(self) -> None:
        html_path = resolve_html(self._params().get("file", ""))
        payload = self._read_json()
        cid = payload.get("cid", "")
        if not re.fullmatch(r"[se]-[A-Za-z0-9][A-Za-z0-9-]{3,63}", cid):
            raise ValueError(f"unsafe cid: {cid!r}")
        new_inner = payload.get("innerHtml")
        if not isinstance(new_inner, str):
            raise ValueError("innerHtml must be a string")
        new_inner = sanitize_inner_html(new_inner)
        pre_mtime = html_path.stat().st_mtime
        last_mtime = payload.get("lastMtime")
        stale = (
            isinstance(last_mtime, (int, float))
            and pre_mtime > last_mtime + 0.001
        )
        source = html_path.read_text(encoding="utf-8")
        span = find_element_inner_span(source, cid)
        if span is None:
            raise ValueError(f"no element with cid {cid!r} found")
        inner_start, inner_end = span
        new_source = source[:inner_start] + new_inner + source[inner_end:]
        atomic_write_text(html_path, new_source)
        result = {
            "ok": True,
            "htmlMtime": html_path.stat().st_mtime,
        }
        if stale:
            result["stale"] = True
        self._send_json(result)


def choose_html_with_dialog() -> str | None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as e:  # noqa: BLE001
        print(f"[slide-comments] file picker unavailable: {type(e).__name__}: {e}")
        return None

    root = None
    try:
        root = tk.Tk()
        root.withdraw()
        root.update()
        selected = filedialog.askopenfilename(
            title="Choose a presentation HTML file",
            initialdir=str(Path.cwd().resolve()),
            filetypes=[
                ("HTML presentations", "*.html *.htm"),
                ("All files", "*"),
            ],
        )
    except Exception as e:  # noqa: BLE001
        print(f"[slide-comments] file picker unavailable: {type(e).__name__}: {e}")
        return None
    finally:
        if root is not None:
            try:
                root.destroy()
            except Exception:  # noqa: BLE001
                pass
    return selected or None


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve a reveal.js HTML presentation with slide-comments enabled.",
    )
    parser.add_argument(
        "html",
        nargs="?",
        help="HTML file to open, as an absolute path or relative to the current directory.",
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="start the server without opening the browser",
    )
    return parser.parse_args(argv)


def select_html_for_session(arg: str | None) -> Path:
    selected = arg or choose_html_with_dialog()
    if not selected:
        raise SystemExit("[slide-comments] no HTML file selected; server not started")
    try:
        return resolve_selected_html(selected)
    except ValueError as e:
        raise SystemExit(f"[slide-comments] {e}") from e


def main() -> None:
    global ROOT
    args = parse_args(sys.argv[1:])
    selected_html = select_html_for_session(args.html)
    ROOT = selected_html.parent
    augment_all_html_files()
    url = f"http://localhost:{PORT}/{urllib.parse.quote(selected_html.name)}?slide-comments=1"
    print(f"[slide-comments] serving {ROOT}")
    print(f"[slide-comments] selected {selected_html.name}")
    print(f"[slide-comments] open {url}")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    if not args.no_open:
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[slide-comments] shutting down")
        server.server_close()


if __name__ == "__main__":
    main()

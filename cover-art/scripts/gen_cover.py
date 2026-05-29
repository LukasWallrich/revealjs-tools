"""Generate clean line-art cover / divider illustrations via gpt-image-2.

Self-contained (standard library only). Two ways to use it:

CLI — one image at a time
--------------------------
    OPENAI_API_KEY=sk-...
    python3 gen_cover.py \\
        --slot illus-img \\
        --prompt "<shared style>  <this image's metaphor>" \\
        --out  contact_slide_assets/trap1_half.png

Library — a whole consistent series in parallel
-----------------------------------------------
    from gen_cover import generate
    generate(STYLE + TRAP1, "out/trap1.png", slot="illus-img")

A driver that loops over {name: prompt} with a ThreadPoolExecutor is the
normal way to render a 4-6 image set; see SKILL.md for the template.

Slots (dims must be divisible by 16; these match the swufe slide sizes):

  illus-img        1024x1536  PORTRAIT  — half-slide divider / column image (default)
  image-led-2line  1792x976   landscape — image-led slide, 2-line heading
  image-led-1line  1792x1024  landscape — image-led slide, 1-line heading
  title-bg         1792x1024  landscape — full-bleed title background
  custom           --size WxH required

Edge fill
---------
gpt-image-2 tends to leave a white internal margin, so by default a
"fill the canvas edge-to-edge" instruction is appended. For airy line-art
with deliberate negative space this is usually still what you want (the deck
crops with object-fit anyway). Pass --no-edge-fill to suppress it if the
model is cramming the composition to reach the corners.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures as cf
import json
import os
import sys
import urllib.request

SLOTS = {
    "illus-img":       (1024, 1536),
    "image-led-2line": (1792, 976),
    "image-led-1line": (1792, 1024),
    "title-bg":        (1792, 1024),
}

EDGE_SUFFIX = (
    "\n\nCRITICAL FRAMING: the graphic must FILL THE ENTIRE CANVAS edge-to-edge. "
    "Zero white margin around the outside — content extends to all four corners. "
    "No surrounding border, no inset padding."
)


def _size_for(slot: str, size: str | None) -> tuple[int, int]:
    if slot == "custom":
        if not size:
            sys.exit("--slot custom requires --size WxH")
        w, h = (int(x) for x in size.lower().split("x"))
    else:
        if size:
            sys.exit(f"--size is only valid with --slot custom; {slot} is fixed at {SLOTS[slot]}")
        w, h = SLOTS[slot]
    if w % 16 or h % 16:
        sys.exit(f"{w}x{h}: both dimensions must be divisible by 16")
    return w, h


def generate(prompt: str, out: str, *, slot: str = "illus-img",
             size: str | None = None, quality: str = "medium",
             edge_fill: bool = True) -> str:
    """Render one image and write it to `out`. Returns the output path."""
    w, h = _size_for(slot, size)
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        sys.exit("OPENAI_API_KEY not set in environment")

    full = prompt.rstrip() + (EDGE_SUFFIX if edge_fill else "")
    body = json.dumps({
        "model": "gpt-image-2",
        "prompt": full,
        "size": f"{w}x{h}",
        "quality": quality,
        "n": 1,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations",
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.loads(resp.read())
    blob = data["data"][0]
    img = base64.b64decode(blob["b64_json"]) if "b64_json" in blob else urllib.request.urlopen(blob["url"]).read()

    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    with open(out, "wb") as f:
        f.write(img)
    return out


def generate_series(style: str, jobs: dict[str, str], out_dir: str, *,
                    slot: str = "illus-img", quality: str = "medium",
                    edge_fill: bool = True, max_workers: int = 5) -> None:
    """Render a consistent set in parallel. `jobs` maps filename -> metaphor prompt;
    each final prompt is `style + metaphor`. Prints one status line per image."""
    os.makedirs(out_dir, exist_ok=True)

    def _run(item):
        name, metaphor = item
        out = os.path.join(out_dir, name)
        try:
            generate(style + metaphor, out, slot=slot, quality=quality, edge_fill=edge_fill)
            return name, True, out
        except Exception as e:  # noqa: BLE001 — surface, don't abort the batch
            return name, False, str(e)

    with cf.ThreadPoolExecutor(max_workers=max_workers) as ex:
        for name, ok, info in ex.map(_run, jobs.items()):
            print(f"[{'OK ' if ok else 'ERR'}] {name}: {info}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--slot", default="illus-img", choices=[*SLOTS, "custom"])
    p.add_argument("--prompt", required=True, help="Full prompt (shared style + this image's metaphor).")
    p.add_argument("--out", required=True, help="Output PNG path.")
    p.add_argument("--size", help="WxH, required only when --slot custom.")
    p.add_argument("--quality", default="medium", choices=["low", "medium", "high"])
    p.add_argument("--no-edge-fill", action="store_true", help="Do not append the edge-to-edge fill instruction.")
    args = p.parse_args()

    out = generate(args.prompt, args.out, slot=args.slot, size=args.size,
                   quality=args.quality, edge_fill=not args.no_edge_fill)
    print(f"saved → {out}")


if __name__ == "__main__":
    main()

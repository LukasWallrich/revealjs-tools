---
name: revealjs-slide-screenshot
description: Use when verifying a Reveal.js slide visually after a CSS or HTML edit, capturing a slide at a specific fragment state, seeing the rendered result, or pinpointing which element on a slide causes an overflow/layout issue.
---

# Reveal.js Slide Screenshot & Inspector

## Command

Set `SKILL_DIR` to the directory containing this `SKILL.md`, then run the bundled screenshot/inspection script from any workspace:

```sh
SKILL_DIR=/absolute/path/to/this-skill
node "$SKILL_DIR/scripts/slide_screenshot.js" path/to/deck.html --slides 6,10,14
```

Local file paths spin up a temporary static server rooted at the deck's directory so relative assets resolve; URLs are loaded directly.

Requires Node.js and Puppeteer. If Puppeteer is not installed normally, the script also tries Decktape's bundled Puppeteer.

## Modes

### Screenshot (default)

Writes `<prefix>_<N>.png` to `--out` (default `/tmp`, prefix `slide`).

- `--slides 3,5-8` — 1-indexed slides; ranges allowed. Default: all slides.
- `--no-fragments` — capture the *initial* slide state without advancing fragments. Default advances all fragments so the final visible state is captured.
- `--width 1280 --height 800` — match the Reveal config of the deck.
- `--out DIR` — output directory (created if missing).
- `--prefix STR` — filename prefix.

### Inspect

```sh
node ... --slides 24 --inspect ".task-split,.candidate-grid,.cand-card"
```

Prints a JSON dump of each matched element's `data-cid`, tag, class string, and bounding rect (`top`, `bottom`, `left`, `right`, `width`, `height`) on the chosen slide. Useful when the overflow checker reports a number like `OVERFLOW 65px (div.instr)` and you need to know *which child* is pushing the parent past the viewport.

- Requires exactly one slide via `--slides`.
- Multiple selectors via comma; each element under that selector is reported with `[i]` suffixes if more than one match.
- Skips screenshot output unless `--screenshot` is also passed.

## When To Use This vs Other Tools

- **`revealjs-overflow-checker`** (`check_overflow.py`) — first line of defence after any layout edit; reports geometry findings.
- **`revealjs-slide-screenshot`** (this skill) — when the visual outcome matters (CSS changes, image inserts, animation start state) or when you need to find *which* element is at fault.
- **`revealjs-slide-comments`** overlay — for collecting human comments on a live deck during review; not for post-edit verification.

A common flow when fixing a layout regression:

1. Run `revealjs-overflow-checker` with `--slides N` → reports `OVERFLOW 65px (div.instr)`.
2. Run this skill with `--slides N --inspect ".instr > *"` → see which child sits beyond `bottom: 800` and by how much.
3. Edit the offending element.
4. Run this skill with `--slides N` → confirm the visual fix.
5. Rerun `revealjs-overflow-checker` with `--slides N` → confirm no regressions.

## Notes

- Fragments are advanced via `Reveal.slide(h, v, MAX)`, not by forcing CSS `opacity: 1`, so the capture reflects the deck's real animated end state (including custom fragment styles like `.strike-on`).
- Speaker notes (`<aside class="notes">`) are display:none in normal Reveal rendering and do not appear in screenshots. They may however show non-zero bounding rects in some Reveal initialisation paths — disregard `em`/`br`/`i` overflow findings whose parent chain is the speaker-notes aside.
- Headless Chromium is used; no UI window opens.

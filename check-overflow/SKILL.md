---
name: revealjs-overflow-checker
description: Use when validating Reveal.js HTML decks for slide content that is clipped, off-screen, touching viewport edges, likely to overflow after fragments render, or when the user asks whether slides fit across one or more HTML decks.
---

# Reveal.js Overflow Checker

## Command

Set `SKILL_DIR` to the directory containing this `SKILL.md`, then run the bundled checker from any workspace:

```sh
SKILL_DIR=/absolute/path/to/this-skill
python3 "$SKILL_DIR/scripts/check_overflow.py" path/to/deck.html --bg "#faf6f1"
```

Requires Node.js and Puppeteer. If Puppeteer is not installed normally, the script also tries Decktape's bundled Puppeteer.

For non-default decks:

- `--bg "#rrggbb"` should match the slide background.
- `--width 1280 --height 800` can be changed for decks with a different Reveal config.
- `--tolerance 7` is the default geometry tolerance.
- `--edge-margin 6` controls screenshot edge scanning.
- `--no-screenshot` disables edge-pixel checks when debugging layout geometry only.
- `--slides 3,5-8,12` checks only specific 1-based slide numbers or inclusive ranges.

## How To Interpret Results

- `OVERFLOW ... (selector)` means an element extends beyond the visible Reveal viewport.
- `CLIPPED CONTENT ...` means a container with `overflow: hidden|clip|auto|scroll` has hidden scrollable content.
- `EDGE PIXELS ...` means non-background pixels touch the screenshot edge.
- `h2 wraps ...` is a warning, not a hard failure.

Trust large overflow findings. Manually inspect small findings near the tolerance, full-bleed art, and intentional decorative clipping.

## Workflow

1. Run the checker on the deck.
2. If it fails, report the specific slide numbers and offending selectors.
3. For visual uncertainty, screenshot or open the specific slide before editing.
4. After edits, rerun the checker and confirm the intended finding disappeared.

After a narrow edit, prefer `--slides` with the edited slide numbers plus any
nearby slides whose layout may have been affected.

Do not use naive `scrollHeight` or the slide section's own `getBoundingClientRect()` as the only check; Reveal can let sections grow beyond the actual viewport.

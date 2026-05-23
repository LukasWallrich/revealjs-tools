# revealjs-tools

Vibe-coded utilities for Reveal.js HTML decks. They work for my teaching decks;
use at your own risk, read the code, and expect sharp edges.

## Tools

### `check-overflow`

Checks Reveal.js decks for content that is off-screen, clipped by containers,
or visibly touching the viewport edge.

```sh
python3 revealjs-tools/check-overflow/scripts/check_overflow.py path/to/deck.html --bg "#faf6f1"
```

After editing a few slides, limit the run with 1-based slide numbers:

```sh
python3 revealjs-tools/check-overflow/scripts/check_overflow.py path/to/deck.html --slides 3,5-8,12 --bg "#faf6f1"
```

It uses Chromium/Puppeteer through Node, with a Python wrapper for convenience.
The checker forces fragments visible, checks DOM boxes against the actual
Reveal viewport, scans overflow containers, and samples screenshot edge pixels.

### `slide-comments`

A local browser overlay for leaving slide, element, pin, and pasted-image
comments on Reveal.js decks. It writes sidecar files next to the deck:

```text
deck.comments.json
deck.comments/
```

The server adds these tags before `</body>` if they are missing:

```html
<link rel="stylesheet" href="slide-comments/overlay.css">
<script src="slide-comments/overlay.js" defer></script>
```

Launch the server:

```sh
python3 revealjs-tools/slide-comments/server.py /absolute/path/to/deck.html
```

The server roots itself at the selected deck's directory and serves the overlay
assets from `revealjs-tools/slide-comments/`.

The overlay only activates when the URL contains `?slide-comments=1`; the
server opens that URL automatically. If the tags are left in a deck, they do
nothing during normal viewing.

### `slide-screenshot`

Captures selected Reveal.js slides to PNGs, or prints bounding boxes for
specific selectors when debugging layout.

```sh
node revealjs-tools/slide-screenshot/scripts/slide_screenshot.js path/to/deck.html --slides 6,10,14
node revealjs-tools/slide-screenshot/scripts/slide_screenshot.js path/to/deck.html --slides 24 --inspect ".instr > *"
```

### `references`

A tiny `references.json` + `citations.js` system for inline citations and an
auto-generated paginated bibliography slide.

```html
<cite key="smith2020"></cite>
<cite key="smith2020" parens></cite>
```

Copy the script into the deck directory, keep `references.json` next to the
deck, add `<div id="bibliography"></div>` on a references slide, then load:

```html
<script src="citations.js"></script>
```

## Agent Skills

Each tool folder contains a `SKILL.md` for AI agents:

- `check-overflow/SKILL.md`
- `slide-comments/SKILL.md`
- `slide-screenshot/SKILL.md`
- `references/SKILL.md`

These describe when to use the tool, the exact commands, and how to interpret
or apply the results.

## Dependencies

- Python 3
- Node.js
- Puppeteer, either installed normally (`npm install puppeteer`) or available
  via Decktape's bundled dependency on machines that already use Decktape.

The slide-comments overlay loads `html2canvas` lazily from a CDN when taking
pin snapshots.

## License / Warranty

No warranty. This is practical classroom tooling, not polished infrastructure.
If it saves you time, lovely. If it eats your deck, that is why Git exists.

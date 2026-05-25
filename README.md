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

### `references-verify`

Checks the DOIs and metadata in a `references.json` against Crossref. Catches
DOIs that resolve but point at the wrong paper (the kind of slip you never spot
by eye), DOIs that do not resolve at all, and titles/authors/years that
disagree with Crossref.

```sh
python3 revealjs-tools/references-verify/scripts/verify_references.py path/to/references.json
python3 revealjs-tools/references-verify/scripts/verify_references.py site/   # recurse
```

`--suggest-missing` queries Crossref for entries with no DOI and prints
candidate DOIs (it never writes them back). Pure standard library; needs
network access. Set `CROSSREF_MAILTO` to join Crossref's polite pool.

## Agent Skills

Each tool folder contains a `SKILL.md` for AI agents:

- `check-overflow/SKILL.md`
- `slide-comments/SKILL.md`
- `slide-screenshot/SKILL.md`
- `references/SKILL.md`
- `references-verify/SKILL.md`

These describe when to use the tool, the exact commands, and how to interpret
or apply the results.

### Installing Skills

Install each skill folder into the directory your agent scans for skills. For
Codex this is usually `~/.codex/skills`; for Claude this is often
`~/.claude/skills`.

Copy folders, using destination names that match the skill names:

```sh
SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$SKILLS_DIR"
mkdir -p \
  "$SKILLS_DIR/revealjs-overflow-checker" \
  "$SKILLS_DIR/revealjs-references" \
  "$SKILLS_DIR/revealjs-references-verify" \
  "$SKILLS_DIR/revealjs-slide-comments" \
  "$SKILLS_DIR/revealjs-slide-screenshot"
cp -R check-overflow/. "$SKILLS_DIR/revealjs-overflow-checker/"
cp -R references/. "$SKILLS_DIR/revealjs-references/"
cp -R references-verify/. "$SKILLS_DIR/revealjs-references-verify/"
cp -R slide-comments/. "$SKILLS_DIR/revealjs-slide-comments/"
cp -R slide-screenshot/. "$SKILLS_DIR/revealjs-slide-screenshot/"
```

Or symlink them so local edits in this checkout are picked up immediately:

```sh
SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$SKILLS_DIR"
ln -sfn "$PWD/check-overflow" "$SKILLS_DIR/revealjs-overflow-checker"
ln -sfn "$PWD/references" "$SKILLS_DIR/revealjs-references"
ln -sfn "$PWD/references-verify" "$SKILLS_DIR/revealjs-references-verify"
ln -sfn "$PWD/slide-comments" "$SKILLS_DIR/revealjs-slide-comments"
ln -sfn "$PWD/slide-screenshot" "$SKILLS_DIR/revealjs-slide-screenshot"
```

Set `SKILLS_DIR` explicitly when installing for an agent that uses a different
location.

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

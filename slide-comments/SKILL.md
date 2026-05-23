---
name: revealjs-slide-comments
description: Use when enabling or working with the reusable slide-comments overlay for Reveal.js HTML decks, including launching the local server, inspecting comment sidecars, applying comments from a deck, handling pasted-image comments, and preserving data-cid anchors.
---

# Reveal.js Slide Comments

## Launching

Set `SKILL_DIR` to the directory containing this `SKILL.md`, then run the bundled server from any workspace:

```sh
SKILL_DIR=/absolute/path/to/this-skill
python3 "$SKILL_DIR/server.py" /absolute/path/to/deck.html
```

Requires Python 3 and a local browser. Pin snapshots load `html2canvas` from a CDN.

Options:

- `SLIDE_COMMENTS_PORT=9000` changes the port.
- `--no-open` starts the server without opening a browser.
- If no HTML path is supplied, the server opens a file picker when available.

The server augments served HTML files by adding missing `data-cid` anchors and
these overlay tags before `</body>` when absent:

```html
<link rel="stylesheet" href="slide-comments/overlay.css">
<script src="slide-comments/overlay.js" defer></script>
```

The server roots itself at the deck directory and serves `/slide-comments/overlay.js` and `/slide-comments/overlay.css` from this tool folder.

The overlay only activates when the URL includes `?slide-comments=1`. The
server opens decks with that parameter automatically, so leaving the tags in a
deck is harmless during normal viewing.

## Applying Comments

For `deck.html`, read `deck.comments.json` next to it and process only records with `"status": "open"`.

Comment types:

- `slide`: find `<section data-cid="...">` using `slideCid`.
- `element`: find `[data-cid="..."]` using `elementCid`.
- `pin`: use `slideCid`, `position`, `nearestSelector`, `nearestText`, and the PNG snapshot under `deck.comments/`.
- `image`: inspect the pasted image, move it from `deck.comments/pasted/` into a durable asset folder, then add it to the slide.

Always preserve existing `data-cid` attributes because sidecar comments and pin snapshots anchor to those IDs. If replacing or moving content that remains the same conceptual slide/element, carry the existing CID onto the new HTML.

## Closing Comments

After applying an open comment:

1. Edit the HTML first.
2. Then update the JSON sidecar.
3. Default: delete the applied comment record from the `comments` array.
4. If the decision should remain documented, mark it `resolved` with `resolvedAt` and a short `resolution`.

If the overlay is open while you edit, the user's next save may warn them to reload. That is expected.

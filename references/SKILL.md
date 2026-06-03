---
name: revealjs-references
description: Use when adding, validating, or repairing the reusable references.json + citations.js citation system for Reveal.js HTML decks, including inline cite tags, generated bibliographies, citation-key validation, and auto-generated paginated bibliography slides.
---

# Reveal.js References

## Install In A Deck

Set `SKILL_DIR` to the directory containing this `SKILL.md`, then copy the bundled script next to the deck HTML:

```sh
SKILL_DIR=/absolute/path/to/this-skill
cp "$SKILL_DIR/scripts/citations.js" path/to/deck-dir/citations.js
```

Create or update `references.json` in the same directory as the deck. Each key
maps to a reference object:

```json
{
  "smith2020": {
    "authors": "Smith, A., & Jones, B.",
    "year": 2020,
    "title": "Article title",
    "journal": "Journal Name",
    "volume": "12",
    "issue": "3",
    "pages": "1-20",
    "doi": "10.1234/example"
  }
}
```

Add a bibliography placeholder slide:

```html
<section class="content">
  <h2>References</h2>
  <div id="bibliography"></div>
  <aside class="notes">Auto-populated from references.json by citations.js.</aside>
</section>
```

Load the script after Reveal.js and after the bibliography placeholder exists:

```html
<script src="citations.js"></script>
```

## Cite Syntax

```html
<cite key="smith2020"></cite>
<cite key="smith2020" parens></cite>
<cite key="smith2020">Smith et al. (2020)</cite>
```

- Empty narrative cite becomes `Smith & Jones (2020)`.
- Empty parenthetical cite becomes `(Smith & Jones, 2020)`.
- DOI entries link to `https://doi.org/...` (DOI-less entries fall back to `url`).
- Adjacent empty `parens` cites auto-group into a single bracket:
  `<cite key="a" parens></cite> <cite key="b" parens></cite>` →
  `(A, 2024; B, 2025)`. Only whitespace may sit between them; a cite with
  explicit text or a non-cite node breaks the run.

## Validation Workflow

1. Run/open the deck locally so `references.json` can be fetched.
2. Check the browser console for missing or unused references.
3. Missing keys render visibly as `[MISSING: key]`.
4. Confirm bibliography slides are generated and paginated after `Reveal.sync()`.

When editing decks, preserve existing `<cite key="...">` elements unless the
source claim is being removed, because those tags are the source of truth for
used-reference validation. Do not hand-write the bibliography in static HTML
unless the user explicitly wants to stop using the citation system; `citations.js`
owns bibliography generation and pagination.

`processCitations` is idempotent: a cite that already holds a rendered `<a>`,
or was merged into a group (`data-cite-merged`), is left untouched. So it is
safe to re-run against DOM that already has rendered cites — e.g. after the
slide-comments overlay saves rendered HTML back to source. Without this, a
re-run would double-bracket parenthetical cites (`(Author (Year))`).

`REFS_PER_PAGE` (top of the script) is a per-deck tuning value — how many
references fit one bibliography slide, given that deck's reference count and
font size. The bundled default is 7; adjust per deck and re-run the overflow
checker rather than assuming one value fits every deck.

---
name: revealjs-references
description: Use when adding, validating, or repairing the reusable references.json + citations.js citation system for Reveal.js HTML decks, including inline cite tags and auto-generated paginated bibliography slides.
---

# Reveal.js References

Use this skill when a Reveal.js deck needs inline citations, a generated
bibliography, or validation of citation keys against `references.json`.

## Install In A Deck

Copy the bundled script next to the deck HTML:

```sh
cp revealjs-tools/references/scripts/citations.js path/to/deck-dir/citations.js
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
- DOI entries link to `https://doi.org/...`.

## Validation Workflow

1. Run/open the deck locally so `references.json` can be fetched.
2. Check the browser console for missing or unused references.
3. Missing keys render visibly as `[MISSING: key]`.
4. Confirm bibliography slides are generated and paginated after `Reveal.sync()`.

When editing decks, preserve existing `<cite key="...">` elements unless the
source claim is being removed. Do not hand-write the bibliography in static
HTML unless the user explicitly wants to stop using the citation system.

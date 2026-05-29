---
name: revealjs-cover-art
description: Use when creating line-art cover, divider, or section illustrations for a Reveal.js deck — generating a consistent set of minimal illustrations with gpt-image-2, choosing half-slide vs full-bleed layout, writing prompts whose visual metaphor actually reads, and wiring the images into the deck CSS.
---

# Reveal.js Cover & Divider Art

Make a *consistent series* of clean line-art illustrations (e.g. one per
section divider), generate them with gpt-image-2, and wire them into the deck.
These are hard-won defaults from building a five-divider set — start here
rather than rediscovering them.

## Generate

Set `SKILL_DIR` to the directory containing this `SKILL.md`. Needs
`OPENAI_API_KEY` in the environment. Single image:

```sh
SKILL_DIR=/absolute/path/to/this-skill
python3 "$SKILL_DIR/scripts/gen_cover.py" \
  --slot illus-img \
  --prompt "<shared style block>  <this image's metaphor>" \
  --out contact_slide_assets/trap1_half.png
```

Slots (dims divisible by 16): `illus-img` 1024x1536 portrait (default, for
half-slide dividers / column images), `image-led-2line`/`image-led-1line`
1792-wide landscape, `title-bg` 1792x1024 full-bleed, `custom` with `--size`.
`--quality medium` is plenty for line-art; reserve `high` for final passes.

A whole set should be rendered from **one driver script** so the shared style
string is identical across every image — that single shared prefix is what
makes the series look like a series. The driver IS the spec: keep the prompts
in it. Name it `scratch_gen_covers.py` so `/wrap` offers to keep or bin it.

```python
from gen_cover import generate_series  # add scripts/ dir to sys.path, or copy gen_cover.py next to it

STYLE = (...)        # the shared style block — see below
JOBS = {             # filename -> this image's metaphor only
    "trap1_half.png": "Tall vertical portrait ... broken staircase of four islands ...",
    "trap2_half.png": "Tall vertical portrait ... stacked diptych ...",
}
generate_series(STYLE, JOBS, "contact_slide_assets", slot="illus-img", max_workers=5)
```

## The style block (what made the series consistent)

Put every one of these in the **shared** prefix, not the per-image part.
Be explicit and even repetitive — the model under-applies polite hints:

- **One stroke weight.** "A single consistent thin charcoal / near-black
  monoline stroke." Flat only: *spell out* "no shading, no gradients, no
  cross-hatching, no texture, no drop shadows."
- **Empty background, enumerated.** "PLAIN, EMPTY warm pale sage background
  (#f7faf4). No trees, clouds, mountains, plants, furniture, picture frames,
  rooms or decorative filler of any kind — only the essential subject, with
  generous negative space." A bare "minimal background" is not enough; list
  the forbidden scenery.
- **Exactly one accent, used boldly.** "Exactly ONE accent colour — forest
  green (#2f6f4e) — used BOLDLY on the focal element so the green reads
  strongly." Without "BOLDLY" the accent comes back timid and grey-ish.
- **No text, enumerated.** "ABSOLUTELY NO text, letters, numbers, words,
  labels or captions anywhere." gpt-image-2 loves to add labels; one negation
  word does not hold.
- **Match the deck palette.** Pull the exact background hex and the exact
  accent hex from the deck CSS so the image ground blends into the slide.

## Make the metaphor legible (the part that took the most iteration)

The *concept*, not the rendering, is what fails. Abstract optical metaphors
(prism, window, generic funnel) did not read; **concrete physical objects with
a familiar shape** did. When an image is "I don't get it", change the metaphor
object, do not just re-roll:

- continuum → a **broken staircase** of separate islands with visible gaps
- salience → a **magnifying glass** whose rim is the accent, lighting up one
  attribute inside the lens
- aggregation → two **measuring cylinders** sharing one level line
- self-report → a **head in profile** full of messy episodes emptying into a
  tidy speech bubble
- timescale → a stack of **clocks** growing in size

Tactics that helped: put a tiny human vignette inside each sub-element so it
stays human, not diagrammatic; force shared reference lines explicitly ("ONE
unbroken horizontal green line at EXACTLY the same height in both"); say "read
top to bottom" for sequence. Budget ~2-3 rerolls per image and at least one
metaphor swap for the trickiest one or two.

## Layout: prefer half-slide split over full-bleed

For illustrations with a distinct subject, **full-bleed behind text looked
messy** (text collided with art). A **half-slide split** — illustration column
beside the title text — was the clear winner. Reach for full-bleed only for
atmospheric/abstract title backgrounds with no competing subject.

Half-slide markup + CSS (portrait image, copy beside it):

```html
<section class="divider-split-section">
  <div class="divider-split">
    <div class="divider-art"><img src="contact_slide_assets/trap1_half.png" alt=""></div>
    <div class="divider-copy section-divider">
      <p class="marker">Trap 1</p>
      <h2>The continuum problem</h2>
      <p class="fragment fade-in">Contact is not one thing</p>
    </div>
  </div>
</section>
```

```css
.reveal .slides section.divider-split-section { height: 100%; padding: 0; }
.divider-split { display: flex; align-items: stretch; width: 100%; height: 100vh; }
.divider-art { flex: 0 0 44%; overflow: hidden; }
.divider-art img { width: 100%; height: 100%; object-fit: cover; object-position: center; display: block; margin: 0; }
.divider-art.fit img { object-fit: contain; }   /* see crop note */
.divider-copy { flex: 1; align-self: center; text-align: left; border: none; max-width: none; margin: 0; padding: 0 6% 0 5%; }
```

**Crop note:** `object-fit: cover` fills the column but crops a portrait that
is taller than the column — fine when the content sits central, but it lops
off art that runs to the top/bottom edges. When that happens, add the `fit`
class to that one image's `.divider-art` (`object-fit: contain`) rather than
regenerating. Mix per image: `cover` for full-bleed-friendly art, `fit` for
the ones that get clipped.

## Always render and look

Generation guarantees nothing about how the image sits in the slide. After
wiring each image, screenshot the actual divider with the
**revealjs-slide-screenshot** skill and look — that is how cropping, a timid
accent, or stray text gets caught. Do not declare a cover done from the PNG
alone.

## Cleanup

Keep the generation driver and any screenshot helper as `scratch_*` files (the
work is rerunnable and the prompts are the record). Delete superseded image
versions and preview screenshots, leaving exactly the images in use. Strip any
full-bleed CSS that the half-slide switch made dead.

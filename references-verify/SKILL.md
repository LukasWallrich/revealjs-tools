---
name: revealjs-references-verify
description: Use when verifying that the DOIs and bibliographic metadata in a reveal.js references.json actually resolve and match Crossref — catching DOIs that point at the wrong paper, transposed digits, and mismatched titles, authors, or years. Complements revealjs-references (which manages the citation system) and enforces the "never fabricate DOIs" rule against an existing reference list.
---

# Reveal.js References Verifier

Checks `references.json` entries against Crossref. The high-value case it
catches is a DOI that *resolves* but points at the wrong paper — a transposed
digit or copy-paste slip — which is almost impossible to spot by eye but obvious
once the stored title is compared with Crossref's.

This is metadata/source-integrity verification. It is distinct from
`revealjs-references`, which manages the JSON ↔ `citations.js` ↔ bibliography
plumbing. Use both: that skill to wire up citations, this one to check they
point where they claim.

## Command

```sh
SKILL_DIR=/absolute/path/to/this-skill
python3 "$SKILL_DIR/scripts/verify_references.py" path/to/references.json
```

- Pass several files, or a directory to search recursively:
  `python3 "$SKILL_DIR/scripts/verify_references.py" site/` finds every
  `references.json` under `site/`.
- `--suggest-missing` — for entries with no DOI, query Crossref by title and
  print candidate DOIs (highest similarity first). Read-only.
- `--fix` — apply the *safe, deterministic* fix subset and show what changed.
  Add `--yes` to write; without it `--fix` is a dry run. It only:
  - fills a missing or dead DOI when the top Crossref candidate matches on
    title (≥ 0.95), first author, and year; and
  - corrects a wrong `year` when the DOI resolves and title + first author
    already match (so the DOI is confirmed and only the year is off).
  It never rewrites titles or authors and never writes a low-confidence DOI —
  those are left flagged for the agent fix-loop below.
- `--check` — offline guard: confirm each `references.json` still matches its
  validation stamp (see below). No Crossref calls; exits non-zero if any file
  is stale or unstamped. Use it in a pre-push hook.
- `CROSSREF_MAILTO=you@example.com` (env) joins Crossref's polite pool.
- Pure standard library; no `pip install` needed. Network access required
  (except `--check`, which is offline).

## Validation stamp

A clean run (no `--fix`, no issues) writes `<name>.verified.json` beside the
references file — a SHA-256 of the *data* (formatting-independent), a timestamp,
and a one-line summary. Commit it alongside `references.json`.

`--check` recomputes the hash and reports `VALIDATED` / `STALE` (content changed
since verification) / `UNVERIFIED` (no stamp). `--fix --yes` removes the stamp,
so fixed content must be re-verified before it counts as validated. This gives a
fast, offline answer to "have these citations been checked since they last
changed?" — ideal in a `pre-push` hook to stop unverified references shipping.

## How To Interpret Results

Per reference, one of:

- `ok` — DOI resolves and title, first author, and year all match.
- `skipped (no DOI / url-only source)` — no DOI to check. Working papers and
  some sources legitimately have none; not a failure.
- `DOI NOT FOUND in Crossref` — the DOI is not in Crossref. Usually it is
  wrong; confirm by opening `https://doi.org/<doi>`. If doi.org resolves it
  but Crossref does not, the DOI is valid but registered with another agency
  (e.g. DataCite) — leave it. If doi.org also 404s, fix or remove it.
- `METADATA MISMATCH` — the DOI resolves but a field disagrees:
  - `TITLE MISMATCH (score)` — similarity below 0.85. A very low score usually
    means the DOI points at a different paper entirely.
  - `FIRST-AUTHOR MISMATCH` — stored first surname ≠ Crossref's.
  - `YEAR MISMATCH` — differs by more than one year (one year is tolerated for
    online/print drift).
- `COULD NOT VERIFY` — a network or API error, not a verdict. Re-run.

Exit code is 0 when there are no issues (skips are fine), 1 when any reference
has an issue, 2 on usage/IO error.

## Workflow

1. Run the verifier on the deck's `references.json` after adding or editing
   citations.
2. Run `--fix` (dry run) to see the safe, high-confidence changes, then
   `--fix --yes` to apply them. This clears confirmed-DOI year errors and fills
   unambiguous missing/dead DOIs.
3. Re-run plain. Whatever is still flagged needs judgement — handle it with the
   agent fix-loop below.
4. Re-run until clean.

## Agent fix-loop (for the issues `--fix` won't touch)

`--fix` deliberately refuses anything that needs judgement — a wrong-paper DOI,
an ambiguous lookup, a title or author correction. When you (an agent) run this
skill and such issues remain, repair them yourself:

- **`DOI NOT FOUND`** with no safe candidate, or a **wrong-paper DOI**
  (`TITLE`/`FIRST-AUTHOR MISMATCH` with a very low score): search Crossref
  (`https://api.crossref.org/works?query.bibliographic=<ref>`), confirm a hit's
  title, authors, and year match the *stored* reference, and write its DOI.
  Confirm the DOI resolves (`https://api.crossref.org/works/<doi>`). If no
  confident match exists, **omit the DOI** — never invent or guess one.
- **`TITLE` / `FIRST-AUTHOR MISMATCH`** where the DOI is actually correct: fix
  the stored field to match the source, but keep the deck's house style —
  APA sentence-case titles, `Family, I., …` authors with `&`, en-dash page
  ranges. Do not paste Crossref's Title Case / structured names verbatim.
- After any manual edit, re-run the verifier to confirm it is clean.

This is the "lookup" half of citation hygiene: it needs identity judgement and
formatting care that a script should not guess at, which is why it stays with
the agent and not in `--fix`.

#!/usr/bin/env python3
"""Verify DOIs and bibliographic metadata in reveal.js references.json files
against Crossref, and optionally apply a narrow, safe set of fixes.

For each reference that carries a ``doi``, the script fetches
``https://api.crossref.org/works/{doi}`` and checks that:

  * the DOI resolves (exists in Crossref),
  * the stored title matches the Crossref title (fuzzy),
  * the stored first-author surname matches Crossref's first author,
  * the stored year matches Crossref's issued year (within one, to allow for
    online/print drift).

The high-value case this catches is a DOI that *resolves* but points at the
wrong paper — a transposed digit or a copy-paste slip — which an author almost
never spots by eye.

Fixing splits by how much judgement it needs:

  * ``--suggest-missing`` prints candidate DOIs for entries with none. Read-only.
  * ``--fix`` applies only the *safe, deterministic* subset and shows a diff:
      - fill a missing or dead DOI **only** when the top Crossref candidate
        matches on title (>= 0.95), first author, and year;
      - correct a wrong ``year`` when the DOI resolves and title + first author
        already match (so the DOI is confirmed and only the year is off).
    It never rewrites titles or authors (formatting- and judgement-heavy) and
    never writes a low-confidence DOI. Without ``--yes`` it is a dry run.

Everything else — wrong-paper DOIs, ambiguous lookups, title/author
corrections — is left flagged for a human (or an agent following the skill's
fix-loop) to resolve with judgement, never fabricating a DOI.

Pure standard library — no third-party dependencies. Set CROSSREF_MAILTO to
join Crossref's polite pool.

Usage:
  verify_references.py site/s6/references.json [more.json ...]
  verify_references.py site/                       # finds references.json recursively
  verify_references.py site/s6/references.json --suggest-missing
  verify_references.py site/s6/references.json --fix         # dry run
  verify_references.py site/s6/references.json --fix --yes   # write changes
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

CROSSREF_WORK = "https://api.crossref.org/works/"
CROSSREF_QUERY = "https://api.crossref.org/works"
TITLE_THRESHOLD = 0.85       # below this, a resolving DOI's title is flagged
DOI_FILL_TITLE_MIN = 0.95    # candidate must clear this before --fix writes a DOI
YEAR_TOLERANCE = 1
REQUEST_PAUSE = 0.2          # seconds between calls, to be polite


# ── Crossref access ──────────────────────────────────────────────────────────

def _user_agent() -> str:
    mailto = os.environ.get("CROSSREF_MAILTO", "").strip()
    base = "revealjs-references-verify/1.0"
    return f"{base} (mailto:{mailto})" if mailto else base


def _fetch(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": _user_agent()})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def fetch_doi(doi: str):
    """Return the Crossref `message` for a DOI, or None if it does not resolve.

    Raises urllib errors for non-404 failures so they surface as 'could not
    verify' rather than a false 'not found'.
    """
    url = CROSSREF_WORK + urllib.parse.quote(doi.strip(), safe="/")
    try:
        return _fetch(url).get("message")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def query_candidates(ref: dict, rows: int = 3) -> list:
    """Return Crossref work items matching the reference by title (+ first author)."""
    query = ref.get("title", "")
    authors = ref.get("authors", "")
    if authors:
        query = f"{query} {authors.split(',')[0]}"
    url = f"{CROSSREF_QUERY}?" + urllib.parse.urlencode(
        {"query.bibliographic": query, "rows": rows}
    )
    return (_fetch(url).get("message") or {}).get("items") or []


def best_doi_match(ref: dict):
    """Strict candidate gate for --fix.

    Return (doi, score, why). doi is non-None only when the top candidate
    matches on title (>= DOI_FILL_TITLE_MIN), first author, and year.
    """
    items = query_candidates(ref)
    if not items:
        return None, 0.0, "no Crossref candidates"
    top = items[0]
    score = _ratio(ref.get("title", ""), _crossref_title(top))
    if score < DOI_FILL_TITLE_MIN:
        return None, score, f"top candidate title only {score:.2f}"
    cr_surname = _crossref_first_surname(top)
    stored_surname = _first_surname(ref.get("authors", ""))
    if cr_surname and stored_surname and cr_surname != stored_surname:
        return None, score, f"author mismatch (candidate '{cr_surname}')"
    cr_year = _crossref_year(top)
    if cr_year and ref.get("year") and abs(int(ref["year"]) - cr_year) > YEAR_TOLERANCE:
        return None, score, f"year mismatch (candidate {cr_year})"
    return top.get("DOI", ""), score, "title + author + year match"


# ── normalisation / comparison ───────────────────────────────────────────────

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("&", "and")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _ratio(a: str, b: str) -> float:
    return SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def _first_surname(authors: str) -> str:
    # stored format: "Bloom, N., Han, R., & Liang, J." -> surname before first comma
    return _norm((authors or "").split(",")[0])


def _crossref_title(msg: dict) -> str:
    title = (msg.get("title") or [""])[0]
    subtitle = (msg.get("subtitle") or [""])[0]
    return f"{title}: {subtitle}" if subtitle else title


def _crossref_year(msg: dict):
    for key in ("issued", "published-print", "published-online", "published", "created"):
        parts = (msg.get(key) or {}).get("date-parts") or []
        if parts and parts[0] and parts[0][0]:
            return int(parts[0][0])
    return None


def _crossref_first_surname(msg: dict) -> str:
    authors = msg.get("author") or []
    if authors:
        return _norm(authors[0].get("family", ""))
    return ""


# ── per-reference check ──────────────────────────────────────────────────────

def _candidate_lines(ref: dict):
    try:
        out = []
        for it in query_candidates(ref):
            title = _crossref_title(it)
            out.append(f"    candidate {_ratio(ref.get('title', ''), title):.2f}  {it.get('DOI', '')}  {title}")
        return out
    except Exception as exc:  # network/parse — non-fatal for a suggestion
        return [f"    (suggestion lookup failed: {exc})"]


def check_ref(key: str, ref: dict, *, suggest_missing: bool, fix_mode: bool):
    """Return (status, lines, fix). status in {ok, skip, issue}; fix is None or
    a dict of field -> new value that --fix may apply."""
    doi = (ref.get("doi") or "").strip()

    # ── no DOI ──
    if not doi:
        if fix_mode:
            try:
                cand, _score, why = best_doi_match(ref)
            except Exception as exc:
                return "skip", [f"{key}: skipped (no DOI) — lookup failed: {exc}"], None
            if cand:
                return "skip", [f"{key}: no DOI — FIX would add {cand} ({why})"], {"doi": cand}
        note = "url-only source" if ref.get("url") else "no DOI"
        lines = [f"{key}: skipped ({note})"]
        if suggest_missing:
            lines += _candidate_lines(ref)
        return "skip", lines, None

    # ── DOI present ──
    try:
        msg = fetch_doi(doi)
    except Exception as exc:
        return "issue", [f"{key}: COULD NOT VERIFY ({doi}) — {exc}"], None

    if msg is None:
        if fix_mode:
            try:
                cand, _score, why = best_doi_match(ref)
            except Exception:
                cand = None
            if cand and cand.lower() != doi.lower():
                return "issue", [f"{key}: DOI NOT FOUND ({doi}) — FIX would replace with {cand} ({why})"], {"doi": cand}
        lines = [f"{key}: DOI NOT FOUND in Crossref ({doi})"]
        if suggest_missing:
            lines += _candidate_lines(ref)
        return "issue", lines, None

    # ── DOI resolves: compare metadata ──
    cr_title = _crossref_title(msg)
    title_score = _ratio(ref.get("title", ""), cr_title)
    title_ok = title_score >= TITLE_THRESHOLD

    cr_surname = _crossref_first_surname(msg)
    stored_surname = _first_surname(ref.get("authors", ""))
    author_ok = not (cr_surname and stored_surname) or cr_surname == stored_surname

    cr_year = _crossref_year(msg)
    stored_year = ref.get("year")
    year_off = bool(cr_year and stored_year and abs(int(stored_year) - cr_year) > YEAR_TOLERANCE)

    problems = []
    if not title_ok:
        problems.append(
            f"    TITLE MISMATCH ({title_score:.2f})\n"
            f"      stored:   {ref.get('title', '')}\n"
            f"      crossref: {cr_title}"
        )
    if not author_ok:
        problems.append(f"    FIRST-AUTHOR MISMATCH — stored '{stored_surname}' vs crossref '{cr_surname}'")
    if year_off:
        problems.append(f"    YEAR MISMATCH — stored {stored_year} vs crossref {cr_year}")

    if not problems:
        return "ok", [f"{key}: ok"], None

    # Year-only fix: the DOI is confirmed (title + author match), just the year
    # is off — safe to correct to Crossref's.
    if fix_mode and title_ok and author_ok and year_off and len(problems) == 1:
        return "issue", [f"{key}: YEAR MISMATCH ({doi}) — FIX would set year {cr_year}"], {"year": cr_year}

    return "issue", [f"{key}: METADATA MISMATCH ({doi})"] + problems, None


# ── file handling ────────────────────────────────────────────────────────────

def collect_files(paths) -> list:
    files: list = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            files.extend(sorted(p.rglob("references.json")))
        elif p.is_file():
            files.append(p)
        else:
            print(f"warning: no such path: {p}", file=sys.stderr)
    seen, unique = set(), []
    for f in files:
        rp = f.resolve()
        if rp not in seen:
            seen.add(rp)
            unique.append(f)
    return unique


# ── validation stamp ─────────────────────────────────────────────────────────
# A clean verification writes `<name>.verified.json` beside the references file,
# recording a hash of the *data* (not its formatting). `--check` recomputes the
# hash offline and reports VALIDATED / STALE / UNVERIFIED — a fast, network-free
# guard to run (e.g. in a pre-push hook) before shipping a deck.

def canonical_hash(data: dict) -> str:
    blob = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def stamp_path(refs_file: Path) -> Path:
    return refs_file.with_name(refs_file.stem + ".verified.json")


def write_stamp(refs_file: Path, data: dict, summary: str) -> None:
    stamp = {
        "sha256": canonical_hash(data),
        "verified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tool": "revealjs-references-verify",
        "summary": summary,
    }
    stamp_path(refs_file).write_text(json.dumps(stamp, indent=2) + "\n", encoding="utf-8")


def remove_stamp(refs_file: Path) -> None:
    try:
        stamp_path(refs_file).unlink()
    except FileNotFoundError:
        pass


def check_stamps(files) -> int:
    """Offline: confirm each references.json matches its validation stamp."""
    bad = 0
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"{f}: UNREADABLE — {exc}"); bad += 1; continue
        sp = stamp_path(f)
        if not sp.exists():
            print(f"{f}: UNVERIFIED — no stamp; run the verifier"); bad += 1; continue
        try:
            stamp = json.loads(sp.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"{f}: STAMP UNREADABLE — {exc}"); bad += 1; continue
        if stamp.get("sha256") == canonical_hash(data):
            print(f"{f}: VALIDATED ({stamp.get('verified_at', '?')})")
        else:
            print(f"{f}: STALE — changed since verification; re-run the verifier"); bad += 1
    print(f"\n{len(files)} file(s) · {len(files) - bad} validated · {bad} need attention")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify references.json DOIs/metadata against Crossref.")
    ap.add_argument("paths", nargs="+", help="references.json files, or dirs to search recursively")
    ap.add_argument("--suggest-missing", action="store_true",
                    help="for entries without a DOI, print candidate DOIs (read-only)")
    ap.add_argument("--fix", action="store_true",
                    help="apply the safe fix subset (fill a high-confidence DOI; correct a confirmed year)")
    ap.add_argument("--yes", action="store_true",
                    help="with --fix, write changes; otherwise --fix is a dry run")
    ap.add_argument("--check", action="store_true",
                    help="offline: confirm each references.json matches its validation stamp; no Crossref calls")
    args = ap.parse_args()

    files = collect_files(args.paths)
    if not files:
        print("no references.json files found", file=sys.stderr)
        return 2

    if args.check:
        return check_stamps(files)

    total = ok = skip = issue = 0
    fixes_applied = 0
    for f in files:
        print(f"\n{f}")
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"  COULD NOT READ — {exc}")
            issue += 1
            continue
        file_ok = file_skip = file_issue = 0
        file_fixes = {}
        for key in sorted(data):
            total += 1
            status, lines, fix = check_ref(
                key, data[key], suggest_missing=args.suggest_missing, fix_mode=args.fix
            )
            file_ok += status == "ok"
            file_skip += status == "skip"
            file_issue += status == "issue"
            for line in lines:
                print(f"  {line}")
            if args.fix and fix:
                file_fixes[key] = fix
            time.sleep(REQUEST_PAUSE)
        ok += file_ok
        skip += file_skip
        issue += file_issue

        if args.fix:
            if file_fixes:
                for key, fix in file_fixes.items():
                    data[key].update(fix)
                if args.yes:
                    f.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                    fixes_applied += len(file_fixes)
                    print(f"  → applied {len(file_fixes)} fix(es) to {f}")
                    remove_stamp(f)  # fixed content is not yet validated clean; force a re-run
                else:
                    print(f"  → {len(file_fixes)} fix(es) proposed (dry run; pass --yes to write)")
        else:
            # Stamp only a genuinely clean file; otherwise drop any stale stamp.
            if file_issue == 0:
                write_stamp(f, data, f"{file_ok} ok · {file_skip} skipped")
                print(f"  ✓ validated — stamp written ({stamp_path(f).name})")
            else:
                remove_stamp(f)

    print(f"\n{total} refs · {ok} ok · {skip} skipped · {issue} issue(s)", end="")
    if args.fix:
        print(f" · {fixes_applied} fix(es) applied", end="")
    print()
    return 1 if issue else 0


if __name__ == "__main__":
    raise SystemExit(main())

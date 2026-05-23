/**
 * Lightweight citation system for Reveal.js presentations
 *
 * Usage:
 *   Inline/narrative (auto-fill):   <cite key="smith2020"></cite>
 *   Inline (explicit text):          <cite key="smith2020">Smith et al. (2020)</cite>
 *   Parenthetical (auto-fill):       <cite key="smith2020" parens></cite>
 *
 * Auto-fill formats:
 *   (no parens attr)  → "Author (Year)"   e.g. "Smith & Jones (2020)"
 *   (parens attr)     → "(Author, Year)"  e.g. "(Smith & Jones, 2020)"
 *
 * The script will:
 *   1. Link citations to their DOIs (if doi field present in references.json)
 *   2. Generate a bibliography in the element with id="bibliography"
 *   3. Paginate bibliography at REFS_PER_PAGE refs per slide
 *   4. Validate all citation keys, logging errors to the console
 */

(function() {
  'use strict';

  const REFS_PER_PAGE = 7;

  let references = {};
  const citedKeys = new Set();
  const missingKeys = new Set();

  // Extract the short author string used by both citation formats
  function shortAuthors(ref) {
    const authors = ref.authors;
    if (authors.includes('...')) {
      return authors.split(',')[0] + ' et al.';
    }
    const hasAmpersand = authors.includes(' & ');
    const preAmpersand = hasAmpersand ? authors.split(' & ')[0] : authors;
    const separatorCount = (preAmpersand.match(/\., /g) || []).length;
    const authorCount = separatorCount + (hasAmpersand ? 2 : 1);
    if (authorCount > 2) {
      return authors.split(',')[0] + ' et al.';
    } else if (hasAmpersand) {
      const parts = authors.split(' & ');
      return `${parts[0].split(',')[0]} & ${parts[1].split(',')[0]}`;
    }
    return authors.split(',')[0];
  }

  // Inline style: Author (Year)
  function formatShortCite(ref) {
    return `${shortAuthors(ref)} (${ref.year})`;
  }

  // Parenthetical style: (Author, Year)
  function formatParentheticalCite(ref) {
    return `(${shortAuthors(ref)}, ${ref.year})`;
  }

  // Format a full bibliography entry
  function formatBibEntry(key, ref) {
    let entry = `${ref.authors} (${ref.year}). ${ref.title}.`;

    if (ref.journal) {
      entry += ` <em>${ref.journal}</em>`;
      if (ref.volume) {
        entry += `, <em>${ref.volume}</em>`;
        if (ref.issue) {
          entry += `(${ref.issue})`;
        }
      }
      if (ref.pages) {
        entry += `, ${ref.pages}`;
      }
      entry += '.';
    } else if (ref.publisher) {
      entry += ` ${ref.publisher}.`;
    }

    if (ref.doi) {
      entry += ` <a href="https://doi.org/${ref.doi}" target="_blank">https://doi.org/${ref.doi}</a>`;
    } else if (ref.url) {
      entry += ` <a href="${ref.url}" target="_blank">${ref.url}</a>`;
    }

    return entry;
  }

  // Process all citation elements
  function processCitations() {
    const cites = document.querySelectorAll('cite[key]');

    cites.forEach(cite => {
      const key = cite.getAttribute('key');

      if (!references[key]) {
        missingKeys.add(key);
        cite.style.color = 'red';
        cite.style.fontWeight = 'bold';
        cite.title = `Missing reference: ${key}`;
        if (!cite.textContent.trim()) {
          cite.textContent = `[MISSING: ${key}]`;
        }
        return;
      }

      citedKeys.add(key);
      const ref = references[key];

      // If no text content, auto-fill based on parens attribute
      if (!cite.textContent.trim()) {
        cite.textContent = cite.hasAttribute('parens')
          ? formatParentheticalCite(ref)   // (Author, Year)
          : formatShortCite(ref);           // Author (Year)
      } else {
        // Normalise "Name, Year" → "Name (Year)" in explicit text
        cite.textContent = cite.textContent.replace(/,\s*(\d{4})\b/, ' ($1)');
      }

      // Wrap in link to DOI
      if (ref.doi) {
        const link = document.createElement('a');
        link.href = `https://doi.org/${ref.doi}`;
        link.textContent = cite.textContent;
        link.target = '_blank';
        cite.textContent = '';
        cite.appendChild(link);
      }
    });
  }

  // Generate bibliography with pagination across slides
  function generateBibliography() {
    const bibElement = document.getElementById('bibliography');
    if (!bibElement) return;

    if (citedKeys.size === 0) {
      bibElement.innerHTML = '<p><em>No citations found.</em></p>';
      return;
    }

    // Sort by author surname, then year
    const sortedKeys = Array.from(citedKeys).sort((a, b) => {
      const refA = references[a];
      const refB = references[b];
      const authorA = refA.authors.split(',')[0].toLowerCase();
      const authorB = refB.authors.split(',')[0].toLowerCase();
      if (authorA !== authorB) return authorA.localeCompare(authorB);
      return refA.year - refB.year;
    });

    const totalPages = Math.ceil(sortedKeys.length / REFS_PER_PAGE);

    // Get the parent section element
    const parentSection = bibElement.closest('section');
    let lastInsertedSection = parentSection;

    // Update the first page heading with page count
    const firstHeading = parentSection.querySelector('h2');
    if (firstHeading && totalPages > 1) {
      firstHeading.textContent = `References (1/${totalPages})`;
    }

    for (let page = 0; page < totalPages; page++) {
      const startIdx = page * REFS_PER_PAGE;
      const endIdx = Math.min(startIdx + REFS_PER_PAGE, sortedKeys.length);
      const pageKeys = sortedKeys.slice(startIdx, endIdx);

      const ul = document.createElement('ul');
      ul.style.listStyleType = 'none';
      ul.style.paddingLeft = '0';

      pageKeys.forEach(key => {
        const li = document.createElement('li');
        li.style.marginBottom = '0.5em';
        li.innerHTML = formatBibEntry(key, references[key]);
        ul.appendChild(li);
      });

      if (page === 0) {
        // First page goes in the existing bibliography element
        bibElement.appendChild(ul);
      } else {
        // Create new slides for subsequent pages. Mirror the original
        // section's classes and wrap the list in a .bibliography div so
        // CSS rules apply consistently across paginated pages.
        const newSection = document.createElement('section');
        if (parentSection.className) newSection.className = parentSection.className;
        const heading = document.createElement('h2');
        heading.textContent = `References (${page + 1}/${totalPages})`;
        newSection.appendChild(heading);
        const bibWrap = document.createElement('div');
        bibWrap.className = 'bibliography';
        bibWrap.appendChild(ul);
        newSection.appendChild(bibWrap);
        lastInsertedSection.parentNode.insertBefore(newSection, lastInsertedSection.nextSibling);
        lastInsertedSection = newSection;
      }
    }
  }

  // Report validation results to console
  function reportValidation() {
    console.log(`Citations: ${citedKeys.size} used, ${Object.keys(references).length} in references.json`);

    if (missingKeys.size > 0) {
      console.error('MISSING REFERENCES:', Array.from(missingKeys));
    }

    const unusedKeys = Object.keys(references).filter(k => !citedKeys.has(k));
    if (unusedKeys.length > 0) {
      console.warn('Unused references:', unusedKeys);
    }
  }

  // Initialize
  async function init() {
    try {
      const response = await fetch('references.json');
      if (!response.ok) {
        throw new Error(`Failed to load references.json: ${response.status}`);
      }
      references = await response.json();

      processCitations();
      generateBibliography();
      reportValidation();

      // Sync Reveal.js so it picks up dynamically added reference slides
      if (typeof Reveal !== 'undefined' && Reveal.sync) {
        Reveal.sync();
      }

    } catch (error) {
      console.error('Citation system error:', error);
      document.querySelectorAll('cite[key]').forEach(cite => {
        cite.style.color = 'orange';
        cite.title = 'Failed to load references';
      });
    }
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

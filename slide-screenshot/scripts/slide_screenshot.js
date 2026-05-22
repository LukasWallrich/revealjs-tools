#!/usr/bin/env node
/**
 * Slide screenshot + element inspection for reveal.js decks.
 *
 * Two modes:
 *   1. Screenshot — render selected slides to PNGs (fragments advanced by
 *      default; use --no-fragments for pre-animation state).
 *   2. Inspect — for a single slide, dump bounding rects for elements
 *      matching one or more CSS selectors. Useful when the overflow checker
 *      reports a number but doesn't tell you which box is the cause.
 *
 * Usage:
 *   node slide_screenshot.js site/session.html --slides 6,10,14
 *   node slide_screenshot.js site/session.html --slides 20 --no-fragments
 *   node slide_screenshot.js site/session.html --slides 24 --inspect ".task-split,.candidate-grid"
 *   node slide_screenshot.js http://localhost:8765/session.html --slides 1-3 --out ./shots
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch (_) {
  puppeteer = require('/opt/homebrew/lib/node_modules/decktape/node_modules/puppeteer');
}

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.error(
    'usage: slide_screenshot.js <deck.html|url> [--slides LIST] [--out DIR] [--prefix STR]\n' +
    '                                          [--no-fragments] [--inspect SEL]\n' +
    '                                          [--width PX] [--height PX] [--port N]\n' +
    'examples:\n' +
    '  --slides 3,5-8             screenshot listed slides (1-indexed)\n' +
    '  --slides 20 --no-fragments capture before fragments advance\n' +
    '  --slides 24 --inspect ".task-split,.cand-card"\n' +
    '                             dump bounding rects (skips PNG unless --screenshot)\n'
  );
  process.exit(args.length ? 0 : 2);
}

function readOption(name, fallback) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) {
    console.error(`missing value for ${name}`);
    process.exit(2);
  }
  return value;
}

const target = args[0];
const width = Number(readOption('--width', '1280'));
const height = Number(readOption('--height', '800'));
const slideSpec = readOption('--slides', readOption('--slide-range', ''));
const outDir = readOption('--out', '/tmp');
const prefix = readOption('--prefix', 'slide');
const inspectSel = readOption('--inspect', '');
const port = Number(readOption('--port', '8765'));
const noFragments = args.includes('--no-fragments');
const forceScreenshot = args.includes('--screenshot');

function parseSlideSpec(spec, total) {
  if (!spec) return Array.from({ length: total }, (_, i) => i + 1);
  const selected = new Set();
  for (const rawPart of spec.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 1 || end < 1 || start > end) {
        console.error(`invalid --slides range: ${part}`);
        process.exit(2);
      }
      for (let i = start; i <= end; i++) selected.add(i);
      continue;
    }
    if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n < 1) {
        console.error(`invalid --slides value: ${part}`);
        process.exit(2);
      }
      selected.add(n);
      continue;
    }
    console.error(`invalid --slides value: ${part}`);
    process.exit(2);
  }

  const outOfRange = Array.from(selected).filter(n => n > total).sort((a, b) => a - b);
  if (outOfRange.length) {
    console.error(`--slides includes slide(s) beyond deck length ${total}: ${outOfRange.join(', ')}`);
    process.exit(2);
  }
  return Array.from(selected).sort((a, b) => a - b);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function startStaticServer(root, preferredPort) {
  const server = http.createServer((req, res) => {
    let reqPath;
    try {
      reqPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch (_) {
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    const requested = path.resolve(root, `.${reqPath}`);
    if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(requested, (err, body) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType(requested) });
      res.end(body);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(preferredPort, '127.0.0.1', () => resolve(server));
  });
}

async function resolveTarget() {
  if (/^https?:\/\//i.test(target) || /^file:\/\//i.test(target)) {
    return { url: target, close: async () => {} };
  }

  const deckPath = path.resolve(target);
  if (!fs.existsSync(deckPath)) {
    console.error(`no such file: ${deckPath}`);
    process.exit(2);
  }

  const deckDir = path.dirname(deckPath);
  const server = await startStaticServer(deckDir, port).catch(err => {
    if (err.code !== 'EADDRINUSE') throw err;
    return startStaticServer(deckDir, 0);
  });
  const actualPort = server.address().port;
  return {
    url: `http://127.0.0.1:${actualPort}/${encodeURIComponent(path.basename(deckPath))}`,
    close: async () => new Promise(resolve => server.close(resolve)),
  };
}

async function waitForReveal(page) {
  await page.waitForFunction(() => window.Reveal && typeof window.Reveal.getSlides === 'function', { timeout: 15000 });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    if (window.Reveal && typeof window.Reveal.layout === 'function') window.Reveal.layout();
  });
  await new Promise(resolve => setTimeout(resolve, 250));
}

async function gotoSlide(page, slideNumber, advanceFragments) {
  // Reveal fragment index: -1 = no fragments shown; N = first N+1 fragments shown.
  // MAX_SAFE_INTEGER advances to the final fragment.
  await page.evaluate(({ idx, advance }) => {
    const slide = Reveal.getSlides()[idx];
    if (!slide) return;
    const ind = Reveal.getIndices(slide);
    Reveal.slide(ind.h, ind.v || 0, advance ? Number.MAX_SAFE_INTEGER : -1);
    Reveal.layout();
  }, { idx: slideNumber - 1, advance: advanceFragments });
  await new Promise(resolve => setTimeout(resolve, 200));
}

async function inspectSlide(page, selectors) {
  return page.evaluate((sels) => {
    const out = [];
    const slide = document.querySelector('.reveal .slides section.present') || document;
    for (const sel of sels) {
      const nodes = slide.querySelectorAll(sel);
      if (!nodes.length) {
        out.push({ sel, matches: 0 });
        continue;
      }
      nodes.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        const cls = typeof el.className === 'string' ? el.className.slice(0, 60) : '';
        const cid = el.getAttribute && el.getAttribute('data-cid');
        out.push({
          sel: nodes.length > 1 ? `${sel}[${i}]` : sel,
          tag: el.tagName.toLowerCase(),
          cls,
          cid: cid || undefined,
          rect: {
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            left: Math.round(r.left),
            right: Math.round(r.right),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
        });
      });
    }
    return out;
  }, selectors);
}

(async () => {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const resolved = await resolveTarget();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--allow-file-access-from-files'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(resolved.url, { waitUntil: 'networkidle0', timeout: 30000 });
    await waitForReveal(page);

    await page.addStyleTag({
      content: `
        *, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }
        .reveal .controls, .reveal .progress, .reveal .slide-number { display: none !important; }
      `,
    });

    const total = await page.evaluate(() => Reveal.getSlides().length);
    const slideNumbers = parseSlideSpec(slideSpec, total);

    if (inspectSel) {
      if (slideNumbers.length !== 1) {
        console.error(`--inspect requires exactly one slide via --slides (got ${slideNumbers.length})`);
        process.exit(2);
      }
      await gotoSlide(page, slideNumbers[0], !noFragments);
      const selectors = inspectSel.split(',').map(s => s.trim()).filter(Boolean);
      const data = await inspectSlide(page, selectors);
      console.log(JSON.stringify({ slide: slideNumbers[0], elements: data }, null, 2));
      if (!forceScreenshot) return;
    }

    for (const idx of slideNumbers) {
      await gotoSlide(page, idx, !noFragments);
      const out = path.join(outDir, `${prefix}_${idx}.png`);
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width, height } });
      console.log(out);
    }
  } finally {
    await browser.close();
    await resolved.close();
  }
})().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

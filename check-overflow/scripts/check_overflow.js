#!/usr/bin/env node
/**
 * Fast overflow checker for reveal.js decks.
 *
 * This uses the browser's layout engine directly instead of rendering through
 * decktape/PDF first. It catches two classes of failure:
 *   1. DOM boxes that extend beyond the slide viewport, including boxes later
 *      clipped by overflow:hidden.
 *   2. Non-background pixels that reach the screenshot edge, as a guard for
 *      visible overflow that layout metrics can miss.
 *
 * Usage:
 *   node revealjs-tools/check-overflow/scripts/check_overflow.js site/session.html --bg "#faf6f1"
 *   node revealjs-tools/check-overflow/scripts/check_overflow.js site/session.html --slides 3,5-8
 *   node revealjs-tools/check-overflow/scripts/check_overflow.js http://localhost:8765/session.html
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
  console.error('usage: check_overflow.js <deck.html|url> [--bg HEX] [--slides LIST] [--width PX] [--height PX] [--tolerance PX] [--edge-margin PX] [--port N]');
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
const tolerance = Number(readOption('--tolerance', '7'));
const edgeMargin = Number(readOption('--edge-margin', readOption('--margin', '6')));
const bgHex = readOption('--bg', '#faf6f1');
const slideSpec = readOption('--slides', readOption('--slide-range', ''));
const port = Number(readOption('--port', '8765'));
const noScreenshot = args.includes('--no-screenshot');

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

function hexToRgb(hex) {
  const normalized = hex.replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    console.error(`invalid --bg colour: ${hex}`);
    process.exit(2);
  }
  return [0, 2, 4].map(i => parseInt(normalized.slice(i, i + 2), 16));
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

async function inspectSlide(page, slideNumber, tolerancePx) {
  return page.evaluate(({ slideNumber, tolerancePx }) => {
    const slide = Reveal.getSlides()[slideNumber - 1];
    if (!slide) return null;
    const indices = Reveal.getIndices(slide);
    Reveal.slide(indices.h, indices.v || 0, Number.MAX_SAFE_INTEGER);
    Reveal.layout();

    const describe = el => {
      const cls = typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
        : '';
      const cid = el.getAttribute && el.getAttribute('data-cid');
      const id = el.id ? `#${el.id}` : '';
      return `${el.tagName.toLowerCase()}${id}${cls}${cid ? `[${cid}]` : ''}`;
    };

    const rectToPlain = r => ({
      top: r.top, right: r.right, bottom: r.bottom, left: r.left,
      width: r.width, height: r.height,
    });

    // Do not use section.getBoundingClientRect() as the boundary: reveal.js
    // lets an overfull section grow taller than the configured slide. Compare
    // against the actual reveal viewport instead, so content that sits in the
    // normal reveal margin is allowed but off-screen content is not.
    const viewport = document.querySelector('.reveal');
    const slideRect = rectToPlain((viewport || slide).getBoundingClientRect());
    const hard = [];
    const clipped = [];
    let maxPast = 0;

    const all = Array.from(slide.querySelectorAll('*'));
    for (const el of all) {
      if (el.closest('aside, script, style, template')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el !== slide && Number(cs.opacity) === 0 && !el.classList.contains('fragment')) continue;

      const rects = Array.from(el.getClientRects())
        .filter(r => r.width > 0.5 && r.height > 0.5);
      for (const r of rects) {
        const past = {
          top: slideRect.top - r.top,
          right: r.right - slideRect.right,
          bottom: r.bottom - slideRect.bottom,
          left: slideRect.left - r.left,
        };
        const worst = Math.max(past.top, past.right, past.bottom, past.left);
        if (worst > tolerancePx) {
          hard.push({ element: describe(el), past, rect: rectToPlain(r) });
          maxPast = Math.max(maxPast, worst);
          break;
        }
      }

      const clips = /(auto|scroll|hidden|clip)/;
      const clipsX = clips.test(cs.overflowX);
      const clipsY = clips.test(cs.overflowY);
      const overflowX = clipsX ? el.scrollWidth - el.clientWidth : 0;
      const overflowY = clipsY ? el.scrollHeight - el.clientHeight : 0;
      if (overflowX > tolerancePx || overflowY > tolerancePx) {
        clipped.push({
          element: describe(el),
          overflowX,
          overflowY,
          overflow: `${cs.overflowX}/${cs.overflowY}`,
        });
      }
    }

    const h2 = slide.querySelector('h2');
    let h2Lines = 0;
    let h2Text = '';
    if (h2) {
      const h2Rect = h2.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(h2).lineHeight);
      h2Lines = lh > 0 ? Math.round(h2Rect.height / lh) : 1;
      h2Text = h2.textContent.trim().slice(0, 100);
    }

    return {
      slideRect,
      maxPast,
      hard: hard.sort((a, b) => Math.max(b.past.top, b.past.right, b.past.bottom, b.past.left) -
        Math.max(a.past.top, a.past.right, a.past.bottom, a.past.left)).slice(0, 4),
      clipped: clipped.sort((a, b) => Math.max(b.overflowX, b.overflowY) - Math.max(a.overflowX, a.overflowY)).slice(0, 4),
      h2Lines,
      h2Text,
    };
  }, { slideNumber, tolerancePx });
}

async function edgeScan(page, bgRgb, margin, toleranceColor) {
  const screenshot = await page.screenshot({ encoding: 'binary' });
  // Avoid a project dependency for PNG parsing. Canvas is available in Chromium;
  // use it to sample the screenshot after loading it into an ImageBitmap.
  return page.evaluate(async ({ screenshotBytes, bgRgb, margin, toleranceColor }) => {
    const blob = new Blob([new Uint8Array(screenshotBytes)], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { width: w, height: h } = canvas;
    const edges = {};
    const far = (x, y) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return Math.max(Math.abs(d[0] - bgRgb[0]), Math.abs(d[1] - bgRgb[1]), Math.abs(d[2] - bgRgb[2])) > toleranceColor;
    };
    for (let o = 0; o < margin && !edges.bottom; o++) {
      const y = h - 1 - o;
      for (let x = 0; x < w; x += 4) if (far(x, y)) { edges.bottom = o; break; }
    }
    for (let o = 0; o < margin && !edges.top; o++) {
      const y = o;
      for (let x = 0; x < w; x += 4) if (far(x, y)) { edges.top = o; break; }
    }
    for (let o = 0; o < margin && !edges.right; o++) {
      const x = w - 1 - o;
      for (let y = 0; y < h; y += 4) if (far(x, y)) { edges.right = o; break; }
    }
    for (let o = 0; o < margin && !edges.left; o++) {
      const x = o;
      for (let y = 0; y < h; y += 4) if (far(x, y)) { edges.left = o; break; }
    }
    return edges;
  }, { screenshotBytes: Array.from(screenshot), bgRgb, margin, toleranceColor });
}

(async () => {
  const bgRgb = hexToRgb(bgHex);
  const resolved = await resolveTarget();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--allow-file-access-from-files'],
  });

  let fail = 0;
  let warn = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(resolved.url, { waitUntil: 'networkidle0', timeout: 30000 });
    await waitForReveal(page);
    await page.addStyleTag({
      content: `
        *, *::before, *::after { transition-duration: 0s !important; animation-duration: 0s !important; }
        .reveal .slides section .fragment { opacity: 1 !important; visibility: visible !important; }
        .reveal .controls, .reveal .progress, .reveal .slide-number { display: none !important; }
      `,
    });

    const total = await page.evaluate(() => Reveal.getSlides().length);
    const slideNumbers = parseSlideSpec(slideSpec, total);
    const reports = [];
    for (const i of slideNumbers) {
      const data = await inspectSlide(page, i, tolerance);
      if (!data) continue;
      let edge = {};
      if (!noScreenshot) edge = await edgeScan(page, bgRgb, edgeMargin, 18);
      reports.push({ slide: i, ...data, edge });
    }

    for (const r of reports) {
      const flags = [];
      if (r.hard.length) {
        const offender = r.hard[0];
        const pastPx = Math.max(offender.past.top, offender.past.right, offender.past.bottom, offender.past.left);
        flags.push(`OVERFLOW ${pastPx.toFixed(1)}px (${offender.element})`);
        fail++;
      }
      if (r.clipped.length) {
        const offender = r.clipped[0];
        flags.push(`CLIPPED CONTENT ${Math.max(offender.overflowX, offender.overflowY).toFixed(1)}px (${offender.element}, ${offender.overflow})`);
        fail++;
      }
      const edgeNames = Object.keys(r.edge || {});
      if (edgeNames.length) {
        flags.push(`EDGE PIXELS ${edgeNames.map(e => `${e}@${r.edge[e]}px`).join(', ')}`);
        fail++;
      }
      if (r.h2Lines > 1) {
        flags.push(`h2 wraps to ${r.h2Lines} lines: "${r.h2Text}"`);
        warn++;
      }

      if (flags.length) console.log(`slide ${r.slide}: ${flags.join(' · ')}`);
      else console.log(`slide ${r.slide}: ok`);
    }

    const scope = slideSpec ? `${reports.length}/${total} selected slides` : `${reports.length} slides`;
    console.log(`\n${scope} · ${fail} overflow/clipping findings · ${warn} heading-wrap warnings`);
    process.exitCode = fail ? 1 : 0;
  } finally {
    await browser.close();
    await resolved.close();
  }
})().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

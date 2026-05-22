/*
 * slide-comments overlay — drop-in comment layer for reveal.js decks.
 *
 * Talks to the companion server.py via:
 *   POST /save-comments?file=...
 *   POST /save-snapshot?file=...&slide=...
 *   GET  /html-mtime?file=...
 */
(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  if (params.get("slide-comments") !== "1") return;

  const HTML2CANVAS_URL =
    "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";

  const HTML_FILENAME = (() => {
    const path = window.location.pathname;
    const last = path.split("/").pop();
    const decoded = last ? decodeURIComponent(last) : "";
    return decoded && /\.html?$/i.test(decoded) ? decoded : "";
  })();

  if (!HTML_FILENAME) {
    console.warn("[slide-comments] Could not detect HTML filename from URL; overlay disabled.");
    return;
  }

  // ---- State -------------------------------------------------------------
  const state = {
    comments: [],
    mode: null, // 'slide' | 'element' | 'pin' | null
    saveStatus: "idle", // 'idle' | 'saving' | 'error'
    saveTimer: null,
    saveQueued: false,
    htmlMtime: null,
    panelOpen: false,
    prevSection: null, // section we last saw — snapshot it when we leave
    editorKeyHandler: null,
  };

  // ---- Utilities ---------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const cssEsc = (s) =>
    window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^A-Za-z0-9_-]/g, "\\$&");

  function nowIso() {
    return new Date().toISOString();
  }

  function nextCommentId() {
    const used = new Set(state.comments.map((c) => c.id));
    let n = state.comments.length + 1;
    while (used.has(`c${String(n).padStart(3, "0")}`)) n += 1;
    return `c${String(n).padStart(3, "0")}`;
  }

  const FORMAT_ONLY_TAGS = new Set([
    "B", "CITE", "CODE", "DFN", "EM", "I", "KBD", "MARK", "Q", "S", "SAMP",
    "SMALL", "STRONG", "SUB", "SUP", "U", "VAR",
  ]);

  function isVisibleElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function isFormatOnly(el) {
    return !!(el && FORMAT_ONLY_TAGS.has(el.tagName));
  }

  function nearestAnchoredTarget(el, section) {
    let node = el;
    while (node && node !== section) {
      if (
        node.nodeType === 1 &&
        node.hasAttribute("data-cid") &&
        !isFormatOnly(node) &&
        isVisibleElement(node)
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function commentTargetFromPoint(ev, section) {
    if (!section) return null;
    const stack = document.elementsFromPoint(ev.clientX, ev.clientY);
    for (const candidate of stack) {
      if (!candidate || isInOurUI(candidate) || candidate === section) continue;
      if (!section.contains(candidate) || !isVisibleElement(candidate)) continue;
      const target = nearestAnchoredTarget(candidate, section);
      if (target && isVisibleElement(target)) return target;
    }
    return null;
  }

  function cleanCloneForAnchor(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(".sc-pin").forEach((n) => n.remove());
    [clone, ...clone.querySelectorAll("*")].forEach((n) => {
      n.classList.remove(
        "sc-element-hover",
        "sc-has-comment",
        "sc-editing",
        "sc-edit-saved",
        "sc-pin-focus"
      );
      if (!n.getAttribute("class")) n.removeAttribute("class");
      n.removeAttribute("contenteditable");
    });
    return clone;
  }

  function cleanOuterHTML(el) {
    return cleanCloneForAnchor(el).outerHTML;
  }

  function htmlWithPreservedLineBreaks(el) {
    // Convert *typed* line breaks (\n inside actual content) into <br>, but
    // leave source-HTML formatting whitespace alone. Pure-whitespace text
    // nodes between tags — and leading/trailing whitespace around content
    // in indented source HTML — are source formatting; converting their \n
    // to <br> would inject visible blank lines on every save.
    const clone = el.cloneNode(true);
    // Strip caret-padding zero-width spaces inserted after user-pressed <br>.
    const padWalker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const padNodes = [];
    while (padWalker.nextNode()) padNodes.push(padWalker.currentNode);
    padNodes.forEach((n) => {
      if (n.nodeValue && n.nodeValue.includes("​")) {
        n.nodeValue = n.nodeValue.replace(/​/g, "");
        if (n.nodeValue === "" && n.parentNode) n.parentNode.removeChild(n);
      }
    });
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach((node) => {
      const text = node.nodeValue || "";
      if (!text.includes("\n")) return;
      // Skip pure-whitespace nodes (source formatting between tags).
      if (text.trim() === "") return;
      // Only convert \n inside the content body, not in leading/trailing
      // indentation whitespace.
      const leadingWs = text.match(/^\s*/)[0];
      const trailingWs = text.length > leadingWs.length
        ? text.match(/\s*$/)[0]
        : "";
      const body = text.slice(leadingWs.length, text.length - trailingWs.length);
      if (!body.includes("\n")) return;
      const frag = document.createDocumentFragment();
      // Preserve original surrounding whitespace minus its newlines so the
      // text node round-trips through the editor without growing extra
      // formatting characters.
      if (leadingWs) frag.appendChild(document.createTextNode(leadingWs.replace(/\n/g, "")));
      body.split("\n").forEach((part, i) => {
        if (i > 0) frag.appendChild(document.createElement("br"));
        if (part) frag.appendChild(document.createTextNode(part));
      });
      if (trailingWs) frag.appendChild(document.createTextNode(trailingWs.replace(/\n/g, "")));
      node.parentNode.replaceChild(frag, node);
    });
    return clone.innerHTML;
  }

  function insertBrAtCursor(host) {
    // Insert a <br> at the current selection inside the editable host and
    // move the caret just past it. Falls back to a no-op if the selection
    // isn't inside the host.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (host && !host.contains(range.startContainer)) return;
    range.deleteContents();
    const br = document.createElement("br");
    range.insertNode(br);
    // If the new <br> is the last node in the host and has no trailing text,
    // most browsers won't render the caret on the new visual line. A trailing
    // zero-width text node gives the caret somewhere to land. We strip these
    // on save — they leave no visible artefact.
    if (br.parentNode && !br.nextSibling) {
      const pad = document.createTextNode("​");
      br.parentNode.appendChild(pad);
      range.setStartAfter(br);
      range.collapse(true);
    } else {
      range.setStartAfter(br);
      range.collapse(true);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function nearestMeaningful(el) {
    // Walk up to find the nearest element with text content; useful for pin context.
    let node = el;
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains("sc-pin")) {
        node = node.parentElement;
        continue;
      }
      const text = (node.textContent || "").trim();
      if (text && text.length >= 3) return node;
      node = node.parentElement;
    }
    return el;
  }

  function trimText(s, n) {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // ---- Reveal integration ------------------------------------------------
  function currentSection() {
    return (window.Reveal && Reveal.getCurrentSlide && Reveal.getCurrentSlide()) || null;
  }

  function currentSlideIndices() {
    if (!window.Reveal || !Reveal.getIndices) return null;
    const idx = Reveal.getIndices();
    return idx ? { h: idx.h || 0, v: idx.v || 0 } : null;
  }

  function currentSlideIndex() {
    const idx = currentSlideIndices();
    return idx ? idx.h : -1;
  }

  function revealIndicesForSection(section) {
    const slidesRoot = $(".reveal .slides");
    if (!section || !slidesRoot) return null;
    const topSections = Array.from(slidesRoot.children).filter((el) => el.tagName === "SECTION");
    for (let h = 0; h < topSections.length; h += 1) {
      const top = topSections[h];
      if (top === section) return { h, v: 0, nested: false };
      const verticalSections = Array.from(top.children).filter((el) => el.tagName === "SECTION");
      const v = verticalSections.indexOf(section);
      if (v >= 0) return { h, v, nested: true };
    }
    return null;
  }

  function slideLabel(indices) {
    if (!indices) return "Slide ?";
    return indices.nested
      ? `Slide ${indices.h + 1}.${indices.v + 1}`
      : `Slide ${indices.h + 1}`;
  }

  function ensureSlideCid(section) {
    if (!section) throw new Error("No current slide.");
    const existing = section.getAttribute("data-cid");
    if (existing) return existing;
    throw new Error("This slide has no data-cid. Restart the slide-comments server and reload the deck.");
  }

  function ensureElementCid(el) {
    const section = el.closest("section");
    if (!section) throw new Error("element not inside a slide");
    const slideCid = ensureSlideCid(section);
    const existing = el.getAttribute("data-cid");
    if (existing) return { slideCid, elementCid: existing };
    throw new Error("This element has no data-cid. Restart the slide-comments server and reload the deck.");
  }

  // ---- API ---------------------------------------------------------------
  async function apiPost(path, body, extraParams) {
    const qs = new URLSearchParams({ file: HTML_FILENAME });
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) qs.set(k, v);
    }
    const url = `${path}?${qs.toString()}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      throw new Error(json.error || `${path} failed (${res.status})`);
    }
    return json;
  }

  async function apiGet(path) {
    const url = `${path}?file=${encodeURIComponent(HTML_FILENAME)}`;
    const res = await fetch(url);
    return res.json();
  }

  async function loadInitialComments() {
    // The sidecar JSON sits at <basename>.comments.json next to the HTML.
    const base = HTML_FILENAME.replace(/\.html?$/i, "");
    const url = `${base}.comments.json`;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data && Array.isArray(data.comments)) {
        state.comments = data.comments;
      }
    } catch (e) {
      // No sidecar yet — fine.
    }
  }

  async function loadHtmlMtime() {
    try {
      const res = await apiGet("/html-mtime");
      if (res && res.mtime) state.htmlMtime = res.mtime;
    } catch (e) {
      // Non-fatal; server may not be running, in which case the rest will fail loudly.
    }
  }

  // ---- Saving (debounced) ------------------------------------------------
  function scheduleSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      void doSave();
    }, 250);
  }

  async function doSave() {
    if (state.saveStatus === "saving") {
      state.saveQueued = true;
      return;
    }
    setStatus("saving");
    try {
      const res = await apiPost("/save-comments", {
        version: 1,
        presentation: HTML_FILENAME,
        comments: state.comments,
      });
      // mtime guard: save-comments does NOT touch the HTML, so any increase in
      // the HTML mtime since our last own-write is an external edit.
      if (state.htmlMtime && res.htmlMtime && res.htmlMtime > state.htmlMtime + 0.001) {
        showBanner(
          "warn",
          "The HTML changed on disk since you loaded this page. Reload before adding more comments.",
          true
        );
      }
      setStatus("idle");
    } catch (e) {
      console.error("[slide-comments] save failed:", e);
      setStatus("error", e.message);
      showBanner("error", `Could not save comments: ${e.message}`);
    } finally {
      if (state.saveQueued) {
        state.saveQueued = false;
        void doSave();
      }
    }
  }

  function setStatus(status, msg) {
    state.saveStatus = status;
    const node = $(".sc-status");
    if (!node) return;
    node.classList.remove("sc-saving", "sc-error");
    if (status === "saving") {
      node.classList.add("sc-saving");
      node.lastChild.textContent = "saving…";
    } else if (status === "error") {
      node.classList.add("sc-error");
      node.lastChild.textContent = "save failed";
    } else {
      node.lastChild.textContent = "saved";
    }
  }

  // ---- Banner ------------------------------------------------------------
  function showBanner(kind, text, persistent) {
    const node = $(".sc-banner");
    const modifier =
      kind === "warn" ? " sc-warn" : kind === "info" ? " sc-info" : "";
    node.className = `sc-banner sc-visible${modifier}`;
    node.firstChild.textContent = text;
    if (!persistent) {
      setTimeout(() => node.classList.remove("sc-visible"), 5000);
    }
  }
  function hideBanner() {
    $(".sc-banner").classList.remove("sc-visible");
  }

  // ---- Toolbar -----------------------------------------------------------
  function buildChrome() {
    const root = document.createElement("div");
    root.className = "sc-root";
    root.innerHTML = `
      <div class="sc-banner"><span></span><button data-action="dismiss-banner">dismiss</button></div>
      <div class="sc-toolbar" role="toolbar" aria-label="slide-comments">
        <span class="sc-grip" data-sc-drag title="Drag to move">⋮⋮</span>
        <button data-mode="slide" title="Comment on whole slide">Slide</button>
        <button data-mode="element" title="Comment on an element">Element</button>
        <button data-mode="pin" title="Drop a positional pin">Pin</button>
        <button data-action="panel" class="sc-pill" title="Show all comments">All</button>
        <span class="sc-status"><span class="sc-dot"></span><span>idle</span></span>
      </div>
      <aside class="sc-panel">
        <header data-sc-drag>
          <strong>Comments</strong>
          <span><span class="sc-drag-hint">drag</span><button data-action="close-panel">close</button></span>
        </header>
        <div class="sc-list"></div>
      </aside>
    `;
    document.body.appendChild(root);

    root.addEventListener("click", (ev) => {
      const target = ev.target.closest("[data-mode], [data-action]");
      if (!target) return;
      if (target.dataset.mode === "slide") {
        const section = currentSection();
        if (!section) {
          showBanner("error", "No current slide.");
          return;
        }
        setMode(null);
        void addSlideComment(section);
      } else if (target.dataset.mode) setMode(target.dataset.mode);
      else if (target.dataset.action === "panel") togglePanel(true);
      else if (target.dataset.action === "close-panel") togglePanel(false);
      else if (target.dataset.action === "dismiss-banner") hideBanner();
    });

    makeDraggable($(".sc-panel"), "sc-panel-pos");
    makeDraggable($(".sc-toolbar"), "sc-toolbar-pos");
  }

  // ---- Draggable element -------------------------------------------------
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function makeDraggable(el, storageKey) {
    if (!el) return;
    const handle = el.querySelector("[data-sc-drag]") || el;
    let drag = null;
    handle.addEventListener("mousedown", (ev) => {
      if (ev.target.closest("button")) return; // let button clicks through
      const r = el.getBoundingClientRect();
      drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, w: r.width, h: r.height };
      el.classList.add("sc-dragging");
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.left = r.left + "px";
      el.style.top = r.top + "px";
      ev.preventDefault();
    });
    window.addEventListener("mousemove", (ev) => {
      if (!drag) return;
      const x = clamp(ev.clientX - drag.dx, 4, window.innerWidth - drag.w - 4);
      const y = clamp(ev.clientY - drag.dy, 4, window.innerHeight - 32);
      el.style.left = x + "px";
      el.style.top = y + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      el.classList.remove("sc-dragging");
      const r = el.getBoundingClientRect();
      try {
        localStorage.setItem(storageKey, JSON.stringify({ left: r.left, top: r.top }));
      } catch (e) {
        // localStorage may be unavailable; non-fatal.
      }
    });
    // restore saved position
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    } catch (e) {
      saved = null;
    }
    if (saved) {
      const left = clamp(saved.left, 4, window.innerWidth - 100);
      const top = clamp(saved.top, 4, window.innerHeight - 40);
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.left = left + "px";
      el.style.top = top + "px";
    }
  }

  function setMode(mode) {
    state.mode = state.mode === mode ? null : mode;
    document.body.classList.toggle("sc-mode-slide", state.mode === "slide");
    document.body.classList.toggle("sc-mode-element", state.mode === "element");
    document.body.classList.toggle("sc-mode-pin", state.mode === "pin");
    document.querySelectorAll(".sc-toolbar button[data-mode]").forEach((b) => {
      b.classList.toggle("sc-active", b.dataset.mode === state.mode);
    });
    closePopover();
  }

  function togglePanel(open) {
    state.panelOpen = open !== undefined ? open : !state.panelOpen;
    $(".sc-panel").classList.toggle("sc-visible", state.panelOpen);
    if (state.panelOpen) renderPanel();
  }

  // ---- Popover (compose / edit) ------------------------------------------
  function closePopover() {
    state.editorKeyHandler = null;
    const p = $(".sc-popover");
    if (p) p.remove();
  }

  function openComposer({ titleText, anchor, initial = "", onSave, onCancel, previewImageUrl, placeholder }) {
    closePopover();
    const pop = document.createElement("div");
    pop.className = "sc-popover";
    pop.innerHTML = `
      <header></header>
      <div class="sc-preview" hidden><img alt=""></div>
      <textarea></textarea>
      <div class="sc-actions">
        <button data-pop="cancel">Cancel</button>
        <button class="sc-primary" data-pop="save">Save</button>
      </div>
    `;
    pop.querySelector("header").textContent = titleText;
    const ta = pop.querySelector("textarea");
    ta.value = initial;
    ta.placeholder = placeholder || "What should the agent know or do?";
    if (previewImageUrl) {
      const preview = pop.querySelector(".sc-preview");
      preview.hidden = false;
      preview.querySelector("img").src = previewImageUrl;
    }
    document.body.appendChild(pop);

    // position near anchor
    const rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    const left = Math.min(
      window.innerWidth - 340,
      Math.max(8, rect.left + (rect.width || 0) / 2 - 160)
    );
    const top = Math.min(
      window.innerHeight - 220,
      Math.max(8, rect.bottom + 8)
    );
    pop.style.left = left + "px";
    pop.style.top = top + "px";

    setTimeout(() => ta.focus(), 0);

    const cancelComposer = () => {
      closePopover();
      if (onCancel) onCancel();
    };
    const saveComposer = () => {
      const txt = ta.value.trim();
      if (!txt) {
        ta.focus();
        return;
      }
      closePopover();
      onSave(txt);
    };

    state.editorKeyHandler = (ev) => {
      if (!pop.contains(ev.target)) return false;
      ev.stopPropagation();
      if (ev.key === "Escape") {
        ev.preventDefault();
        cancelComposer();
      } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        saveComposer();
      }
      return true;
    };

    pop.addEventListener("click", (ev) => {
      const t = ev.target.closest("[data-pop]");
      if (!t) return;
      if (t.dataset.pop === "cancel") {
        cancelComposer();
      } else if (t.dataset.pop === "save") {
        saveComposer();
      }
    });
  }

  // ---- Adding comments ---------------------------------------------------
  async function addSlideComment(section) {
    let slideCid;
    try {
      slideCid = await ensureSlideCid(section);
    } catch (e) {
      showBanner("error", `Could not anchor slide: ${e.message}`);
      return;
    }
    openComposer({
      titleText: "Comment on slide",
      anchor: section,
      onSave: (text) => {
        const indices = currentSlideIndices();
        state.comments.push({
          id: nextCommentId(),
          type: "slide",
          slideCid,
          slideIndexAtCreate: indices ? indices.h : -1,
          slideVIndexAtCreate: indices ? indices.v : 0,
          text,
          status: "open",
          createdAt: nowIso(),
        });
        scheduleSave();
        refreshBadges();
        renderPanelIfOpen();
      },
    });
  }

  async function addElementComment(el) {
    let cids;
    try {
      cids = await ensureElementCid(el);
    } catch (e) {
      showBanner("error", `Could not anchor element: ${e.message}`);
      return;
    }
    openComposer({
      titleText: "Comment on element",
      anchor: el,
      onSave: (text) => {
        state.comments.push({
          id: nextCommentId(),
          type: "element",
          slideCid: cids.slideCid,
          elementCid: cids.elementCid,
          elementSnippet: trimText(cleanOuterHTML(el), 240),
          elementText: trimText(el.textContent || "", 200),
          text,
          status: "open",
          createdAt: nowIso(),
        });
        scheduleSave();
        refreshBadges();
        renderPanelIfOpen();
      },
    });
  }

  async function addPinComment(section, clickEvent) {
    let slideCid;
    try {
      slideCid = await ensureSlideCid(section);
    } catch (e) {
      showBanner("error", `Could not anchor slide: ${e.message}`);
      return;
    }
    const rect = section.getBoundingClientRect();
    const x = (clickEvent.clientX - rect.left) / rect.width;
    const y = (clickEvent.clientY - rect.top) / rect.height;
    // Pick the element under the cursor (excluding our own pins) for context.
    const stack = document.elementsFromPoint(clickEvent.clientX, clickEvent.clientY);
    const beneath = stack.find(
      (n) => n && !n.closest(".sc-root") && !n.classList.contains("sc-pin") && section.contains(n)
    );
    const near = beneath ? nearestAnchoredTarget(nearestMeaningful(beneath), section) : null;

    openComposer({
      titleText: `Pin at ${(x * 100).toFixed(0)}%, ${(y * 100).toFixed(0)}%`,
      anchor: { left: clickEvent.clientX, right: clickEvent.clientX, bottom: clickEvent.clientY, width: 0, height: 0 },
      onSave: (text) => {
        const id = nextCommentId();
        const record = {
          id,
          type: "pin",
          slideCid,
          position: { x: +x.toFixed(4), y: +y.toFixed(4) },
          nearestSelector: near ? `[data-cid='${near.getAttribute("data-cid")}']` : "",
          nearestText: trimText(near ? near.textContent : "", 160),
          snapshot: `${HTML_FILENAME.replace(/\.html?$/i, "")}.comments/${slideCid}.png`,
          text,
          status: "open",
          createdAt: nowIso(),
        };
        state.comments.push(record);
        renderPins(section);
        void snapshotSlide(section);
        scheduleSave();
        renderPanelIfOpen();
      },
    });
  }

  // ---- Pasted-image comments --------------------------------------------
  function clipboardImageItem(clipboard) {
    if (!clipboard || !clipboard.items) return null;
    for (const item of clipboard.items) {
      if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
        return item;
      }
    }
    return null;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error("FileReader failed"));
      fr.readAsDataURL(file);
    });
  }

  async function onPaste(ev) {
    // Don't hijack pastes while the user is editing slide text, a comment
    // composer, a textarea, or any other typing target.
    if (isTypingTarget()) return;
    if (insideOverlay(ev.target)) return;
    const item = clipboardImageItem(ev.clipboardData);
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    ev.preventDefault();
    const section = currentSection();
    if (!section) {
      showBanner("error", "No current slide — switch to a slide before pasting.");
      return;
    }
    let slideCid;
    try {
      slideCid = await ensureSlideCid(section);
    } catch (e) {
      showBanner("error", `Could not anchor slide: ${e.message}`);
      return;
    }
    let dataUrl;
    try {
      dataUrl = await fileToDataUrl(file);
    } catch (e) {
      showBanner("error", `Could not read clipboard image: ${e.message}`);
      return;
    }
    let saved;
    try {
      saved = await apiPost("/save-pasted-image", { dataUrl }, { slide: slideCid });
    } catch (e) {
      showBanner("error", `Could not save pasted image: ${e.message}`);
      return;
    }
    openComposer({
      titleText: `Pasted image · ${file.type || "image"}`,
      anchor: section,
      previewImageUrl: dataUrl,
      placeholder: "Note for the agent — e.g. 'add as a figure on this slide, caption below'",
      onSave: (text) => {
        const indices = currentSlideIndices();
        state.comments.push({
          id: nextCommentId(),
          type: "image",
          slideCid,
          slideIndexAtCreate: indices ? indices.h : -1,
          slideVIndexAtCreate: indices ? indices.v : 0,
          imagePath: saved.path,
          imageMime: file.type || "",
          imageBytes: saved.bytes,
          text,
          status: "open",
          createdAt: nowIso(),
        });
        scheduleSave();
        refreshBadges();
        renderPanelIfOpen();
        showBanner("info", `Image saved to ${saved.path} — comment queued for the agent.`);
      },
      onCancel: () => {
        // Best-effort cleanup so cancelled pastes don't leave orphan files.
        void apiPost("/delete-pasted-image", { path: saved.path }).catch(() => {});
      },
    });
  }

  function insideOverlay(node) {
    return !!(node && node.closest && node.closest(".sc-root, .sc-popover"));
  }

  // ---- Comment-indicator badges -----------------------------------------
  function refreshBadges() {
    document
      .querySelectorAll(".sc-has-comment")
      .forEach((el) => el.classList.remove("sc-has-comment"));
    const cids = new Set();
    state.comments.forEach((c) => {
      if (c.status === "resolved") return;
      if (c.type === "slide" && c.slideCid) cids.add(c.slideCid);
      else if (c.type === "element" && c.elementCid) cids.add(c.elementCid);
    });
    cids.forEach((cid) => {
      const el = document.querySelector(`[data-cid="${cssEsc(cid)}"]`);
      if (el) el.classList.add("sc-has-comment");
    });
  }

  // ---- Pin rendering -----------------------------------------------------
  function clearPins(scope) {
    (scope || document).querySelectorAll(".sc-pin").forEach((p) => p.remove());
  }

  function renderPins(section) {
    if (!section) return;
    if (getComputedStyle(section).position === "static") {
      section.style.position = "relative";
    }
    clearPins(section);
    const cid = section.getAttribute("data-cid");
    if (!cid) return;
    const pins = state.comments.filter(
      (c) => c.type === "pin" && c.slideCid === cid && c.status !== "resolved"
    );
    pins.forEach((c, i) => {
      const dot = document.createElement("div");
      dot.className = "sc-pin";
      dot.dataset.commentId = c.id;
      dot.textContent = String(i + 1);
      dot.style.left = (c.position.x * 100).toFixed(2) + "%";
      dot.style.top = (c.position.y * 100).toFixed(2) + "%";
      dot.title = c.text;
      dot.addEventListener("click", (ev) => {
        ev.stopPropagation();
        editComment(c.id, dot);
      });
      section.appendChild(dot);
    });
  }

  // ---- Snapshots ---------------------------------------------------------
  let html2canvasPromise = null;
  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (html2canvasPromise) return html2canvasPromise;
    html2canvasPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = HTML2CANVAS_URL;
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => reject(new Error("failed to load html2canvas"));
      document.head.appendChild(s);
    });
    return html2canvasPromise;
  }

  async function postSnapshot(slideCid, dataUrl) {
    const url = `/save-snapshot?file=${encodeURIComponent(HTML_FILENAME)}&slide=${encodeURIComponent(slideCid)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      throw new Error(json.error || `save-snapshot failed (${res.status})`);
    }
    return json;
  }

  async function snapshotSlide(section) {
    if (!section) return;
    const cid = section.getAttribute("data-cid");
    if (!cid) return;
    const hasPins = state.comments.some(
      (c) => c.type === "pin" && c.slideCid === cid && c.status !== "resolved"
    );
    if (!hasPins) return;
    let h2c;
    try {
      h2c = await loadHtml2Canvas();
    } catch (e) {
      console.warn("[slide-comments] html2canvas unavailable:", e);
      return;
    }
    try {
      const canvas = await h2c(section, {
        backgroundColor: "#ffffff",
        useCORS: true,
        logging: false,
        scale: Math.min(2, window.devicePixelRatio || 1),
      });
      await postSnapshot(cid, canvas.toDataURL("image/png"));
    } catch (e) {
      console.warn("[slide-comments] snapshot failed:", e);
    }
  }

  // ---- Comment editing ---------------------------------------------------
  function editComment(commentId, anchor) {
    const c = state.comments.find((x) => x.id === commentId);
    if (!c) return;
    openComposer({
      titleText: `Edit ${c.type} comment`,
      anchor,
      initial: c.text,
      onSave: (text) => {
        c.text = text;
        c.updatedAt = nowIso();
        scheduleSave();
        refreshBadges();
        renderPanelIfOpen();
        const section = currentSection();
        if (section && section.getAttribute("data-cid") === c.slideCid) {
          renderPins(section);
          if (c.type === "pin") void snapshotSlide(section);
        }
      },
    });
  }

  function deleteComment(commentId) {
    const idx = state.comments.findIndex((x) => x.id === commentId);
    if (idx < 0) return;
    const c = state.comments[idx];
    state.comments.splice(idx, 1);
    scheduleSave();
    refreshBadges();
    renderPanelIfOpen();
    const section = currentSection();
    if (section && section.getAttribute("data-cid") === c.slideCid) {
      renderPins(section);
      if (c.type === "pin") void snapshotSlide(section);
    }
  }

  function toggleResolve(commentId) {
    const c = state.comments.find((x) => x.id === commentId);
    if (!c) return;
    c.status = c.status === "resolved" ? "open" : "resolved";
    if (c.status === "resolved") {
      c.resolvedAt = nowIso();
    } else {
      delete c.resolvedAt;
    }
    scheduleSave();
    refreshBadges();
    renderPanelIfOpen();
    const section = currentSection();
    if (section && section.getAttribute("data-cid") === c.slideCid) {
      renderPins(section);
      if (c.type === "pin") void snapshotSlide(section);
    }
  }

  // ---- Panel rendering ---------------------------------------------------
  function renderPanelIfOpen() {
    if (state.panelOpen) renderPanel();
  }

  function renderPanel() {
    const list = $(".sc-panel .sc-list");
    if (!list) return;
    list.innerHTML = "";
    if (state.comments.length === 0) {
      const empty = document.createElement("div");
      empty.className = "sc-empty";
      empty.textContent = "No comments yet. Pick a mode and click a slide.";
      list.appendChild(empty);
      return;
    }

    // group by slideCid, preserving insertion order
    const order = [];
    const groups = new Map();
    state.comments.forEach((c) => {
      const key = c.slideCid || "(no slide)";
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key).push(c);
    });

    order.forEach((key) => {
      const group = document.createElement("div");
      group.className = "sc-slide-group";
      const head = document.createElement("div");
      head.className = "sc-slide-head";
      const sect = document.querySelector(`section[data-cid="${cssEsc(key)}"]`);
      const indices = sect ? revealIndicesForSection(sect) : null;
      head.textContent = sect
        ? `${slideLabel(indices)} · ${key}`
        : `Slide ${key}`;
      head.style.cursor = "pointer";
      head.addEventListener("click", () => {
        if (window.Reveal && indices) Reveal.slide(indices.h, indices.v);
      });
      group.appendChild(head);
      groups.get(key).forEach((c) => group.appendChild(renderCard(c)));
      list.appendChild(group);
    });
  }

  function renderCard(c) {
    const card = document.createElement("div");
    card.className = `sc-card${c.status === "resolved" ? " sc-resolved" : ""}`;
    card.dataset.commentId = c.id;
    const meta = document.createElement("div");
    meta.className = "sc-meta";
    meta.innerHTML = `<span class="sc-type">${c.type}</span><span>${c.id}</span>`;
    const body = document.createElement("div");
    body.className = "sc-body";
    body.textContent = c.text;
    card.appendChild(meta);
    card.appendChild(body);
    if (c.type === "element" && c.elementText) {
      const snip = document.createElement("div");
      snip.className = "sc-snippet";
      snip.textContent = `↳ ${c.elementText}`;
      card.appendChild(snip);
    } else if (c.type === "pin") {
      const snip = document.createElement("div");
      snip.className = "sc-snippet";
      const xy = `${(c.position.x * 100).toFixed(0)}%, ${(c.position.y * 100).toFixed(0)}%`;
      snip.textContent = `↳ pin ${xy}${c.nearestText ? ` · near “${c.nearestText}”` : ""}`;
      card.appendChild(snip);
    }
    if (c.resolution) {
      const r = document.createElement("div");
      r.className = "sc-snippet";
      r.textContent = `note: ${c.resolution}`;
      card.appendChild(r);
    }
    const controls = document.createElement("div");
    controls.className = "sc-controls";
    controls.innerHTML = `
      <button data-act="edit">Edit</button>
      <button data-act="toggle">${c.status === "resolved" ? "Reopen" : "Resolve"}</button>
      <button data-act="delete" class="sc-danger">Delete</button>
    `;
    controls.addEventListener("click", (ev) => {
      const t = ev.target.closest("[data-act]");
      if (!t) return;
      const act = t.dataset.act;
      if (act === "edit") editComment(c.id, card);
      else if (act === "toggle") toggleResolve(c.id);
      else if (act === "delete") {
        if (confirm(`Delete comment ${c.id}?`)) deleteComment(c.id);
      }
    });
    card.appendChild(controls);
    return card;
  }

  // ---- Click & hover dispatch -------------------------------------------
  let hoverHighlight = null;
  function setHoverHighlight(el) {
    if (hoverHighlight === el) return;
    if (hoverHighlight) hoverHighlight.classList.remove("sc-element-hover");
    hoverHighlight = el;
    if (el) el.classList.add("sc-element-hover");
  }

  function isInOurUI(el) {
    return !!(el && el.closest && el.closest(".sc-root, .sc-popover, .sc-pin"));
  }

  function onMouseMove(ev) {
    if (state.mode !== "element") return;
    if (isInOurUI(ev.target)) {
      setHoverHighlight(null);
      return;
    }
    const section = currentSection();
    if (!section || !section.contains(ev.target)) {
      setHoverHighlight(null);
      return;
    }
    setHoverHighlight(commentTargetFromPoint(ev, section));
  }

  function onClick(ev) {
    if (!state.mode) return;
    if (isInOurUI(ev.target)) return;
    const section = currentSection();
    if (!section || !section.contains(ev.target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (state.mode === "slide") {
      addSlideComment(section);
    } else if (state.mode === "element") {
      const target = commentTargetFromPoint(ev, section);
      if (!target) return;
      setHoverHighlight(null);
      addElementComment(target);
    } else if (state.mode === "pin") {
      addPinComment(section, ev);
    }
  }

  // ---- Direct text edit (dbl-click) -------------------------------------
  function isEditableTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    if (isInOurUI(el)) return false;
    if (el.tagName === "SECTION") return false;
    if (el.classList.contains("sc-pin")) return false;
    return true;
  }

  async function onDblClick(ev) {
    if (state.mode) return; // dbl-click only when no mode is active
    if (!isEditableTarget(ev.target)) return;
    const section = currentSection();
    if (!section || !section.contains(ev.target)) return;
    const target = nearestAnchoredTarget(ev.target, section);
    if (!target) return;
    ev.preventDefault();
    ev.stopPropagation();
    await beginEdit(target);
  }

  async function beginEdit(el) {
    if (el.isContentEditable) return;
    let elementCid;
    try {
      const ids = await ensureElementCid(el);
      elementCid = ids.elementCid;
    } catch (e) {
      showBanner("error", `Could not anchor element for edit: ${e.message}`);
      return;
    }
    const originalHtml = el.innerHTML;
    // Suppress reveal.js's own keyboard shortcuts while the user is editing.
    // Without this, single-letter bindings (notably "?" → help overlay, "n/p"
    // → navigate slides, "f" → fullscreen) fire even though they're also
    // being typed into the contenteditable. Our window-capture handler stops
    // propagation, but reveal binds in capture on document and sometimes
    // fires first depending on script load order — disabling its keyboard
    // module is the only reliable suppression.
    const revealHadKeyboard = !!(
      window.Reveal && Reveal.getConfig && (Reveal.getConfig().keyboard !== false)
    );
    if (revealHadKeyboard) {
      try { Reveal.configure({ keyboard: false }); } catch (e) { /* noop */ }
    }
    // plaintext-only prevents the browser from wrapping typed text in
    // <font>/<span style> when the user types (which corrupts the HTML).
    // Existing tags like <strong> inside the element are still rendered.
    el.contentEditable = "plaintext-only";
    if (el.contentEditable !== "plaintext-only") {
      // Firefox doesn't support plaintext-only; fall back to true and
      // rely on server-side sanitization to strip injected formatting tags.
      el.contentEditable = "true";
    }
    el.classList.add("sc-editing");
    el.focus();
    // Select all text to make typing-over fast.
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      /* selection optional */
    }

    let finished = false;
    const finish = async (commit) => {
      if (finished) return;
      finished = true;
      state.editorKeyHandler = null;
      el.contentEditable = "false";
      el.classList.remove("sc-editing");
      el.removeEventListener("blur", onBlur);
      if (revealHadKeyboard) {
        try { Reveal.configure({ keyboard: true }); } catch (e) { /* noop */ }
      }
      if (!commit) {
        el.innerHTML = originalHtml;
        return;
      }
      const newHtml = htmlWithPreservedLineBreaks(el);
      if (newHtml === originalHtml) return;
      try {
        const res = await apiPost("/save-element-html", {
          cid: elementCid,
          innerHtml: newHtml,
          lastMtime: state.htmlMtime,
        });
        if (res && res.stale) {
          showBanner(
            "warn",
            "The HTML changed on disk during your edit. Reload before more edits.",
            true
          );
        }
        if (res && res.htmlMtime) state.htmlMtime = res.htmlMtime;
        el.innerHTML = newHtml;
        el.classList.add("sc-edit-saved");
        setTimeout(() => el.classList.remove("sc-edit-saved"), 700);
      } catch (e) {
        el.innerHTML = originalHtml;
        showBanner("error", `Could not save edit: ${e.message}`);
      }
    };

    state.editorKeyHandler = (kev) => {
      if (kev.target !== el && !el.contains(kev.target)) return false;
      kev.stopPropagation();
      if (kev.key === "Escape") {
        kev.preventDefault();
        void finish(false);
      } else if (kev.key === "Enter" && (kev.metaKey || kev.ctrlKey)) {
        kev.preventDefault();
        void finish(true);
      } else if (kev.key === "Enter") {
        // Insert an explicit <br> at the cursor rather than letting the
        // browser drop a \n into the text node. Browser-inserted \n can land
        // in a text node's leading or trailing whitespace (e.g. right after a
        // </strong> or at the end of the element) where htmlWithPreservedLineBreaks
        // treats it as source-format indentation and strips it on save — so
        // the linebreak wouldn't take effect until a second edit happened to
        // place a \n inside the body of a text node.
        kev.preventDefault();
        insertBrAtCursor(el);
      }
      return true;
    };
    const onBlur = () => {
      // small defer so Escape's blur doesn't race the keydown handler
      setTimeout(() => void finish(true), 0);
    };
    el.addEventListener("blur", onBlur);
  }

  // ---- Global keyboard shortcuts ----------------------------------------
  function isTypingTarget() {
    const ae = document.activeElement;
    if (!ae) return false;
    if (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT") return true;
    if (ae.isContentEditable) return true;
    return false;
  }

  function onGlobalKeydown(ev) {
    if (state.editorKeyHandler && state.editorKeyHandler(ev)) return;
    if (isTypingTarget()) return;
    if (ev.key === "Escape" && state.mode) {
      ev.preventDefault();
      ev.stopPropagation();
      setMode(null);
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // Shift+S / Shift+E / Shift+P activate modes. Uppercase letters avoid
    // colliding with reveal.js's lowercase bindings (s = speaker notes,
    // p = previous slide).
    if (!ev.shiftKey) return;
    let target = null;
    if (ev.key === "S") target = "slide";
    else if (ev.key === "E") target = "element";
    else if (ev.key === "P") target = "pin";
    if (target) {
      ev.preventDefault();
      ev.stopPropagation();
      if (target === "slide") {
        const section = currentSection();
        if (!section) {
          showBanner("error", "No current slide.");
          return;
        }
        setMode(null);
        void addSlideComment(section);
      } else {
        setMode(target);
      }
    }
  }

  // ---- Slide change ------------------------------------------------------
  function onSlideChanged() {
    const section = currentSection();
    if (state.prevSection && state.prevSection !== section) {
      void snapshotSlide(state.prevSection);
    }
    state.prevSection = section;
    if (section) renderPins(section);
  }

  // ---- Boot --------------------------------------------------------------
  async function boot() {
    buildChrome();
    await loadInitialComments();
    await loadHtmlMtime();
    refreshBadges();
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("dblclick", onDblClick, true);
    window.addEventListener("keydown", onGlobalKeydown, true);
    document.addEventListener("paste", onPaste, true);
    if (window.Reveal && Reveal.isReady && Reveal.isReady()) {
      hookReveal();
    } else if (window.Reveal) {
      Reveal.on("ready", hookReveal);
    } else {
      // Non-reveal page: still render pins on initial section if any.
      const first = document.querySelector("section[data-cid]");
      if (first) renderPins(first);
    }
    // If reveal never becomes ready, surface a banner so the user knows
    // why clicks aren't doing anything.
    setTimeout(() => {
      const ready =
        window.Reveal && Reveal.isReady && Reveal.isReady() && currentSection();
      if (!ready) {
        showBanner(
          "warn",
          "Reveal.js didn't finish loading — slide navigation is disabled and comments can't anchor. Reload the page.",
          true
        );
      }
    }, 5000);
    // capture remaining pin snapshots on page unload (best-effort)
    window.addEventListener("beforeunload", () => {
      const section = currentSection();
      if (section) void snapshotSlide(section);
    });
  }

  function hookReveal() {
    Reveal.on("slidechanged", onSlideChanged);
    onSlideChanged();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

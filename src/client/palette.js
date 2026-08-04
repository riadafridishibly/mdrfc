import { html, render, useState, useEffect, useRef, useCallback } from "/_preact.js";

const CFG = window.__mdrfc || {};
const GROUP = { local: "This document", file: "Files", heading: "Headings", text: "Content" };

/** fzf's extended search operators, shown as a legend before anything is typed. */
const SYNTAX = [
  ["^abc", "starts"],
  ["abc$", "ends"],
  ["'abc", "exact"],
  ["!abc", "omit"],
  ["a|b", "either"],
];

/** Match every whitespace-separated term against `text`; returns the earliest hit. */
function matchTerms(text, terms) {
  const low = text.toLowerCase();
  let at = -1;
  let len = 0;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i === -1) return null;
    if (at === -1 || i < at) {
      at = i;
      len = t.length;
    }
  }
  return at === -1 ? null : [at, len];
}

/**
 * Headings of the document already in the DOM. Instant, no network, and the
 * only source of results when serving a single file or stdin.
 * An empty query yields the full outline.
 */
function localHeadings(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  const nodes = document.querySelectorAll("main h1, main h2, main h3, main h4, main h5, main h6");
  for (const h of nodes) {
    if (!h.id) continue;
    const text = h.textContent.trim();
    const range = terms.length ? matchTerms(text, terms) : null;
    if (terms.length && !range) continue;
    out.push({
      kind: "local",
      key: "local:" + h.id,
      text,
      anchor: h.id,
      depth: Number(h.tagName[1]),
      range,
    });
  }
  return out.slice(0, 40);
}

/**
 * Reorder hits so every hit from one file sits together, files kept in
 * best-hit order and lines in document order within a file. Lets the list
 * state each path once as a header instead of repeating it on every row.
 */
function groupByFile(hits) {
  const order = [];
  const byPath = new Map();
  for (const h of hits) {
    let bucket = byPath.get(h.path);
    if (!bucket) {
      bucket = [];
      byPath.set(h.path, bucket);
      order.push(h.path);
    }
    bucket.push(h);
  }
  return order.flatMap((p) => byPath.get(p).sort((a, b) => a.line - b.line));
}

/** Files stay flat (the path is the result); headings and content group by file. */
function arrange(hits) {
  return [
    ...hits.filter((h) => h.kind === "file"),
    ...groupByFile(hits.filter((h) => h.kind === "heading")),
    ...groupByFile(hits.filter((h) => h.kind === "text")),
  ];
}

function Highlight({ text, range, indices }) {
  if (range) {
    const [s, l] = range;
    return html`${text.slice(0, s)}<mark>${text.slice(s, s + l)}</mark>${text.slice(s + l)}`;
  }
  if (indices && indices.length) {
    const set = new Set(indices);
    return html`${text.split("").map((c, i) => (set.has(i) ? html`<mark>${c}</mark>` : c))}`;
  }
  return html`${text}`;
}

/** Path header above a file's hits. The directory prefix truncates; the
 *  filename is never allowed to shrink away. */
function FileHead({ path }) {
  const cut = path.lastIndexOf("/");
  return html`
    <li class="mdrfc-p-file" role="presentation">
      ${cut === -1 ? null : html`<span class="mdrfc-p-dir">${path.slice(0, cut + 1)}</span>`}
      <span class="mdrfc-p-base">${path.slice(cut + 1)}</span>
    </li>
  `;
}

function Row({ hit, active, onPick, onHover }) {
  const filed = hit.kind === "heading" || hit.kind === "text";
  return html`
    <li
      class=${"mdrfc-p-row" + (active ? " active" : "")}
      role="option"
      aria-selected=${active}
      onMouseMove=${onHover}
      onClick=${onPick}
    >
      ${filed ? html`<span class="mdrfc-p-line">${hit.line}</span>` : null}
      <span class="mdrfc-p-main" style=${hit.kind === "local" ? `padding-left:${(hit.depth - 1) * 10}px` : ""}>
        <${Highlight} text=${hit.text} range=${hit.range} indices=${hit.indices} />
      </span>
    </li>
  `;
}

function Palette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState([]);
  const [extended, setExtended] = useState(false);
  const [error, setError] = useState(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const hits = [...localHeadings(query), ...remote];

  // ── open / close ────────────────────────────────────────────
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => {
          if (!v) {
            setQuery("");
            setSel(0);
            // don't stack the palette on top of the settings drawer
            document.getElementById("mdrfc-panel")?.classList.remove("open");
          }
          return !v;
        });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // ── server-side content search (directory mode only) ─────────
  useEffect(() => {
    if (!open || !CFG.dirMode || !query.trim()) {
      setRemote([]);
      setExtended(false);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetch("/_search?q=" + encodeURIComponent(query), { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("search failed: " + r.status))))
        .then((data) => {
          setRemote(arrange(data.hits).map((h, i) => ({ ...h, key: "r" + i })));
          setExtended(data.extended);
          setError(null);
        })
        .catch((err) => {
          // An aborted request is just a superseded keystroke, not a failure.
          if (err && err.name === "AbortError") return;
          setRemote([]);
          // Reporting beats an empty list: a silent catch here turns any
          // breakage into an indistinguishable "No matches".
          setError(String((err && err.message) || err));
        });
    }, 80);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [open, query]);

  useEffect(() => setSel(0), [query]);

  // keep the highlighted row in view as the selection moves
  useEffect(() => {
    listRef.current?.querySelector(".mdrfc-p-row.active")?.scrollIntoView({ block: "nearest" });
  }, [sel, hits.length]);

  const pick = useCallback(
    (hit) => {
      if (!hit) return;
      setOpen(false);
      if (hit.kind === "local") {
        history.replaceState(null, "", "#" + hit.anchor);
        document.getElementById(hit.anchor)?.scrollIntoView();
        return;
      }
      const url = "/" + encodeURI(hit.path).replace(/#/g, "%23") + (hit.anchor ? "#" + hit.anchor : "");
      if (window.mdrfcNavigate) window.mdrfcNavigate(url);
      else location.href = url;
    },
    []
  );

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setSel((s) => (hits.length ? (s + 1) % hits.length : 0));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setSel((s) => (hits.length ? (s - 1 + hits.length) % hits.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(hits[sel]);
    }
  };

  if (!open) return null;

  let lastGroup = null;
  let lastPath = null;
  return html`
    <div class="mdrfc-p-backdrop" onClick=${close}>
      <div class="mdrfc-p-box" role="dialog" aria-modal="true" aria-label="Search" onClick=${(e) => e.stopPropagation()}>
        <input
          ref=${inputRef}
          class="mdrfc-p-input"
          type="text"
          spellcheck="false"
          placeholder=${CFG.dirMode ? "Search files and content…" : "Search this document…"}
          value=${query}
          onInput=${(e) => setQuery(e.target.value)}
          onKeyDown=${onKeyDown}
        />
        <ul class="mdrfc-p-list mdrfc-scroll" ref=${listRef} role="listbox">
          ${hits.length === 0 && query && !error
            ? html`<li class="mdrfc-p-empty">No matches</li>`
            : hits.map((hit, i) => {
                const group = GROUP[hit.kind];
                const header = group !== lastGroup ? ((lastGroup = group), (lastPath = null), group) : null;
                const filed = hit.kind === "heading" || hit.kind === "text";
                const file = filed && hit.path !== lastPath ? ((lastPath = hit.path), hit.path) : null;
                return html`
                  ${header ? html`<li class="mdrfc-p-group" role="presentation">${header}</li>` : null}
                  ${file ? html`<${FileHead} path=${file} />` : null}
                  <${Row}
                    key=${hit.key}
                    hit=${hit}
                    active=${i === sel}
                    onHover=${() => setSel(i)}
                    onPick=${() => pick(hit)}
                  />
                `;
              })}
        </ul>
        ${error
          ? html`<div class="mdrfc-p-hint error">${error}</div>`
          : extended
          ? html`<div class="mdrfc-p-hint active">
              Matching paths only — content search is off while the query uses operators.
            </div>`
          : CFG.dirMode && !query
            ? html`<div class="mdrfc-p-hint">
                ${SYNTAX.map(([op, label]) => html`<span><code>${op}</code>${label}</span>`)}
              </div>`
            : null}
        <div class="mdrfc-p-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  `;
}

const root = document.createElement("div");
document.body.appendChild(root);
render(html`<${Palette} />`, root);

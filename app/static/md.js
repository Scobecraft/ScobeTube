/* ScobeTube – sicherer Mini-Markdown-Renderer für die Rechtstexte.
   Erzeugt ausschließlich DOM-Knoten mit textContent – HTML im Text wird nie ausgeführt.
   Unterstützt: ### Überschrift · - Liste · 1. Liste · **fett** · *kursiv* · [Link](https://…) · Absätze/Zeilenumbrüche */
(() => {
  "use strict";
  const SAFE_URL = /^(https?:\/\/|mailto:|#|[\w\-./]+(#[\w\-]*)?$)/i;

  function inline(text, parent) {
    const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1] != null) {
        const b = document.createElement("b"); inline(m[1], b); parent.append(b);
      } else if (m[2] != null) {
        const url = m[3];
        if (SAFE_URL.test(url) && !/^\s*javascript:/i.test(url)) {
          const a = document.createElement("a"); a.href = url; a.textContent = m[2];
          if (/^https?:\/\//i.test(url)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
          parent.append(a);
        } else parent.append(m[0]);
      } else if (m[4] != null) {
        const i = document.createElement("i"); i.textContent = m[4]; parent.append(i);
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function render(src, vars = {}) {
    const text = String(src || "").replace(/\r\n?/g, "\n").replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
    const frag = document.createDocumentFragment();
    let para = null, list = null;
    const close = () => { para = null; list = null; };
    for (const raw of text.split("\n")) {
      const line = raw.trimEnd();
      if (!line.trim()) { close(); continue; }
      let m;
      if ((m = line.match(/^#{1,4}\s+(.*)$/))) {
        close(); const h = document.createElement("h3"); inline(m[1], h); frag.append(h); continue;
      }
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        const ordered = /^\s*\d/.test(line);
        if (!list || list.tagName !== (ordered ? "OL" : "UL")) {
          para = null; list = document.createElement(ordered ? "ol" : "ul"); frag.append(list);
          if (ordered) { const start = parseInt(line, 10); if (start > 1) list.start = start; }
        }
        const li = document.createElement("li"); inline(m[1], li); list.append(li); continue;
      }
      list = null;
      if (!para) { para = document.createElement("p"); frag.append(para); }
      else para.append(document.createElement("br"));
      inline(line.trim(), para);
    }
    return frag;
  }

  window.ScobeMD = { render };
})();

"use strict";
// Render untrusted model text through Markdown + sanitization. Math stays local.
(() => {
  const escapeHTML = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const mathHTML = (text, displayMode) => {
    try {
      return katex.renderToString(text, {
        displayMode,
        throwOnError: false,
        trust: false,
        strict: "ignore",
        maxExpand: 1000,
        maxSize: 20,
      });
    } catch {
      return '<code class="math-fallback">' + escapeHTML(text) + "</code>";
    }
  };
  // Tokenizers run outside fenced/inline code, so code examples keep their source.
  marked.use({
    renderer: { html: (token) => escapeHTML(token.text) },
    gfm: true,
    breaks: true,
    extensions: [
      {
        name: "displayMath",
        level: "block",
        start: (src) => {
          const m = /\$\$|\\\[/.exec(src);
          return m?.index;
        },
        tokenizer(src) {
          const match =
            /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/.exec(src);
          if (match)
            return {
              type: "displayMath",
              raw: match[0],
              text: match[1] ?? match[2],
            };
        },
        renderer: (token) => mathHTML(token.text, true),
      },
      {
        name: "inlineMath",
        level: "inline",
        start: (src) => {
          const m = /\$|\\\(/.exec(src);
          return m?.index;
        },
        tokenizer(src) {
          const match =
            /^(?:\\\(([\s\S]+?)\\\)|\$(?!\s|\$)((?:\\.|[^$\n])+?)\$(?!\d))/.exec(
              src,
            );
          if (match)
            return {
              type: "inlineMath",
              raw: match[0],
              text: match[1] ?? match[2],
            };
        },
        renderer: (token) => mathHTML(token.text, false),
      },
    ],
  });
  window.copyText = async (text, button) => {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "已复制";
    } catch {
      button.textContent = "复制失败，请手动选择";
    }
    setTimeout(() => {
      if (button.isConnected) button.textContent = original;
    }, 1800);
  };
  window.renderAssistant = (container, text) => {
    if (typeof text !== "string") text = String(text ?? "");
    try {
      container.innerHTML = DOMPurify.sanitize(marked.parse(text), {
        USE_PROFILES: { html: true, mathMl: true, svg: true },
        FORBID_TAGS: [
          "style",
          "script",
          "iframe",
          "object",
          "embed",
          "form",
          "input",
          "button",
          "img",
          "video",
          "audio",
        ],
        FORBID_ATTR: ["srcset", "id", "name"],
      });
      // No user/model-provided external image requests; links are explicit navigation only.
      for (const a of container.querySelectorAll("a")) {
        const href = a.getAttribute("href") || "";
        if (!/^https?:\/\//i.test(href) && !href.startsWith("#"))
          a.removeAttribute("href");
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      for (const pre of [...container.querySelectorAll("pre")]) {
        const code = pre.querySelector("code");
        if (!code) continue;
        const wrap = document.createElement("div");
        wrap.className = "code-block";
        const toolbar = document.createElement("div");
        toolbar.className = "code-toolbar";
        const label = document.createElement("span");
        label.textContent =
          [...code.classList]
            .find((c) => c.startsWith("language-"))
            ?.slice(9) || "代码";
        const button = document.createElement("button");
        button.textContent = "复制代码";
        button.type = "button";
        button.onclick = () => window.copyText(code.textContent, button);
        toolbar.append(label, button);
        pre.replaceWith(wrap);
        wrap.append(toolbar, pre);
      }
      for (const table of [...container.querySelectorAll("table")]) {
        const wrap = document.createElement("div");
        wrap.className = "table-scroll";
        table.replaceWith(wrap);
        wrap.append(table);
      }
    } catch {
      container.textContent = text;
    }
  };
})();

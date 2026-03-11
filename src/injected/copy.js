/**
 * 在页面里执行的“复制到剪贴板”逻辑（由 background 通过 executeScript 注入并触发）。
 *
 * 为什么要在页面内执行：
 * - 右键菜单/快捷键触发时，不打开 popup，也能完成复制
 * - 复制动作需要“用户手势”上下文；由菜单/快捷键触发时，在注入函数里写剪贴板更稳定
 *
 * 依赖：
 * - KaTeX（内置 UMD）：src/vendor/katex.min.js（用于 LaTeX -> MathML）
 * - mathml2omml（内置 ESM）：src/vendor/mathml2omml.esm.js（用于 MathML -> OMML）
 */

function looksLikeLatex(expr) {
  const s = expr.trim();
  if (!s) return false;
  if (/^[+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?$/.test(s)) return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(s)) return false;
  const strong =
    /\\[a-zA-Z]+/.test(s) ||
    /[_^]/.test(s) ||
    /[{()}[\]]/.test(s) ||
    /\\(frac|sqrt|sum|int|lim|log|ln|sin|cos|tan|alpha|beta|gamma|theta|pi|Delta|Omega)\b/.test(s);
  if (strong) return true;
  const medium = /[=<>±∓×·⋅÷∑∫√∞∂∇]/.test(s);
  if (medium) return true;
  if (/^[a-zA-Z0-9\s]+$/.test(s)) return false;
  return true;
}

function extractLatexFromText(text) {
  const out = [];
  const blockRe = /(^|[^\\])\$\$([\s\S]*?)\$\$/g;
  const inlineRe = /(^|[^\\])\$([^\n$][\s\S]*?)\$/g;
  let m;
  while ((m = blockRe.exec(text))) {
    const latex = m[2];
    if (looksLikeLatex(latex)) out.push({ latex, display: true });
  }
  while ((m = inlineRe.exec(text))) {
    const latex = m[2];
    if (looksLikeLatex(latex)) out.push({ latex, display: false });
  }
  return out;
}

function isIgnoredContainer(el) {
  const tag = el.tagName?.toLowerCase?.() || "";
  return (
    tag === "script" ||
    tag === "style" ||
    tag === "textarea" ||
    tag === "code" ||
    tag === "pre" ||
    el.isContentEditable
  );
}

function collectRenderedMath(root) {
  const hits = [];
  const seen = new Set();

  root.querySelectorAll?.("math").forEach((math) => {
    const mathml = math.outerHTML;
    const key = `mathml:${mathml}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind: "mathml", value: mathml, display: false, source: "mathml-tag" });
  });

  root.querySelectorAll?.(".katex-mathml math").forEach((math) => {
    const mathml = math.outerHTML;
    const key = `katex:${mathml}`;
    if (seen.has(key)) return;
    seen.add(key);
    const display = !!math.closest(".katex-display");
    hits.push({ kind: "mathml", value: mathml, display, source: "katex" });
  });

  root.querySelectorAll?.("mjx-container mjx-assistive-mml math").forEach((math) => {
    const mathml = math.outerHTML;
    const key = `mathjax:${mathml}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind: "mathml", value: mathml, display: false, source: "mathjax" });
  });

  return hits;
}

function collectLatexText(root) {
  const hits = [];
  const seen = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (isIgnoredContainer(parent)) return NodeFilter.FILTER_REJECT;
      const t = node.nodeValue || "";
      if (!t.includes("$")) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue || "";
    const parts = extractLatexFromText(t);
    for (const p of parts) {
      const key = `${p.display ? "D" : "I"}:${p.latex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ kind: "latex", value: p.latex, display: p.display, source: "text" });
    }
  }
  return hits;
}

function collectFromSelection() {
  const sel = window.getSelection?.();
  if (!sel || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  if (range.collapsed) return [];
  const container = document.createElement("div");
  container.appendChild(range.cloneContents());
  return [...collectRenderedMath(container), ...collectLatexText(container)];
}

function collectFromPage() {
  return [...collectRenderedMath(document), ...collectLatexText(document.body)];
}

function toast(message, type = "info") {
  const id = "__ai_math_copy_toast__";
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;" +
      "padding:10px 12px;border-radius:10px;font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,'Microsoft YaHei',sans-serif;" +
      "box-shadow:0 8px 24px rgba(0,0,0,.18);color:#111827;background:#fff;border:1px solid rgba(0,0,0,.08);";
    document.documentElement.appendChild(el);
  }
  const colors = {
    ok: "border-color:rgba(16,185,129,.45);",
    err: "border-color:rgba(239,68,68,.55);",
    info: "border-color:rgba(59,130,246,.35);"
  };
  el.style.cssText = el.style.cssText.replace(/border-color:[^;]+;/, "") + (colors[type] || "");
  el.textContent = message;
  clearTimeout(el.__t);
  el.__t = setTimeout(() => el.remove(), 2600);
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`加载脚本失败：${url}`));
    document.documentElement.appendChild(s);
  });
}

function latexToMathML(latex, displayMode) {
  if (!globalThis.katex?.renderToString) {
    throw new Error("KaTeX 未加载");
  }
  return globalThis.katex.renderToString(latex, { throwOnError: false, output: "mathml", displayMode });
}

function buildWordHtmlFromOmml(ommlList) {
  // 关键：mso-element:equation
  // Word 在从 HTML 剪贴板解析时，会依赖该标记把 OMML 当作“公式对象”（类似 Alt+= 插入的可编辑公式）。
  const blocks = ommlList
    .map((omml) => {
      // Word 常见：Cambria Math 字体 + MsoNormal 段落
      return `<p class="MsoNormal" style="margin:0;line-height:1.2">
<span style="mso-element:equation;font-family:'Cambria Math','Cambria Math',serif;mso-fareast-font-family:'Cambria Math';mso-bidi-font-family:'Cambria Math'">
${omml}
</span></p>`;
    })
    .join("");

  return `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
<head>
  <meta charset="utf-8">
  <style>
    p.MsoNormal { margin: 0; }
  </style>
</head>
<body>
<!--StartFragment-->${blocks}<!--EndFragment-->
</body>
</html>`;
}

async function writeClipboard(html, text) {
  if (!navigator.clipboard?.write) {
    throw new Error("不支持 clipboard.write（可能被策略限制）");
  }
  const item = new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([text], { type: "text/plain" })
  });
  await navigator.clipboard.write([item]);
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildMathmlHtml(mathmlList) {
  const body = `<pre style="white-space:pre-wrap;word-break:break-word;margin:0;font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${escapeHtml(
    mathmlList.join("\n")
  )}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><!--StartFragment-->${body}<!--EndFragment--></body></html>`;
}

export async function copyFormulasToClipboard(mode, format = "omml") {
  const hits = mode === "selection" ? collectFromSelection() : collectFromPage();
  if (!hits.length) {
    toast("未识别到公式：请先选中包含公式的区域，或使用“复制页面所有公式”。", "err");
    return { ok: false, reason: "no_hits" };
  }

  // 加载 KaTeX（UMD）一次即可
  if (!globalThis.katex) {
    await loadScript(chrome.runtime.getURL("src/vendor/katex.min.js"));
  }

  const needOmml = format !== "mathml";
  const { mml2omml } = needOmml
    ? await import(chrome.runtime.getURL("src/vendor/mathml2omml.esm.js"))
    : { mml2omml: null };

  const ommlList = [];
  const mathmlList = [];
  const plainLatex = [];
  const failures = [];

  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    try {
      let mathml;
      if (h.kind === "mathml") {
        mathml = h.value;
      } else {
        plainLatex.push(h.display ? `$$${h.value}$$` : `$${h.value}$`);
        mathml = latexToMathML(h.value, h.display);
      }
      if (needOmml && mml2omml) ommlList.push(mml2omml(mathml));
      mathmlList.push(mathml);
    } catch (e) {
      failures.push(String(e?.message || e));
    }
  }

  if (format === "mathml") {
    const mathmlText = mathmlList.join("\n");
    const html = buildMathmlHtml(mathmlList);
    await writeClipboard(html, mathmlText);
    toast(
      failures.length
        ? `已复制 MathML：${mathmlList.length}/${hits.length} 成功（${failures.length} 个失败已跳过）`
        : `复制成功：${mathmlList.length} 个公式的 MathML`,
      "ok"
    );
    return { ok: true, total: hits.length, copied: mathmlList.length, failures: failures.length };
  }

  if (!ommlList.length) {
    toast(`转换失败：${failures[0] || "未知错误"}`, "err");
    return { ok: false, reason: "convert_failed" };
  }

  const html = buildWordHtmlFromOmml(ommlList);
  const text = plainLatex.length ? plainLatex.join("\n") : hits.map((h) => h.value).join("\n");
  await writeClipboard(html, text);
  toast(
    failures.length
      ? `已复制：${ommlList.length}/${hits.length} 成功（${failures.length} 个失败已跳过）`
      : `复制成功：${ommlList.length} 个公式（可直接粘贴到 Word）`,
    "ok"
  );
  return { ok: true, total: hits.length, copied: ommlList.length, failures: failures.length };
}


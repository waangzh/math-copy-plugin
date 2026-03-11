/**
 * content script（运行在页面内）
 *
 * 目标：
 * - 从主流 AI 平台回答区域中识别、抽取公式
 * - 支持三类来源：
 *   1) 原生 MathML：<math>...</math>
 *   2) KaTeX 渲染后的 MathML：.katex-mathml 内的 <math>
 *   3) MathJax 渲染后的 assistive MathML：mjx-container 内的 <mjx-assistive-mml><math>
 *   4) 文本中的 LaTeX：$...$（行内）和 $$...$$（块级）
 *
 * 注意：
 * - “无损转换到 OMML”的工作在 popup 中完成（因为需要写剪贴板，且可加载转换库）。
 * - 这里的职责是“尽可能准确地找到公式”，并且尽量避免把价格 $19.9 等误判为公式。
 */

/**
 * @typedef {Object} FormulaHit
 * @property {'mathml'|'latex'} kind
 * @property {string} value - kind=mathml 时为 MathML 字符串；kind=latex 时为 latex 内容（不包含 $ 或 $$）
 * @property {boolean} display - 是否为块级公式
 * @property {string} source - 命中来源（katex/mathjax/mathml-tag/text）
 */

/**
 * 规则：判断一段 $...$ 的内容是否“更像 LaTeX 公式”而不是普通美元符号文本。
 *
 * 设计原则（经验法则）：
 * - LaTeX 公式通常包含：反斜杠命令（\frac）、上下标（^/_）、花括号、比较/运算符等
 * - 价格/金额通常是纯数字 + 小数点/逗号，或与货币符号相关，且不含 LaTeX 特征
 *
 * 这不是形式化证明，而是为了在网页文本扫描中降低误报。
 */
function looksLikeLatex(expr) {
  const s = expr.trim();
  if (!s) return false;

  // 1) 明确的“价格/金额”模式：纯数字（可带千分位/小数），不算公式
  if (/^[+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?$/.test(s)) return false;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(s)) return false;

  // 2) 太短的一般不算（例如 "$x$" 很可能是变量，也可能是公式；这里允许，但需更强特征）
  //    为了不过度过滤，这里不直接以长度否决。

  // 3) 强特征：LaTeX 命令、上下标、分式/根号/求和/积分等
  const strong =
    /\\[a-zA-Z]+/.test(s) ||
    /[_^]/.test(s) ||
    /[{()}[\]]/.test(s) ||
    /\\(frac|sqrt|sum|int|lim|log|ln|sin|cos|tan|alpha|beta|gamma|theta|pi|Delta|Omega)\b/.test(s);
  if (strong) return true;

  // 4) 中等特征：包含典型数学符号
  const medium = /[=<>±×÷∩∪√∞∂∇]/.test(s);
  if (medium) return true;

  // 5) 兜底：只有字母数字的短串（如 "x"、"abc"）很可能是“变量说明”而非公式，
  //    但也可能是用户想复制的公式。这里选择：不作为公式，减少误报。
  if (/^[a-zA-Z0-9\s]+$/.test(s)) return false;

  return true;
}

/**
 * 从一个文本节点中提取 LaTeX 片段：$...$ 和 $$...$$。
 * - 支持转义 \$（不作为分隔符）
 * - 尽量避免跨段/跨节点匹配（只在单个文本节点内匹配）
 *
 * @param {string} text
 * @returns {Array<{latex:string, display:boolean}>}
 */
function extractLatexFromText(text) {
  /** @type {Array<{latex:string, display:boolean}>} */
  const out = [];

  // 先抓 $$...$$（块级），再抓 $...$（行内），避免互相干扰
  // 说明：
  // - (?:^|[^\\]) 用于避免转义 \$ 触发开始
  // - [\s\S]*? 非贪婪匹配
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
  // 不在代码块/脚本/样式/输入框中识别公式，降低误报。
  return (
    tag === "script" ||
    tag === "style" ||
    tag === "textarea" ||
    tag === "code" ||
    tag === "pre" ||
    el.isContentEditable
  );
}

/**
 * 扫描一个根节点，抽取 MathML/KaTeX/MathJax 公式。
 * @param {ParentNode} root
 * @returns {FormulaHit[]}
 */
function collectRenderedMath(root) {
  /** @type {FormulaHit[]} */
  const hits = [];
  const seen = new Set();

  // 1) 原生 <math>
  root.querySelectorAll?.("math").forEach((math) => {
    const mathml = math.outerHTML;
    const key = `mathml:${mathml}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind: "mathml", value: mathml, display: isBlockLike(math), source: "mathml-tag" });
  });

  // 2) KaTeX：.katex-mathml 中通常有 <math>
  root.querySelectorAll?.(".katex-mathml math").forEach((math) => {
    const mathml = math.outerHTML;
    const key = `katex:${mathml}`;
    if (seen.has(key)) return;
    seen.add(key);
    const display = !!math.closest(".katex-display");
    hits.push({ kind: "mathml", value: mathml, display, source: "katex" });
  });

  // 3) MathJax v3：mjx-container > mjx-assistive-mml > math
  root.querySelectorAll?.("mjx-container mjx-assistive-mml math").forEach((math) => {
    const mathml = math.outerHTML;
    const key = `mathjax:${mathml}`;
    if (seen.has(key)) return;
    seen.add(key);
    const display = !!math.closest("mjx-container[jax='SVG'][display='true'], mjx-container[display='true']");
    hits.push({ kind: "mathml", value: mathml, display, source: "mathjax" });
  });

  return hits;
}

function isBlockLike(el) {
  // 经验：MathML 本身不一定带 display 信息，尽量从上下文推断
  const style = window.getComputedStyle?.(el);
  if (style && (style.display === "block" || style.display === "flex")) return true;
  if (el.closest?.("p, div, li")) {
    // 如果 <math> 独占一行，可能是块级；这里不强判，返回 false 由上层决定
    return false;
  }
  return false;
}

/**
 * 扫描文本节点，提取 $...$ 公式。
 * @param {ParentNode} root
 * @returns {FormulaHit[]}
 */
function collectLatexText(root) {
  /** @type {FormulaHit[]} */
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

/**
 * 根据当前选择范围，收集“选中内容”里的公式。
 * @returns {FormulaHit[]}
 */
function collectFromSelection() {
  const sel = window.getSelection?.();
  if (!sel || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  if (range.collapsed) return [];

  // 克隆选区内内容到一个离屏容器，避免破坏页面
  const container = document.createElement("div");
  container.appendChild(range.cloneContents());

  return [...collectRenderedMath(container), ...collectLatexText(container)];
}

/**
 * 收集页面内全部公式。
 * @returns {FormulaHit[]}
 */
function collectFromPage() {
  // 这里可以根据平台做更精细的“回答区域”定位（减少误报和扫描量）：
  // - ChatGPT：main / article / [data-message-author-role]
  // - 文心/豆包/星火：不同站点结构不同
  // 本版本先用 document.body，全量扫描；后续可做平台适配增强。
  return [...collectRenderedMath(document), ...collectLatexText(document.body)];
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "COLLECT_FORMULAS") return;
  try {
    /** @type {FormulaHit[]} */
    const hits = msg.mode === "selection" ? collectFromSelection() : collectFromPage();
    sendResponse({ ok: true, hits });
  } catch (e) {
    sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
  }
  // 表示我们同步 sendResponse
  return true;
});

/**
 * ===========================
 * 悬浮复制（鼠标移入公式 → 出现复制标志 → 点击复制）
 * ===========================
 *
 * 目标：接近“Word 里 Alt+= 的可编辑公式对象”
 * 方法：抽取当前公式的 MathML -> 转 OMML -> 以 text/html 写入剪贴板
 *
 * 注意：这里优先支持“渲染后的公式元素”（MathML/KaTeX/MathJax）。
 * 对“纯 $...$ 文本公式”，要做到“鼠标移上去就是这个公式”需要把文本拆成 span 包装，
 * 会改变页面 DOM，风险更高；本版本先不对纯文本做 hover 复制（仍可用弹窗/右键整体复制）。
 */

const HOVER_ATTR = "data-ai-math-copy-target";
const BTN_ID = "__ai_math_copy_hover_btn__";
const TOAST_ID = "__ai_math_copy_hover_toast__";
const HOVER_STYLE_ID = "__ai_math_copy_hover_style__";

function ensureToast() {
  let el = document.getElementById(TOAST_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = TOAST_ID;
  el.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;" +
    "padding:10px 12px;border-radius:10px;font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,'Microsoft YaHei',sans-serif;" +
    "box-shadow:0 8px 24px rgba(0,0,0,.18);color:#111827;background:#fff;border:1px solid rgba(0,0,0,.08);display:none;";
  document.documentElement.appendChild(el);
  return el;
}

function toast(message, type = "info") {
  const el = ensureToast();
  const colors = {
    ok: "rgba(16,185,129,.55)",
    err: "rgba(239,68,68,.6)",
    info: "rgba(59,130,246,.4)"
  };
  el.style.borderColor = colors[type] || colors.info;
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(el.__t);
  el.__t = setTimeout(() => {
    el.style.display = "none";
  }, 2600);
}

function buildWordHtmlFromOmml(omml) {
  // 关键：mso-element:equation
  // Word 在从 HTML 剪贴板解析时，会依赖该标记把 OMML 当作“公式对象”（类似 Alt+= 插入的可编辑公式）。
  return `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
<head>
  <meta charset="utf-8">
  <style>p.MsoNormal{margin:0;}</style>
</head>
<body>
<!--StartFragment-->
<p class="MsoNormal" style="margin:0;line-height:1.2">
  <span style="mso-element:equation;font-family:'Cambria Math','Cambria Math',serif;mso-fareast-font-family:'Cambria Math';mso-bidi-font-family:'Cambria Math'">
    ${omml}
  </span>
</p>
<!--EndFragment-->
</body>
</html>`;
}

function escapeHtml(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildMathmlHtml(mathml) {
  const body = `<pre style="white-space:pre-wrap;word-break:break-word;margin:0;font:12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${escapeHtml(
    mathml
  )}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><!--StartFragment-->${body}<!--EndFragment--></body></html>`;
}

async function writeClipboard(html, text) {
  if (!navigator.clipboard?.write) throw new Error("不支持 clipboard.write（可能被策略限制）");
  const item = new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([text], { type: "text/plain" })
  });
  await navigator.clipboard.write([item]);
}

async function ensureOmmlConverter() {
  // 动态 import ESM（扩展资源）
  const url = chrome.runtime.getURL("src/vendor/mathml2omml.esm.js");
  return await import(url);
}

function findMathmlForTarget(targetEl) {
  if (!targetEl) return null;

  // KaTeX：优先从 .katex-mathml 取 <math>（通常最规范）
  const katexMath = targetEl.querySelector?.(".katex-mathml math") || targetEl.closest?.(".katex")?.querySelector?.(".katex-mathml math");
  if (katexMath) return { mathml: katexMath.outerHTML, source: "katex" };

  // MathJax v3：assistive MathML
  const mjxMath = targetEl.querySelector?.("mjx-assistive-mml math") || targetEl.closest?.("mjx-container")?.querySelector?.("mjx-assistive-mml math");
  if (mjxMath) return { mathml: mjxMath.outerHTML, source: "mathjax" };

  // 原生 MathML
  const math = targetEl.matches?.("math") ? targetEl : targetEl.querySelector?.("math") || targetEl.closest?.("math");
  if (math) return { mathml: math.outerHTML, source: "mathml-tag" };

  return null;
}

function getOrCreateHoverButton() {
  let btn = document.getElementById(BTN_ID);
  if (btn) return btn;

  btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.type = "button";
  btn.textContent = "复制";
  btn.style.cssText =
    "position:fixed;z-index:2147483647;display:none;align-items:center;justify-content:center;" +
    "padding:6px 10px;border-radius:999px;border:1px solid rgba(37,99,235,.45);" +
    "background:rgba(37,99,235,.95);color:#fff;font-size:12px;font-weight:700;cursor:pointer;" +
    "box-shadow:0 8px 24px rgba(0,0,0,.18);";
  document.documentElement.appendChild(btn);

  return btn;
}

let currentTarget = null;
let previousHighlight = null;
let hideTimer = null;

function ensureHoverStyle() {
  if (document.getElementById(HOVER_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HOVER_STYLE_ID;
  style.textContent = `
    .__ai_math_copy_highlight__{
      background: rgba(59,130,246,.18) !important;
      border-radius: 6px !important;
      outline: 1px solid rgba(59,130,246,.25) !important;
      outline-offset: 2px !important;
    }
  `;
  document.documentElement.appendChild(style);
}

function setHighlight(el) {
  ensureHoverStyle();
  if (previousHighlight && previousHighlight !== el) {
    previousHighlight.classList.remove("__ai_math_copy_highlight__");
  }
  el.classList.add("__ai_math_copy_highlight__");
  previousHighlight = el;
}

function clearHighlight() {
  if (previousHighlight) {
    previousHighlight.classList.remove("__ai_math_copy_highlight__");
    previousHighlight = null;
  }
}

function showButtonNear(el) {
  const btn = getOrCreateHoverButton();
  const rect = el.getBoundingClientRect();
  const x = Math.min(window.innerWidth - 60, Math.max(8, rect.right - 44));
  const y = Math.max(8, rect.top - 34);
  btn.style.left = `${x}px`;
  btn.style.top = `${y}px`;
  btn.style.display = "flex";
}

function scheduleHideButton() {
  const btn = getOrCreateHoverButton();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    btn.style.display = "none";
    currentTarget = null;
    clearHighlight();
  }, 250);
}

async function copyTargetToWord(el) {
  const found = findMathmlForTarget(el);
  if (!found?.mathml) {
    toast("该位置未找到可复制的渲染公式（目前 hover 仅支持渲染公式）。", "err");
    return;
  }
  try {
    const { mml2omml } = await ensureOmmlConverter();
    const omml = mml2omml(found.mathml);
    const html = buildWordHtmlFromOmml(omml);
    await writeClipboard(html, found.mathml);
    toast("已复制：可直接粘贴到 Word", "ok");
  } catch (e) {
    toast(`复制失败：${String(e?.message || e)}`, "err");
  }
}

function markMathTargets(root = document) {
  // 标记可 hover 的“可见公式容器”，而不是隐藏的 assistive-mml
  root.querySelectorAll?.(".katex, mjx-container, math").forEach((el) => {
    // MathJax 的 assistive 容器一般不可见，不作为 hover 目标
    if (el.tagName?.toLowerCase?.() === "mjx-assistive-mml") return;
    el.setAttribute(HOVER_ATTR, "1");
  });
}

function initHoverCopy() {
  markMathTargets(document);

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) markMathTargets(/** @type {Element} */ (n));
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  const btn = getOrCreateHoverButton();

  btn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  btn.addEventListener("mouseleave", scheduleHideButton);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentTarget) return;
    if (e.altKey) {
      const found = findMathmlForTarget(currentTarget);
      if (!found?.mathml) {
        toast("该位置未找到可复制的渲染公式。", "err");
        return;
      }
      writeClipboard(buildMathmlHtml(found.mathml), found.mathml)
        .then(() => toast("已复制 MathML（作为文本粘贴）", "ok"))
        .catch((err) => toast(`复制失败：${String(err?.message || err)}`, "err"));
      return;
    }
    copyTargetToWord(currentTarget);
  });

  document.addEventListener(
    "mouseover",
    (e) => {
      const t = /** @type {Element|null} */ (e.target instanceof Element ? e.target : null);
      if (!t) return;
      const el = t.closest?.(`[${HOVER_ATTR}="1"]`);
      if (!el) return;
      // 不要对自身按钮触发
      if (el.id === BTN_ID) return;
      currentTarget = el;
      clearTimeout(hideTimer);
      setHighlight(el);
      showButtonNear(el);
    },
    { passive: true }
  );

  document.addEventListener(
    "mouseout",
    (e) => {
      const related = /** @type {Element|null} */ (e.relatedTarget instanceof Element ? e.relatedTarget : null);
      const btnEl = getOrCreateHoverButton();
      if (related && (btnEl.contains(related) || related.closest?.(`#${BTN_ID}`))) return;
      scheduleHideButton();
    },
    { passive: true }
  );
}

// 默认开启悬浮复制
initHoverCopy();
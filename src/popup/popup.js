import { mml2omml } from "../vendor/mathml2omml.esm.js";

/**
 * popup（扩展弹窗）
 *
 * 负责：
 * - 向页面 content script 请求公式命中列表
 * - 将 LaTeX / MathML 统一转为 OMML
 * - 将 OMML 以 Word 更容易识别的 HTML 片段写入剪贴板（并提供 text/plain 兜底）
 *
 * 关键点：
 * - 剪贴板写入必须发生在“用户手势”中（点击按钮），因此在 popup 做复制最稳。
 * - 复制为 OMML（而非图片）才能确保粘贴到 Word 后公式可编辑。
 */

const elCount = document.getElementById("count");
const elStatus = document.getElementById("status");
const btnSelection = document.getElementById("btnSelection");
const btnAll = document.getElementById("btnAll");
const btnSelectionMathml = document.getElementById("btnSelectionMathml");
const btnAllMathml = document.getElementById("btnAllMathml");

function setStatus(text, type = "") {
  elStatus.textContent = text;
  elStatus.className = `status ${type}`.trim();
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("未找到当前活动标签页");
  return tab;
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com") ||
    url.startsWith("file://")
  );
}

async function ensureContentScript(tabId) {
  // 对普通网页：尝试注入一次 content script（解决“装完插件但页面没刷新”的情况）
  // 注意：受 Chrome 限制，某些页面（chrome://、webstore、pdf 等）无法注入。
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content/content.js"]
  });
}

/**
 * 从页面收集公式命中
 * @param {'selection'|'all'} mode
 * @returns {Promise<Array<{kind:'mathml'|'latex',value:string,display:boolean,source:string}>>}
 */
async function collectHits(mode) {
  const tab = await getActiveTab();
  if (isRestrictedUrl(tab.url)) {
    throw new Error("当前页面不允许注入脚本（如 chrome://、应用商店、新标签页等）。请在 AI 网页中使用本插件。");
  }

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_FORMULAS", mode });
    if (!resp?.ok) throw new Error(resp?.error || "页面公式识别失败");
    return resp.hits || [];
  } catch (e) {
    const msg = String(e?.message || e);
    // 典型报错：Could not establish connection. Receiving end does not exist.
    // 原因：content script 未运行（页面未刷新/未匹配/刚安装）
    if (msg.includes("Receiving end does not exist")) {
      await ensureContentScript(tab.id);
      const resp2 = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_FORMULAS", mode });
      if (!resp2?.ok) throw new Error(resp2?.error || "页面公式识别失败");
      return resp2.hits || [];
    }
    throw e;
  }
}

/**
 * LaTeX -> MathML
 *
 * 为什么用 KaTeX：
 * - 纯前端、性能好、可离线内置
 * - 支持输出 MathML（output: 'mathml'），便于后续转 OMML
 *
 * @param {string} latex
 * @param {boolean} displayMode
 * @returns {string} MathML（<math>...</math>）
 */
function latexToMathML(latex, displayMode) {
  if (!globalThis.katex?.renderToString) {
    throw new Error("KaTeX 未加载，无法将 LaTeX 转为 MathML");
  }
  // throwOnError=false：遇到不支持的命令时尽量输出（减少“整体失败”）
  // output='mathml'：直接得到 MathML 字符串（无需 CSS/字体）
  return globalThis.katex.renderToString(latex, {
    throwOnError: false,
    output: "mathml",
    displayMode: !!displayMode
  });
}

/**
 * 将 MathML 转为 OMML（Word 原生可编辑公式 XML）
 *
 * 依赖：mathml2omml（纯 JS，无需 XSLT）
 * - 输出通常为 <m:oMath ...>...</m:oMath>
 *
 * @param {string} mathml
 * @returns {string} omml
 */
function mathMLToOMML(mathml) {
  return mml2omml(mathml);
}

/**
 * 生成 Word 更容易识别的 HTML 片段。
 *
 * 说明：
 * - Word 对剪贴板 HTML 的解析存在一些历史兼容性问题；
 * - 实践中把 OMML 放在带 Office 命名空间的 HTML 中，成功率更高。
 * - 同时写入 text/plain（LaTeX 汇总）作为兜底，便于“粘贴仅文本”时不乱码。
 *
 * @param {string[]} ommlList
 * @returns {string} html
 */
function buildWordHtml(ommlList) {
  // 关键：mso-element:equation
  // Word 在从 HTML 剪贴板解析时，会依赖该标记把 OMML 当作“公式对象”（类似 Alt+= 插入的可编辑公式）。
  const body = ommlList
    .map((omml) => {
      return `<p class="MsoNormal" style="margin:0;line-height:1.2">
<span style="mso-element:equation;font-family:'Cambria Math','Cambria Math',serif;mso-fareast-font-family:'Cambria Math';mso-bidi-font-family:'Cambria Math'">
${omml}
</span></p>`;
    })
    .join("");

  return `<!doctype html>
<html
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:w="urn:schemas-microsoft-com:office:word"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <head>
    <meta charset="utf-8">
    <style>p.MsoNormal{margin:0;}</style>
  </head>
  <body>
    <!--StartFragment-->${body}<!--EndFragment-->
  </body>
</html>`;
}

/**
 * 写入剪贴板（HTML + 纯文本）
 * @param {string} html
 * @param {string} text
 */
async function writeClipboard(html, text) {
  if (!navigator.clipboard?.write) {
    throw new Error("当前环境不支持 navigator.clipboard.write（可能被策略限制）");
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

/**
 * 主流程：收集 -> 转换 -> 复制
 * @param {'selection'|'all'} mode
 */
async function copy(mode) {
  setStatus("正在识别公式…");
  const hits = await collectHits(mode);
  elCount.textContent = String(hits.length);
  if (hits.length === 0) {
    setStatus("未识别到公式。可尝试：选中包含公式的区域后再点“复制选中公式”。", "err");
    return;
  }

  setStatus("正在转换为 Word 可编辑公式（OMML）…");

  /** @type {string[]} */
  const ommlList = [];
  const mathmlList = [];
  /** @type {string[]} */
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
      const omml = mathMLToOMML(mathml);
      ommlList.push(omml);
      mathmlList.push(mathml);
    } catch (e) {
      failures.push({ index: i, source: h.source, error: String(e?.message || e) });
    }
  }

  if (ommlList.length === 0) {
    setStatus(`转换失败：0/${hits.length} 成功。首个错误：${failures[0]?.error || "未知"}`, "err");
    return;
  }

  const html = buildWordHtml(ommlList);
  const text = plainLatex.length ? plainLatex.join("\n") : hits.map((h) => h.value).join("\n");

  const mathmlText = mathmlList.join("\n");
  await writeClipboard(html, text);

  if (failures.length) {
    setStatus(`已复制：${ommlList.length}/${hits.length} 成功（${failures.length} 个失败，已跳过）。`, "ok");
  } else {
    setStatus(`复制成功：${ommlList.length} 个公式已写入剪贴板（可直接粘贴到 Word）。`, "ok");
  }
}

async function copyMathml(mode) {
  setStatus("正在识别公式…");
  const hits = await collectHits(mode);
  elCount.textContent = String(hits.length);
  if (hits.length === 0) {
    setStatus("未识别到公式。可尝试：选中包含公式的区域后再点“复制选中为MathML”。", "err");
    return;
  }

  const mathmlList = [];
  const failures = [];

  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    try {
      if (h.kind === "mathml") {
        mathmlList.push(h.value);
      } else {
        mathmlList.push(latexToMathML(h.value, h.display));
      }
    } catch (e) {
      failures.push(String(e?.message || e));
    }
  }

  if (mathmlList.length === 0) {
    setStatus(`转换失败：0/${hits.length} 成功。首个错误：${failures[0] || "未知"}`, "err");
    return;
  }

  const html = buildMathmlHtml(mathmlList);
  const text = mathmlList.join("\n");
  await writeClipboard(html, text);
  setStatus(
    failures.length
      ? `已复制 MathML：${mathmlList.length}/${hits.length} 成功（${failures.length} 个失败已跳过）。`
      : `复制成功：${mathmlList.length} 个公式的 MathML 已写入剪贴板。`,
    "ok"
  );
}

async function refreshCount() {
  try {
    const hits = await collectHits("all");
    elCount.textContent = String(hits.length);
  } catch {
    elCount.textContent = "-";
  }
}

btnSelection.addEventListener("click", () => {
  copy("selection").catch((e) => setStatus(`复制失败：${String(e?.message || e)}`, "err"));
});

btnAll.addEventListener("click", () => {
  copy("all").catch((e) => setStatus(`复制失败：${String(e?.message || e)}`, "err"));
});

btnSelectionMathml?.addEventListener("click", () => {
  copyMathml("selection").catch((e) => setStatus(`复制失败：${String(e?.message || e)}`, "err"));
});

btnAllMathml?.addEventListener("click", () => {
  copyMathml("all").catch((e) => setStatus(`复制失败：${String(e?.message || e)}`, "err"));
});

refreshCount();


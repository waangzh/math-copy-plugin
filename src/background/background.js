// Manifest V3 service worker.
//
// 本文件实现：
// - 右键菜单：复制选中公式 / 复制页面所有公式
// - 快捷键：复制选中 / 复制全部
// - 系统通知：复制成功/失败（可选）

const MENU_COPY_SELECTION = "copy-selection";
const MENU_COPY_ALL = "copy-all";
const MENU_COPY_SELECTION_MATHML = "copy-selection-mathml";
const MENU_COPY_ALL_MATHML = "copy-all-mathml";

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

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/P0Gq+AAAAABJRU5ErkJggg==",
      title,
      message
    });
  } catch {
    // ignore
  }
}

async function runCopy(tabId, mode, format) {
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) {
    await notify("AI公式复制到Word", "当前页面不允许注入脚本，请在普通网页（AI回答页）中使用。");
    return;
  }

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: async (mode, format) => {
        const mod = await import(chrome.runtime.getURL("src/injected/copy.js"));
        return await mod.copyFormulasToClipboard(mode, format);
      },
      args: [mode, format]
    });
    if (!result?.ok) {
      await notify("AI公式复制到Word", "复制失败：未识别到公式或转换失败。");
    } else {
      const kind = format === "mathml" ? "MathML" : "Word公式";
      await notify("AI公式复制到Word", `复制成功（${kind}）：${result.copied}/${result.total} 个公式已写入剪贴板。`);
    }
  } catch (e) {
    await notify("AI公式复制到Word", `复制失败：${String(e?.message || e)}`);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_COPY_SELECTION,
    title: "复制选中公式到Word（可编辑）",
    contexts: ["selection", "page"]
  });
  chrome.contextMenus.create({
    id: MENU_COPY_ALL,
    title: "复制页面所有公式到Word（可编辑）",
    contexts: ["page"]
  });
  chrome.contextMenus.create({
    id: MENU_COPY_SELECTION_MATHML,
    title: "复制选中公式为 MathML（文本）",
    contexts: ["selection", "page"]
  });
  chrome.contextMenus.create({
    id: MENU_COPY_ALL_MATHML,
    title: "复制页面所有公式为 MathML（文本）",
    contexts: ["page"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === MENU_COPY_SELECTION) runCopy(tab.id, "selection", "omml");
  if (info.menuItemId === MENU_COPY_ALL) runCopy(tab.id, "all", "omml");
  if (info.menuItemId === MENU_COPY_SELECTION_MATHML) runCopy(tab.id, "selection", "mathml");
  if (info.menuItemId === MENU_COPY_ALL_MATHML) runCopy(tab.id, "all", "mathml");
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab?.id) return;
  if (command === "copy-selection") runCopy(tab.id, "selection", "omml");
  if (command === "copy-all") runCopy(tab.id, "all", "omml");
  if (command === "copy-selection-mathml") runCopy(tab.id, "selection", "mathml");
  if (command === "copy-all-mathml") runCopy(tab.id, "all", "mathml");
});


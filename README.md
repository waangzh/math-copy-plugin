# AI 数学公式复制助手（Word）

一个简单的 **Chrome 插件**：自动识别网页（尤其是 AI 回答）中的数学公式，转换为 **Word 内部的可编辑数学公式（OMML）**，方便你直接粘贴到 Word 中编辑、排版。

> 当前只针对 **Microsoft Word 2016 及以上版本** 做了适配；WPS 等其他编辑器可能只会看到普通文本。

## 如何安装

1. 打开 Chrome，访问 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本项目根目录 `math-copy-plugin/`

## 如何使用

### 在网页里

- 打开包含 AI 回答（或其他数学公式）的网页
- 鼠标移动到公式上，会出现浅蓝色高亮背景和一个 **“复制”** 按钮  
  - 直接点击：复制为 **Word 可编辑公式**（推荐）
  - 按住 `Alt` 再点击：复制该公式的 **MathML 文本**

### 在 Word 里

1. 将光标放在需要插入公式的位置
2. 在网页中点击“复制”后，切回 Word
3. 使用 **普通粘贴**：`Ctrl+V`（Windows）或 `⌘+V`（macOS）  
   - 如果你在 Word 中选择“仅保留文本”，则会丢失公式对象，只保留纯文本

### 备用入口

- **右键菜单**（页面空白处或选中文本后右键）
  - 复制选中公式到 Word（OMML）
  - 复制页面所有公式到 Word（OMML）
  - 复制选中公式为 MathML（文本）
  - 复制页面所有公式为 MathML（文本）
- **快捷键**（可在 `chrome://extensions/shortcuts` 中修改）
  - 复制选中公式到 Word：Windows `Ctrl+Shift+M` / macOS `⌘+Shift+M`
  - 复制页面所有公式到 Word：Windows `Ctrl+Shift+Y` / macOS `⌘+Shift+Y`
  - 复制选中公式为 MathML：Windows `Ctrl+Shift+K` / macOS `⌘+Shift+K`
  - 复制页面所有公式为 MathML：Windows `Ctrl+Shift+U` / macOS `⌘+Shift+U`



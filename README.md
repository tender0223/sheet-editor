# 表格编辑器

一款仿 WPS 风格的 Windows 单文件表格编辑器，使用 Python、pywebview 和原生 HTML/CSS/JavaScript 开发。无需安装 Office，可编辑 Excel（`.xlsx`）和网页（`.html`）表格。

## 下载

- [Release v1.2.1](https://github.com/tender0223/sheet-editor/releases/tag/v1.2.1)
- [直接下载 Win7 全版本成品](https://github.com/tender0223/sheet-editor/releases/download/v1.2.1/SheetEditor-1.2.1-Win7-All-FormulaPlus.exe)
- [查看更新说明](https://github.com/tender0223/sheet-editor/releases/download/v1.2.1/READMD.txt)

成品支持 Windows 7 SP1 至 Windows 11，内置 WebView2 109 固定版本运行时，文件约 124MB。

SHA256：

```text
cb0a9cfe5f7301f7de068a1ba9b05c9d5b03aff75916cd1e43ea46a4e0285aba
```

## 主要功能

- 打开、编辑、保存和导出 `.xlsx`、`.html` 表格。
- 支持多文件标签页、搜索、排序、批量编辑、删除重复行、撤销重做和最近打开记录。
- 支持 `SUM`、`AVERAGE`、`IF`、`VLOOKUP`、`COUNTIF` 等 40 多个常用函数，以及单元格和区域引用。
- 选中公式单元格时自动高亮公式引用的单元格或区域。
- 输入函数名后按 Tab 补全，自动添加英文右括号并将光标置于括号内。
- 将公式批量填充到整列或选中行，相对引用随位置变化，绝对引用保持不变。
- 新增数据行可自动套用整列公式。
- 支持多列叠加筛选、关键字搜索和一次清除全部筛选。
- 支持冻结首行、首列或同时冻结首行和首列。
- 支持快速算术，例如输入 `1×2=` 后按回车得到 `2`。
- 默认模板支持启动自动打开、新建自动套用；模板以独立副本打开，不覆盖源文件。
- 保存前自动备份，支持深色主题和自定义主题。
- 单实例运行，第二次双击文件时转交给已有窗口。
- 可建立或取消 `.xlsx`、`.html`、`.htm` 文件关联。

## 运行要求

### 使用成品

- Windows 7 SP1、Windows 8.1、Windows 10 或 Windows 11。
- Windows 7 需要 .NET Framework 4.6.2。
- Windows 7 首次启动会准备约 314MB 的 WebView2 运行时缓存，请耐心等待。
- Windows 10/11 优先使用系统已安装的 WebView2 运行时。

### 从源码运行

需要 Windows、Python 3.8 或更高版本以及可用的 WebView2 运行时。

```bat
python -m pip install pywebview==5.4 pythonnet==3.0.3 openpyxl==3.1.2
python app.py
```

开发调试时可以启用页面调试接口：

```bat
python app.py --dev
```

需要隔离浏览器配置并开启 CDP 调试端口时：

```bat
python app.py --debug --dev
```

## 项目结构

```text
.
├── app.py                      窗口、本地服务、单实例、文件关联和运行时管理
├── sheetio.py                  Excel/HTML 读取、保存、导出和备份
├── static/
│   ├── index.html              界面结构
│   ├── app.js                  编辑、筛选、冻结、模板和保存流程
│   ├── formula.js              公式解析、计算和引用换算
│   ├── style.css               界面样式
│   └── favicon.svg
├── tools/
│   ├── version_info.txt        Windows 版本信息
│   ├── appicon.ico             程序图标
│   └── testenv/                公式单测和 CDP 界面测试脚本
├── docs/                       开发记录
├── 表格编辑器.spec              Win10+ 轻量版构建配置
├── 表格编辑器-win7.spec         Win7 全版本主程序构建配置
├── dist/READMD.txt             成品更新说明
├── LICENSE                     CC0 1.0 Universal
└── README.md
```

## 构建

项目使用 PyInstaller 5.13.2 打包。Win10+ 轻量版可使用 Python 3.11：

```bat
set PYTHONNOUSERSITE=1
python -m pip install pywebview==5.4 pythonnet==3.0.3 openpyxl==3.1.2 pyinstaller==5.13.2
pyinstaller 表格编辑器.spec
```

Win7 全版本主程序建议使用 32 位 Python 3.8.10：

```bat
set PYTHONNOUSERSITE=1
python -m pip install pywebview==5.4 pythonnet==3.0.3 openpyxl==3.1.2 pyinstaller==5.13.2
pyinstaller 表格编辑器-win7.spec
```

`PYTHONNOUSERSITE=1` 用于避免构建机用户级 64 位 Python 包污染 32 位构建环境。

PyInstaller 生成的是主程序。Win7 全版本还需要将 WebView2 109.0.1518.140 固定版本运行时压缩包追加到主程序末尾，并写入 24 字节 `SEWVBND1` 尾针。完整发布版可直接从本仓库 Release 下载，无需自行处理运行时合并步骤。

## 测试

公式引擎和引用换算测试只需要 Node.js：

```bat
node tools/testenv/formula_test.js
node tools/testenv/remap_test.js
```

界面回归使用 Puppeteer Core 和 Chrome DevTools Protocol，需要 Windows、WebView2 以及 Node.js 22 或更高版本：

```bat
npm ci --prefix tools/testenv
python app.py --debug --dev
node tools/testenv/cdp_release.js
```

部分界面和关闭回归依赖本机测试样本与打包环境，测试数据未随仓库分发。`cdp_release.js` 中的模板样本路径可通过环境变量 `SHEET_EDITOR_SOURCE_TEST` 指定；运行前请按脚本断言准备样本，并确保 `tools/testenv/tmpfiles` 和 `tools/testenv/shots` 目录存在。

1.2.1 验收记录：

- 公式引擎：91 项通过。
- 引用重映射：15 项通过。
- 成品界面回归：49 项通过。
- 关闭流程回归：4 项通过。
- 指定 Excel 样本通过打开、编辑、模板副本、源文件不变和导出验收。

## 数据与隐私

- 表格数据仅保存在本机，不上传到服务器。
- 应用只启动监听 `127.0.0.1` 的本地服务，并使用随机令牌保护接口。
- 设置、历史、备份、日志和 WebView2 缓存保存在 `%LOCALAPPDATA%\表格编辑器`。
- 仓库不包含用户表格、账号密码、运行日志、浏览器缓存和测试截图。

## 已知限制

- 当前主要面向日常单表编辑，`.xlsx` 默认读取第一张工作表。
- 多工作表、复杂样式、特殊数据类型和数组公式不保证完整保留。
- HTML 按表格数据导入和导出，导出 HTML 时公式写入计算结果。
- Windows 10/11 的默认应用选择受系统保护，首次关联可能需要在系统设置中手动确认。
- 移动或重命名成品后，需要重新建立文件关联。

## 二次创作与许可

本项目原创源代码依据 [CC0 1.0 Universal](LICENSE) 贡献至公共领域。你可以自由下载、使用、修改、合并、发布、分发和二次创作，包括商业用途，无需署名，也没有附加许可条件。

CC0 不提供任何担保，也不转让商标权或专利权。第三方依赖、开发工具、WebView2 运行时和发布成品中附带的其他组件仍遵循各自许可，不因本项目的 CC0 声明而改变。

## 技术栈

- Python 3.8/3.11
- pywebview 5.4
- WebView2 109
- openpyxl 3.1.2
- PyInstaller 5.13.2
- 原生 HTML/CSS/JavaScript
- Node.js 与 Chrome DevTools Protocol（测试）

更多开发背景和兼容性处理细节见 [开发记录](docs/表格编辑器开发记录.md)。

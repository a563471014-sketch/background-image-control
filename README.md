# Background Image Control

为 VS Code 界面设置背景图的 VS Code 扩展（带 3 步引导）。

- 3 步引导：选图 → 调界面不透明度 → 应用
- 支持「界面相对背景的透明度」：整个界面统一半透明（含标题栏与窗口按钮），背景图静默透出
- 本地图片 / 网络图片（自动缓存），支持 GIF 动图
- 状态栏快捷菜单 + 快捷键 `Ctrl+Alt+I`
- **调节即时生效**：首次应用后，改透明度 / 换图 / 移除均无需重载窗口
- 自动修复 VS Code 升级后失效；可一键彻底还原系统文件

## 效果预览（界面不透明度 60% · 主题 GitHub Dark · 蓝色壁纸）

![效果预览](https://raw.githubusercontent.com/a563471014-sketch/background-image-control/master/extension/preview.png)

## 安装

**A. VS Code 扩展（.vsix）**

```
code --install-extension background-image-control-<ver>.vsix
```

→ Reload Window → 按 `Ctrl+Alt+I` 打开引导。

**B. 从源码构建**

```
build.cmd        # 打包 extension/ -> dist/*.vsix 并自动安装
```

## 使用说明

功能特性、菜单、设置项与工作原理详见 [extension/README.md](extension/README.md)。

## 源码结构

```
extension/        # VS Code 扩展（package.json / extension.js / patcher.js / style.js / README / icon / preview）
vsix/             # vsix 打包模板（extension.vsixmanifest / [Content_Types].xml）
build.cmd         # 打包 -> 自动安装
dist/             # 打包产物（.vsix，不入库）
```

- `patcher.js`：注入 / 还原 `workbench.html` 与校验和修复（随附 PowerShell 脚本，无权限时自动走 UAC）
- `style.js`：生成注入 CSS、图片下载与缓存

版本升级：同步修改 `extension/package.json` 的 `version`、`vsix/extension.vsixmanifest` 的 `Version` 和 `build.cmd` 的 `VER`。

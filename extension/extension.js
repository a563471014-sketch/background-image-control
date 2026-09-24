// extension.js —— 入口：状态栏 / 菜单 / 3 步引导 / 配置监听 / 启动检查
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const patcher = require('./patcher');
const style = require('./style');

const CONFIG = 'backgroundImage';
const CMD = 'backgroundImage.';
const RELOAD = '立即重载窗口';
const IS_WIN = process.platform === 'win32';

let ctx, statusBar, output, busy = false;
let cfgTimer, lastReloadPrompt = 0;
let lastImageUrl;

const cfg = () => vscode.workspace.getConfiguration(CONFIG);
const log = msg => { if (output) output.appendLine('[' + new Date().toLocaleTimeString() + '] ' + msg); };
const storageRoot = () => ctx.globalStorageUri.fsPath;
// 样式表必须位于 vscode-file 协议白名单目录（安装目录 / 扩展根目录）下才能被加载。
// 扩展根目录 = 本扩展安装目录的父级（自适应自定义扩展目录）；该目录用户可写，改配置无需管理员权限。
const assetsDir = () => path.join(path.dirname(ctx.extensionUri.fsPath), 'background-image-control-assets');
const cssFile = () => path.join(assetsDir(), 'bg.css');
const scriptsDir = () => path.join(storageRoot(), 'scripts');
const cssHref = () => style.vscodeFileUrlOf(cssFile());
const injectFile = () => path.join(assetsDir(), 'bg-inject.js');
const injectHref = () => style.vscodeFileUrlOf(injectFile());
const locateApp = () => patcher.locate(vscode.env.appRoot);
const sameHref = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const patchActive = st => !!(st && st.injected && st.hasScript && sameHref(st.cssHref, cssHref()));

// 把页面实时注入器（inject.js）复制到资产目录（内容变化时自动更新）
function ensureInjector() {
    try {
        const want = fs.readFileSync(path.join(ctx.extensionUri.fsPath, 'inject.js'), 'utf8');
        let have = '';
        try { have = fs.readFileSync(injectFile(), 'utf8'); } catch { /* ignore */ }
        if (have !== want) {
            fs.writeFileSync(injectFile(), want, 'utf8');
            log('injector updated');
        }
    } catch (e) {
        log('injector: ' + e.message);
    }
}

// ---------- 公共 ----------

function refreshStatus() {
    const src = cfg().get('imagePath');
    if (!src) {
        statusBar.text = '$(file-media) 背景图: 未设置';
    } else {
        const loc = locateApp();
        const st = loc ? patcher.readState(loc) : undefined;
        const active = patchActive(st);
        statusBar.text = active
            ? `$(file-media) 背景图: ${cfg().get('uiOpacity')}%`
            : '$(file-media) 背景图: 待应用';
    }
    // tooltip 会渲染进状态栏项的 aria-label —— 页面注入器（bg-inject.js）借此实时获取配置
    let payload;
    if (!src) {
        payload = '{"e":0}';
    } else if (lastImageUrl) {
        const st2 = style.IMAGE_STYLES[cfg().get('imageStyle', 'cover')] || style.IMAGE_STYLES.cover;
        const bl = Number(cfg().get('blur', 0)) || 0;
        payload = JSON.stringify({
            e: 1,
            o: Number(cfg().get('uiOpacity', 85)),
            i: lastImageUrl,
            io: Number(cfg().get('imageOpacity', 100)),
            b: bl,
            inset: bl > 0 ? -Math.ceil(bl * 3) : 0,
            s: st2
        });
    }
    statusBar.tooltip = '点击打开背景图菜单' + (payload ? ' | bgc:' + payload : '');
    statusBar.show();
}

async function promptReload(message) {
    // 短时间内的多次提示只弹一次（设置连续调整 / 引导流程内部更新）
    const now = Date.now();
    if (now - lastReloadPrompt < 3000) return;
    lastReloadPrompt = now;
    const pick = await vscode.window.showInformationMessage(message, RELOAD, '稍后');
    if (pick === RELOAD) vscode.commands.executeCommand('workbench.action.reloadWindow');
}

// 依当前配置生成 CSS（会解析/下载图片）
async function writeCssForCurrentConfig() {
    fs.mkdirSync(assetsDir(), { recursive: true });
    ensureInjector();
    const src = cfg().get('imagePath');
    if (!src) {
        fs.writeFileSync(cssFile(), style.emptyCss(), 'utf8');
        lastImageUrl = undefined;
        return undefined;
    }
    const imageUrl = await style.resolveImageUrl(storageRoot(), src, log);
    lastImageUrl = imageUrl;
    const css = style.buildCss({
        imageUrl,
        uiOpacity: cfg().get('uiOpacity', 85),
        imageOpacity: cfg().get('imageOpacity', 100),
        imageStyle: cfg().get('imageStyle', 'cover'),
        blur: cfg().get('blur', 0)
    });
    fs.writeFileSync(cssFile(), css, 'utf8');
    return imageUrl;
}

// 配置变化（含扩展自身写入）后的统一刷新
function scheduleConfigRefresh() {
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(async () => {
        try {
            await writeCssForCurrentConfig();
        } catch (e) {
            vscode.window.showWarningMessage('背景图更新失败：' + e.message);
        }
        // 配置变化会经状态栏 tooltip 实时广播给页面注入器（bg-inject.js）—— 无需重载窗口
        refreshStatus();
    }, 400);
}

// ---------- 窗口按钮样式（让右上角最小化/最大化/关闭跟随界面一起透明） ----------
// VS Code 1.13x 默认用原生覆盖层（WCO）绘制窗口按钮：其颜色由代码另行计算，不受页面 CSS 与透明度影响。
// 切换 window.controlsStyle 为 "custom" 后按钮变为 VS Code 自绘的 DOM 元素，即随全局透明度一起透出背景。
// 代价：失去 Win11 悬停“贴靠布局”菜单。移除背景图/彻底还原时会自动恢复原值。
const CONTROLS_PREV = 'prevControlsStyle';
async function ensureControlsStyle() {
    const winCfg = vscode.workspace.getConfiguration('window');
    const cur = winCfg.get('controlsStyle');
    if (cur === 'custom') return;
    if (ctx.globalState.get(CONTROLS_PREV) === undefined) {
        await ctx.globalState.update(CONTROLS_PREV, cur === undefined ? null : cur);
    }
    await winCfg.update('controlsStyle', 'custom', vscode.ConfigurationTarget.Global);
    log('controlsStyle: ' + cur + ' -> custom');
}
async function restoreControlsStyle() {
    const prev = ctx.globalState.get(CONTROLS_PREV);
    if (prev === undefined) return; // 未由本扩展设置过，不动它
    const winCfg = vscode.workspace.getConfiguration('window');
    await winCfg.update('controlsStyle', prev === null ? undefined : prev, vscode.ConfigurationTarget.Global);
    await ctx.globalState.update(CONTROLS_PREV, undefined);
    log('controlsStyle restored -> ' + prev);
}

// ---------- 应用 / 移除 / 还原 ----------

async function applyFlow() {
    if (!IS_WIN) {
        vscode.window.showErrorMessage('本扩展目前仅支持 Windows 平台。');
        return;
    }
    const src = cfg().get('imagePath');
    if (!src) {
        const pick = await vscode.window.showWarningMessage('尚未选择背景图。', '开始设置');
        if (pick) await setupFlow();
        return;
    }
    if (busy) {
        vscode.window.showInformationMessage('背景图：正在处理上一步操作，请稍候…');
        return;
    }
    busy = true;
    try {
        let applied = false;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '背景图：正在应用…' }, async progress => {
            progress.report({ message: '准备图片…' });
            try {
                await writeCssForCurrentConfig();
            } catch (e) {
                vscode.window.showErrorMessage('背景图处理失败：' + e.message);
                return;
            }
            const loc = locateApp();
            if (!loc) {
                vscode.window.showErrorMessage('未能识别当前 VS Code 的安装结构，无法应用背景图。');
                return;
            }
            progress.report({ message: '正在修改界面文件…（若弹出管理员权限请求请选择「是」）' });
            const r = await patcher.apply(loc, cssHref(), injectHref(), scriptsDir(), log);
            if (r.ok) {
                applied = true;
                log('apply ok, elevated=' + !!r.elevated);
                await ctx.globalState.update('patchNoticeShown', false);
            } else if (r.canceled) {
                vscode.window.showWarningMessage('已取消管理员授权，背景图未应用。可再次运行重试。');
            } else if (r.needElevation) {
                vscode.window.showWarningMessage('修改 VS Code 界面文件需要管理员权限，请在菜单中再次应用并同意授权。');
            } else {
                vscode.window.showErrorMessage('背景图应用失败：' + r.message);
            }
        });
        if (applied) {
            try { await ensureControlsStyle(); } catch (e) { log('controlsStyle: ' + e.message); }
            promptReload('背景图已应用。首次需重载窗口生效；之后改透明度 / 换图 / 移除均即时生效。');
        }
    } finally {
        busy = false;
        refreshStatus();
    }
}

async function removeFlow() {
    if (!cfg().get('imagePath')) {
        vscode.window.showInformationMessage('当前没有设置背景图。');
        return;
    }
    await cfg().update('imagePath', '', vscode.ConfigurationTarget.Global);
    try { await restoreControlsStyle(); } catch (e) { log('controlsStyle: ' + e.message); }
    refreshStatus();
    vscode.window.showInformationMessage('已移除背景图（即时生效，无需重载）。\n如需彻底还原系统文件（卸载扩展前），请运行命令「背景图：彻底还原系统文件」。');
}

async function uninstallFlow() {
    if (!IS_WIN) {
        vscode.window.showErrorMessage('本扩展目前仅支持 Windows 平台。');
        return;
    }
    const loc = locateApp();
    if (!loc) {
        vscode.window.showErrorMessage('未能识别当前 VS Code 的安装结构。');
        return;
    }
    const st = patcher.readState(loc);
    if (!st.injected) {
        vscode.window.showInformationMessage('VS Code 界面文件已是初始状态，无需还原。');
        return;
    }
    if (busy) {
        vscode.window.showInformationMessage('背景图：正在处理上一步操作，请稍候…');
        return;
    }
    const pick = await vscode.window.showWarningMessage('将还原 VS Code 界面文件（移除注入的样式链接），过程中可能需要管理员权限。确定继续？', { modal: true }, '还原');
    if (pick !== '还原') return;
    busy = true;
    try {
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '背景图：正在还原界面文件…' },
            () => patcher.remove(loc, scriptsDir(), log));
        if (r.ok) {
            await cfg().update('imagePath', '', vscode.ConfigurationTarget.Global);
            try { await restoreControlsStyle(); } catch (e) { log('controlsStyle: ' + e.message); }
            try { fs.writeFileSync(cssFile(), style.emptyCss(), 'utf8'); } catch { /* ignore */ }
            try { fs.rmSync(assetsDir(), { recursive: true, force: true }); } catch { /* ignore */ }
            promptReload('已还原 VS Code 界面文件，重载窗口后恢复默认界面。');
        } else if (r.canceled) {
            vscode.window.showWarningMessage('已取消管理员授权，未做任何修改。');
        } else if (r.needElevation) {
            vscode.window.showWarningMessage('还原 VS Code 界面文件需要管理员权限，请再次运行并同意授权。');
        } else {
            vscode.window.showErrorMessage('还原失败：' + r.message);
        }
    } finally {
        busy = false;
        refreshStatus();
    }
}

// ---------- 3 步引导 ----------

async function setupFlow() {
    const cur = cfg().get('imagePath');

    // 1/3 选择图片
    const sourceItems = [
        { label: '$(file-media) 选择本地图片…', value: 'file' },
        { label: '$(globe) 输入图片网址…', value: 'url' }
    ];
    if (cur) sourceItems.push({ label: '$(trash) 清除背景图', value: 'clear' });
    const sourcePick = await vscode.window.showQuickPick(sourceItems, {
        title: '背景图设置（1/3）：选择图片',
        placeHolder: cur ? '当前：' + cur : '选择一张图片作为界面背景'
    });
    if (!sourcePick) return;
    if (sourcePick.value === 'clear') { await removeFlow(); return; }

    let source = cur;
    if (sourcePick.value === 'file') {
        const uris = await vscode.window.showOpenDialog({
            title: '选择背景图片', openLabel: '使用此图片', canSelectMany: false,
            filters: { '图片': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] }
        });
        if (!uris || !uris.length) return;
        source = uris[0].fsPath;
    } else {
        const v = await vscode.window.showInputBox({
            title: '背景图设置（1/3）：图片网址',
            prompt: '输入图片的 http/https 网址（会自动下载到本地缓存）',
            value: cur && style.isUrl(cur) ? cur : 'https://',
            validateInput: s => {
                if (!s || !s.trim()) return '请输入网址';
                return /^https?:\/\/.+/i.test(s.trim()) ? undefined : '请输入以 http:// 或 https:// 开头的网址';
            }
        });
        if (!v) return;
        source = v.trim();
    }
    await cfg().update('imagePath', source, vscode.ConfigurationTarget.Global);

    // 2/3 界面不透明度
    const curOp = Number(cfg().get('uiOpacity', 85));
    const presets = [
        [100, '完全不透明，看不到背景图'],
        [90, '轻微透出'],
        [85, '推荐：整体轻微透出，文字清晰'],
        [75, '明显透出'],
        [60, '背景图较清晰'],
        [45, '背景图清晰，文字仍可读'],
        [30, '背景图很清晰（文字可读性下降）']
    ];
    const opItems = presets.map(([v, d]) => ({
        label: `${v}%${v === curOp ? '（当前）' : ''}`,
        description: d,
        value: v
    }));
    opItems.push({ label: '$(edit) 自定义数值…', value: 'custom' });
    const opPick = await vscode.window.showQuickPick(opItems, {
        title: '背景图设置（2/3）：界面不透明度',
        placeHolder: '数值越低，背景图越清晰（面板越透明）；之后也可在状态栏菜单调整'
    });
    if (!opPick) return;
    let opacity = opPick.value;
    if (opacity === 'custom') {
        const s = await vscode.window.showInputBox({
            title: '界面不透明度',
            prompt: '输入 20 ~ 100 的数值（100 = 界面完全不透明，看不到背景图）',
            value: String(curOp),
            validateInput: s => {
                const n = Number(s);
                return Number.isFinite(n) && n >= 20 && n <= 100 ? undefined : '请输入 20 ~ 100 的数字';
            }
        });
        if (s === undefined) return;
        opacity = Number(s);
    }
    await cfg().update('uiOpacity', opacity, vscode.ConfigurationTarget.Global);

    // 3/3 应用
    await applyFlow();
}

// ---------- 状态栏菜单 ----------

async function showMenu() {
    const src = cfg().get('imagePath');
    const op = cfg().get('uiOpacity');
    const loc = locateApp();
    const st = loc ? patcher.readState(loc) : undefined;
    const active = patchActive(st);

    const items = [];
    items.push({ label: src ? '$(wand) 背景图设置（引导）…' : '$(file-media) 选择背景图（3 步引导）…', action: 'setup' });
    if (src) {
        items.push({ label: `$(arrow-up) 提高界面不透明度（当前 ${op}%，更清晰）`, action: 'up' });
        items.push({ label: `$(arrow-down) 降低界面不透明度（当前 ${op}%，背景图更清晰）`, action: 'down' });
        items.push({ label: '$(edit) 输入界面不透明度…', action: 'setop' });
        items.push({ label: active ? '$(refresh) 重新应用（修复升级后失效）' : '$(play) 应用背景图', action: 'apply' });
        items.push({ label: '$(circle-slash) 移除背景图（可随时重设）', action: 'remove' });
        if (st && st.injected) {
            items.push({ label: '$(trash) 彻底还原系统文件（卸载扩展前使用）', action: 'uninstall' });
        }
    }
    items.push({ label: '$(settings-gear) 打开设置', action: 'settings' });

    const pick = await vscode.window.showQuickPick(items, {
        title: '背景图',
        placeHolder: active ? `已启用 · 界面不透明度 ${op}%` : (src ? '当前未应用（点击「应用背景图」）' : '未设置背景图')
    });
    if (!pick) return;
    switch (pick.action) {
        case 'setup': return setupFlow();
        case 'up': return nudgeOpacity(5);
        case 'down': return nudgeOpacity(-5);
        case 'setop': return setOpacityInteractive();
        case 'apply': return applyFlow();
        case 'remove': return removeFlow();
        case 'uninstall': return uninstallFlow();
        case 'settings': return vscode.commands.executeCommand('workbench.action.openSettings', CONFIG);
    }
}

async function nudgeOpacity(delta) {
    const cur = Number(cfg().get('uiOpacity', 85)) || 0;
    const v = Math.max(0, Math.min(100, cur + delta));
    if (v === cur) {
        vscode.window.showInformationMessage(`界面不透明度已是 ${v}%。`);
        return;
    }
    await cfg().update('uiOpacity', v, vscode.ConfigurationTarget.Global);
}

async function setOpacityInteractive() {
    const cur = Number(cfg().get('uiOpacity', 85));
    const s = await vscode.window.showInputBox({
        title: '界面不透明度',
        prompt: '输入 20 ~ 100 的数值（100 = 界面完全不透明，看不到背景图）',
        value: String(cur),
        validateInput: v => {
            const n = Number(v);
            return Number.isFinite(n) && n >= 20 && n <= 100 ? undefined : '请输入 20 ~ 100 的数字';
        }
    });
    if (s === undefined) return;
    await cfg().update('uiOpacity', Number(s), vscode.ConfigurationTarget.Global);
}

// ---------- 启动检查 ----------

async function startupChecks() {
    if (!IS_WIN) return;
    try { fs.mkdirSync(storageRoot(), { recursive: true }); fs.mkdirSync(assetsDir(), { recursive: true }); } catch { /* ignore */ }

    const src = cfg().get('imagePath');
    if (!src) {
        refreshStatus();
        if (!ctx.globalState.get('welcomeShown')) {
            await ctx.globalState.update('welcomeShown', true);
            const pick = await vscode.window.showInformationMessage('要给 VS Code 界面换一张背景图吗？3 步引导即可完成。', '开始设置', '以后再说');
            if (pick === '开始设置') await setupFlow();
        }
        return;
    }

    // 已有配置：刷新 CSS 并检查注入状态
    try {
        await writeCssForCurrentConfig();
    } catch (e) {
        refreshStatus();
        const pick = await vscode.window.showWarningMessage('背景图不可用：' + e.message, '重新设置');
        if (pick) await setupFlow();
        return;
    }
    const loc = locateApp();
    if (!loc) { refreshStatus(); return; }
    const st = patcher.readState(loc);
    if (!st.injected || !st.hasScript || !sameHref(st.cssHref, cssHref())) {
        // 延迟自动恢复（10 秒；实测启动完整性校验在 +4~6.5s 内完成，10s 有 2 倍以上裕量），
        // 详见 autoRepair 注释：避免与校验交错导致误报“{安装} 似乎损坏”
        setTimeout(() => { autoRepair(loc).catch(e => log('auto repair: ' + (e && e.message || e))); }, 10000);
    } else {
        // 已生效：确保窗口按钮样式也已切换（如从旧版本升级后自动补齐）
        try { await ensureControlsStyle(); } catch (e) { log('controlsStyle: ' + e.message); }
    }
    refreshStatus();
}

// 延迟自动恢复：在窗口启动约 10 秒后（VS Code 的安装完整性校验已跑完）再执行写入。
// 原因：workbench 的 IntegrityService 启动时会拿 product.json 的 checksums（启动快照）
// 与磁盘文件逐个对比；若我们在快照生成后、校验执行前就改写了 workbench.html，
// 校验会误判“安装似乎损坏”（弹窗 + 建议重装）。推迟到校验之后写入即可彻底避免。
async function autoRepair(loc) {
    const st = patcher.readState(loc);
    if (patchActive(st)) {
        try { await ensureControlsStyle(); } catch (e) { log('controlsStyle: ' + e.message); }
        return;
    }
    const r = await patcher.apply(loc, cssHref(), injectHref(), scriptsDir(), log, { allowElevation: false });
    if (r.ok) {
        log('auto repair ok (deferred)');
        try { await ensureControlsStyle(); } catch (e) { log('controlsStyle: ' + e.message); }
        promptReload('背景图已自动恢复（检测到 VS Code 界面文件变化）。重载窗口后生效。');
    } else if (r.needElevation && !ctx.globalState.get('patchNoticeShown')) {
        await ctx.globalState.update('patchNoticeShown', true);
        const pick = await vscode.window.showInformationMessage('背景图需要重新应用（需要管理员权限）。', '重新应用');
        if (pick) await applyFlow();
    } else {
        log('patch check(deferred): ' + JSON.stringify(r));
    }
}

// ---------- 激活 ----------

function activate(context) {
    ctx = context;
    output = vscode.window.createOutputChannel('Background Image Control');
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    statusBar.command = CMD + 'showMenu';

    context.subscriptions.push(output, statusBar);
    context.subscriptions.push(
        vscode.commands.registerCommand(CMD + 'showMenu', showMenu),
        vscode.commands.registerCommand(CMD + 'setup', setupFlow),
        vscode.commands.registerCommand(CMD + 'apply', applyFlow),
        vscode.commands.registerCommand(CMD + 'remove', removeFlow),
        vscode.commands.registerCommand(CMD + 'uninstall', uninstallFlow),
        vscode.commands.registerCommand(CMD + 'increaseOpacity', () => nudgeOpacity(5)),
        vscode.commands.registerCommand(CMD + 'decreaseOpacity', () => nudgeOpacity(-5)),
        vscode.commands.registerCommand(CMD + 'setOpacity', setOpacityInteractive),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(CONFIG)) scheduleConfigRefresh();
        })
    );

    refreshStatus();
    setTimeout(() => {
        startupChecks().catch(err => log('startup error: ' + (err && err.stack || err)));
    }, 1500);
}

function deactivate() { /* 无需处理：背景保持，用户可随时用命令移除或还原 */ }

exports.activate = activate;
exports.deactivate = deactivate;

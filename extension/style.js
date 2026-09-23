// style.js —— 生成注入用的 CSS（引用扩展资产目录下的 bg.css），并负责背景图片的解析（本地直引 / 网络图下载缓存）。
// 顶层不依赖 vscode，可用纯 node 测试。
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));

// vscode-file URL —— 与 VS Code 工作台页面同源（vscode-file://vscode-app）。
// 实测该协议的目录白名单：样式表仅放行"安装目录 / 扩展根目录"下的文件；图片则任意路径均可加载。
function vscodeFileUrlOf(p) {
    const fwd = String(p).replace(/\\/g, '/');
    const u = 'vscode-file://vscode-app/' + encodeURI(fwd).replace(/#/g, '%23').replace(/\?/g, '%3F');
    // 盘符统一大写，避免 c:/C: 两种写法导致注入与校验不一致
    return u.replace(/^vscode-file:\/\/vscode-app\/([a-z]):/i, (m, d) => 'vscode-file://vscode-app/' + d.toUpperCase() + ':');
}

// 说明（v1.2.0 起）：界面透明度改用"整层 opacity"方案——只对 .monaco-workbench 一层设置
// opacity，所有面板/浮层/菜单统一透出背景（与窗口透明度扩展同思路）；
// 不再逐个面板指定选择器，VS Code 升级新增/改名容器类时也不会失效。

const IMAGE_STYLES = {
    cover: ['cover', 'center', 'no-repeat'],
    contain: ['contain', 'center', 'no-repeat'],
    tile: ['auto', 'left top', 'repeat'],
    center: ['auto', 'center', 'no-repeat']
};

// 生成完整 CSS。参数：
//  imageUrl     图片 URL（vscode-file:）
//  uiOpacity    界面整体不透明度 0-100（作用于整个工作台，所有面板/浮层统一生效）
//  imageOpacity 图片本身的不透明度 0-100
//  imageStyle   cover | contain | tile | center
//  blur         图片模糊像素 0-40
function buildCss({ imageUrl, uiOpacity, imageOpacity, imageStyle, blur }) {
    // 下限 20%：全局透明方案下过低会让整个界面难以操作（保留恢复余地）
    const alpha = Math.max(clamp(uiOpacity, 0, 100), 20);
    const imgAlpha = clamp(imageOpacity, 0, 100);
    const bl = clamp(blur, 0, 40);
    const [size, pos, repeat] = IMAGE_STYLES[imageStyle] || IMAGE_STYLES.cover;
    const L = [];

    L.push('/* background-image-control — 自动生成，请勿手工修改（在扩展设置/菜单中调整即可） */');
    L.push('');
    L.push('/* 背景图层 */');
    L.push('body::before {');
    L.push("  content: '' !important;");
    L.push('  position: fixed !important;');
    // 模糊会带来半透明边缘，放大一点避免露边
    L.push(bl > 0 ? `  inset: -${Math.ceil(bl * 3)}px !important;` : '  inset: 0 !important;');
    L.push('  pointer-events: none !important;');
    L.push(`  background-image: url("${imageUrl}") !important;`);
    L.push(`  background-size: ${size} !important;`);
    L.push(`  background-position: ${pos} !important;`);
    L.push(`  background-repeat: ${repeat} !important;`);
    if (imgAlpha < 100) L.push(`  opacity: ${(imgAlpha / 100).toFixed(3)} !important;`);
    if (bl > 0) L.push(`  filter: blur(${bl}px) !important;`);
    L.push('  z-index: 0 !important;');
    L.push('}');

    L.push('');
    L.push(`/* 界面整体不透明度 ${alpha}%：一整层作用于所有面板/浮层/菜单（与窗口透明度同思路，不再逐面板选择器） */`);
    L.push(`:root body .monaco-workbench { opacity: ${(alpha / 100).toFixed(3)} !important; }`);

    return L.join('\r\n') + '\r\n';
}

// 停用时的空样式
function emptyCss() {
    return '/* background-image-control - disabled */\r\n';
}

function isUrl(source) {
    return /^https?:\/\//i.test(source);
}

// 下载图片到缓存文件（支持重定向，最多 5 跳）
function downloadFile(url, dest, redirects) {
    return new Promise((resolve, reject) => {
        const mod = /^https:/i.test(url) ? https : http;
        const req = mod.get(url, {
            timeout: 60000,
            headers: { 'User-Agent': 'Mozilla/5.0 (background-image-control extension)' }
        }, res => {
            const code = res.statusCode || 0;
            if (code >= 300 && code < 400 && res.headers.location) {
                res.resume();
                if ((redirects || 0) <= 0) { reject(new Error('跳转次数过多')); return; }
                const next = new URL(res.headers.location, url).href;
                resolve(downloadFile(next, dest, (redirects || 0) - 1));
                return;
            }
            if (code !== 200) { res.resume(); reject(new Error('HTTP ' + code)); return; }
            const f = fs.createWriteStream(dest);
            f.on('error', err => reject(err));
            res.pipe(f);
            f.on('finish', () => f.close(() => resolve()));
        });
        req.on('error', err => reject(err));
        req.on('timeout', () => req.destroy(new Error('下载超时')));
    });
}

// 按文件头判断图片扩展名
function sniffExt(file) {
    try {
        const b = fs.readFileSync(file);
        if (b.length >= 12) {
            if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return '.png';
            if (b[0] === 0xFF && b[1] === 0xD8) return '.jpg';
            if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif';
            if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
            if (b[0] === 0x42 && b[1] === 0x4D) return '.bmp';
            if (b.toString('ascii', 4, 8) === 'ftyp') return '.avif';
        }
    } catch { /* ignore */ }
    return '.png';
}

const CACHE_IMG_RE = /^bg-image\.(png|jpg|gif|webp|bmp|avif)$/;

function clearOldCache(imagesDir, keepFile) {
    try {
        for (const f of fs.readdirSync(imagesDir)) {
            const full = path.join(imagesDir, f);
            if ((CACHE_IMG_RE.test(f) || f.endsWith('.download')) && full !== keepFile) {
                fs.unlinkSync(full);
            }
        }
    } catch { /* ignore */ }
}

// 解析图片源为可在 CSS 中引用的 URL：
//  - 本地路径：直接引用（file:// URL）
//  - http(s)：下载到 globalStorage/images 缓存后引用（离线可用，且绕开 http 协议限制）
async function resolveImageUrl(storageDir, source, log) {
    const imagesDir = path.join(storageDir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });

    if (isUrl(source)) {
        const metaFile = path.join(imagesDir, 'image.source');
        // 缓存命中条件：来源 URL 未变 且 缓存图片存在
        let cachedFile;
        try {
            if (fs.readFileSync(metaFile, 'utf8').trim() === source) {
                const files = fs.readdirSync(imagesDir).filter(f => CACHE_IMG_RE.test(f));
                if (files.length === 1) cachedFile = path.join(imagesDir, files[0]);
            }
        } catch { /* ignore */ }
        if (cachedFile) {
            if (log) log('use cached image: ' + cachedFile);
            return vscodeFileUrlOf(cachedFile);
        }

        clearOldCache(imagesDir, undefined);
        const tmp = path.join(imagesDir, 'bg-image.download');
        if (log) log('download image: ' + source);
        await downloadFile(source, tmp, 5);
        const ext = sniffExt(tmp);
        const finalFile = path.join(imagesDir, 'bg-image' + ext);
        fs.renameSync(tmp, finalFile);
        fs.writeFileSync(metaFile, source, 'utf8');
        if (log) log('downloaded to: ' + finalFile);
        return vscodeFileUrlOf(finalFile);
    }

    // 本地图片：直接引用原文件（vscode-file 协议对图片不限目录，无需拷贝）
    if (!fs.existsSync(source)) throw new Error('图片不存在：' + source);
    const stat = fs.statSync(source);
    if (!stat.isFile()) throw new Error('不是有效的图片文件：' + source);
    clearOldCache(imagesDir, undefined);
    return vscodeFileUrlOf(source);
}

// 供设置保存等场景使用：判断本地源是否仍然可用
function localSourceMissing(source) {
    return !isUrl(source) && !fs.existsSync(source);
}

module.exports = { buildCss, emptyCss, resolveImageUrl, localSourceMissing, isUrl, vscodeFileUrlOf, IMAGE_STYLES };

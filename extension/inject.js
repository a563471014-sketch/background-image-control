// background-image-control — 页面实时注入器（bg-inject.js）
// 由扩展写入资产目录，并通过 workbench.html 中的 <script src="vscode-file://...bg-inject.js" defer> 加载。
// 工作原理：扩展把当前配置（透明度 / 图片 URL / 模糊…）实时写入状态栏项的 tooltip（渲染后成为该元素的
// aria-label）。本脚本用 MutationObserver 监听该元素的 DOM 变化，把数据写进 CSS 变量（--bgc-*），
// 由注入的样式表消费——从而实现"改透明度 / 换图 / 移除"全部无需重载窗口。
// 注意：不能访问任何扩展 API / 文件系统，只依赖 DOM 与 CSS 变量。
(function () {
    'use strict';
    if (window.__bgcLive) { return; }
    window.__bgcLive = true;

    var root = document.documentElement;
    var lastPayload = '';

    function setVar(name, value) {
        if (value === undefined || value === null || value === '') { return; }
        if (root.style.getPropertyValue(name) !== value) {
            root.style.setProperty(name, value);
        }
    }

    function findItem() {
        var bar = document.querySelector('.statusbar');
        if (!bar) { return null; }
        var items = bar.querySelectorAll('a, .statusbar-item-label');
        for (var i = 0; i < items.length; i++) {
            var el = items[i];
            var aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
            if (aria.indexOf('bgc:') >= 0) { return el; }
        }
        for (var j = 0; j < items.length; j++) {
            var el2 = items[j];
            var t = el2.textContent || '';
            var a2 = (el2.getAttribute && el2.getAttribute('aria-label')) || '';
            if (t.indexOf('背景图') >= 0 || a2.indexOf('背景图') >= 0) { return el2; }
        }
        return null;
    }

    function apply() {
        var item = findItem();
        if (!item) { return false; }
        var aria = (item.getAttribute('aria-label') || '');
        var text = item.textContent || '';
        var idx = aria.indexOf('bgc:');
        if (idx >= 0) {
            var payload = aria.slice(idx + 4);
            var end = payload.indexOf(' | ');
            if (end >= 0) { payload = payload.slice(0, end); }
            payload = payload.trim();
            if (payload !== lastPayload) {
                var d = null;
                try { d = JSON.parse(payload); } catch (e) { d = null; }
                if (d) {
                    lastPayload = payload;
                    if (d.e === 0) {
                        setVar('--bgc-image', 'none');
                        setVar('--bgc-ui-opacity', '1');
                        setVar('--bgc-image-opacity', '1');
                        setVar('--bgc-filter', 'none');
                        setVar('--bgc-inset', '0px');
                    } else {
                        if (d.i) { setVar('--bgc-image', 'url("' + d.i + '")'); }
                        if (d.o !== undefined) { setVar('--bgc-ui-opacity', String(Math.max(Number(d.o), 20) / 100)); }
                        if (d.io !== undefined) { setVar('--bgc-image-opacity', String(Number(d.io) / 100)); }
                        if (d.b !== undefined) { setVar('--bgc-filter', Number(d.b) > 0 ? 'blur(' + Number(d.b) + 'px)' : 'none'); }
                        if (d.inset !== undefined) { setVar('--bgc-inset', Number(d.inset) + 'px'); }
                        if (d.s && d.s.length === 3) {
                            setVar('--bgc-size', String(d.s[0]));
                            setVar('--bgc-position', String(d.s[1]));
                            setVar('--bgc-repeat', String(d.s[2]));
                        }
                    }
                }
            }
            return true;
        }
        // 回退通道：只从文本解析百分比（不带 payload 的旧状态）
        var m = /背景图[：:]\s*(\d+)\s*%/.exec(text);
        if (m) { setVar('--bgc-ui-opacity', String(Math.max(parseInt(m[1], 10), 20) / 100)); }
        return true;
    }

    var observed = null;
    function attach() {
        var item = findItem();
        if (!item || observed === item) { return; }
        if (observed && observed.__bgcMo) { try { observed.__bgcMo.disconnect(); } catch (e) { } }
        observed = item;
        try {
            var mo = new MutationObserver(function () { apply(); });
            mo.observe(item, { attributes: true, childList: true, characterData: true, subtree: true });
            item.__bgcMo = mo;
        } catch (e) { /* ignore */ }
        apply();
    }

    // 低频兜底（状态项重建 / 观察断链等场景 1 秒内也会跟上）
    setInterval(function () { apply(); attach(); }, 1000);
})();

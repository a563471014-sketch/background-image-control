// patcher.js —— 负责把背景样式 <link> 注入 VS Code 的 workbench.html，并同步修复 product.json 校验和。
// 注入的 href 为 vscode-file URL，指向扩展资产目录下的 bg.css
// （实测 vscode-file 协议仅放行安装目录/扩展根目录下的样式表；图片则任意路径可加载）。
// 不依赖 vscode 模块（顶层不 require），可用纯 node 直接测试。
// Windows 平台；注入动作由随附的 PowerShell 脚本执行（直写失败时自动走 UAC 提权）。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const MARKER = 'background-image-control';

// workbench.html 相对于 app 根目录（vscode.env.appRoot）的候选路径，新布局在前
const HTML_REL = [
    'out/vs/code/electron-browser/workbench/workbench.html',   // VS Code 1.13x+ 新布局
    'out/vs/code/electron-sandbox/workbench/workbench.html'    // 旧布局
];

// 定位当前运行版本对应的 workbench.html / product.json
function locate(appRoot) {
    for (const rel of HTML_REL) {
        const htmlPath = path.join(appRoot, rel.replace(/\//g, path.sep));
        if (fs.existsSync(htmlPath)) {
            return { htmlPath, htmlRel: rel, productPath: path.join(appRoot, 'product.json') };
        }
    }
    return undefined;
}

// product.json 中校验和条目的键，如 vs/code/electron-browser/workbench/workbench.html
function checksumKey(htmlRel) {
    return htmlRel.replace(/^out\//, '');
}

// 读取注入状态：{ supported, injected, cssHref, hasScript }
function readState(loc) {
    try {
        const text = fs.readFileSync(loc.htmlPath, 'utf8');
        const m = text.match(new RegExp(`<!-- ${MARKER}:start -->([\\s\\S]*?)<!-- ${MARKER}:end -->`));
        if (!m) return { supported: true, injected: false };
        const href = m[1].match(/<link[^>]+href="([^"]+)"/);
        const hasScript = /bg-inject\.js/i.test(m[1]);
        return { supported: true, injected: true, cssHref: href ? href[1] : undefined, hasScript };
    } catch (e) {
        return { supported: false, injected: false, error: e.message };
    }
}

// ---------- PowerShell 脚本（扩展目录下 scripts/） ----------
// apply.ps1：注入 / 移除样式块，并更新 product.json 校验和；无写权限时以退出码 2 请求提权。
// elevate.ps1：通过 UAC 以管理员身份重新执行 apply.ps1（用户取消退出码 3）。
// 两个脚本均为纯 ASCII，UTF-8 无 BOM 写出。

const APPLY_PS1 = `param(
  [string]$Mode = 'apply',
  [Parameter(Mandatory=$true)][string]$Html,
  [string]$Prod,
  [string]$Key,
  [string]$CssHref,
  [string]$InjectHref
)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$Marker = 'background-image-control'

function Read-Text([string]$p) {
  $bytes = [IO.File]::ReadAllBytes($p)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  if ($hasBom) { $text = $text.Substring(1) }
  return @{ Text = $text; Bom = $hasBom }
}

function Write-Text([string]$p, [string]$text, [bool]$bom) {
  [IO.File]::WriteAllText($p, $text, [Text.UTF8Encoding]::new($bom))
}

if (-not (Test-Path -LiteralPath $Html)) { Write-Output "ERROR: html not found: $Html"; exit 1 }

# writable probe
try {
  $probe = Join-Path (Split-Path -Parent $Html) ('.bgimg-wtest-' + $PID + '.tmp')
  $s = [IO.File]::Create($probe); $s.Close(); Remove-Item -LiteralPath $probe -Force
} catch {
  Write-Output 'NEED-ELEVATION'
  exit 2
}

# backup original file before first modification
$bak = $Html + '.bak-bgimage'

$r = Read-Text $Html
$text = $r.Text
$re = '(?s)<!-- ' + $Marker + ':start -->.*?<!-- ' + $Marker + ':end -->\r?\n'
$stripped = [Regex]::Replace($text, $re, '')
# strip old experiment leftover: <script src="./bg-inject.js"></script> and delete that file
$stripped = [Regex]::Replace($stripped, '(?m)^[ \\t]*<script src="[.]/bg-inject[.]js"></script>[ \\t]*\\r?\\n', '')
$oldInject = Join-Path (Split-Path -Parent $Html) 'bg-inject.js'
if (Test-Path -LiteralPath $oldInject) { Remove-Item -LiteralPath $oldInject -Force -ErrorAction SilentlyContinue }

# create backup once: always the un-injected version
if (-not (Test-Path -LiteralPath $bak)) {
  Write-Text $bak $stripped $r.Bom
  Write-Output 'backup created'
}

$out = $stripped
$changed = $false

if ($Mode -eq 'apply') {
  if (-not $CssHref) { Write-Output 'ERROR: CssHref required for apply'; exit 1 }
  $block = '<!-- ' + $Marker + ':start -->' + "\`r\`n" + '<link rel="stylesheet" href="' + $CssHref + '">' + "\`r\`n"
  if ($InjectHref) { $block += '<script src="' + $InjectHref + '" defer></script>' + "\`r\`n" }
  $block += '<!-- ' + $Marker + ':end -->' + "\`r\`n"
  $i = $out.IndexOf('</head>')
  if ($i -lt 0) { $i = $out.IndexOf('</html>') }
  if ($i -lt 0) { Write-Output 'ERROR: no </head> or </html> found'; exit 1 }
  $out = $out.Insert($i, $block)
} elseif ($Mode -ne 'remove') {
  Write-Output "ERROR: unknown mode $Mode"
  exit 1
}

# only write back when content actually changed (idempotent apply / no-op remove)
# note: -cne (case sensitive), href case differences must be written back
$changed = $out -cne $text

if ($changed) {
  Write-Text $Html $out $r.Bom
  Write-Output "html updated ($Mode)"
} else {
  Write-Output "html unchanged ($Mode)"
}

# update product.json checksum (avoid the 'installation corrupt' warning on startup)
if ($Prod -and $Key -and (Test-Path -LiteralPath $Prod)) {
  $pr = Read-Text $Prod
  $bytes = [IO.File]::ReadAllBytes($Html)
  $sha = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  $new = [Convert]::ToBase64String($sha).TrimEnd('=')
  $pattern = '("' + [Regex]::Escape($Key) + '"\\s*:\\s*")[^"]*'
  if (-not [Regex]::IsMatch($pr.Text, $pattern)) {
    Write-Output "WARN: checksum key not found in product.json: $Key"
  } else {
    $p2 = [Regex]::Replace($pr.Text, $pattern, ('\${1}' + $new))
    if ($p2 -cne $pr.Text) {
      Write-Text $Prod $p2 $pr.Bom
      Write-Output 'checksum updated'
    } else {
      Write-Output 'checksum unchanged'
    }
  }
}

Write-Output 'OK'
exit 0
`;

const ELEVATE_PS1 = `param(
  [Parameter(Mandatory=$true)][string]$Script,
  [string]$Mode = 'apply',
  [Parameter(Mandatory=$true)][string]$Html,
  [string]$Prod,
  [string]$Key,
  [string]$CssHref,
  [string]$InjectHref
)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $Script + '" -Mode ' + $Mode + ' -Html "' + $Html + '"'
if ($Prod)    { $argLine += ' -Prod "' + $Prod + '"' }
if ($Key)     { $argLine += ' -Key "' + $Key + '"' }
if ($CssHref) { $argLine += ' -CssHref "' + $CssHref + '"' }
if ($InjectHref) { $argLine += ' -InjectHref "' + $InjectHref + '"' }
try {
  $p = Start-Process -FilePath 'powershell' -ArgumentList $argLine -Verb RunAs -Wait -PassThru
  exit $p.ExitCode
} catch {
  Write-Output ('ELEVATION-CANCELED: ' + $_.Exception.Message)
  exit 3
}
`;

function ensureScripts(scriptsDir) {
    fs.mkdirSync(scriptsDir, { recursive: true });
    // BOM + ASCII-only content: keep PowerShell 5.1 parsing reliable
    fs.writeFileSync(path.join(scriptsDir, 'apply.ps1'), '\ufeff' + APPLY_PS1, 'utf8');
    fs.writeFileSync(path.join(scriptsDir, 'elevate.ps1'), '\ufeff' + ELEVATE_PS1, 'utf8');
}

function powershell(args) {
    return new Promise((resolve) => {
        cp.execFile('powershell', args, { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                let code = 0;
                if (err) code = typeof err.code === 'number' ? err.code : (err.killed || err.signal ? 124 : 1);
                resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
            });
    });
}

// 执行一次 apply / remove；直写失败（无管理员权限）时可选是否走 UAC 提权
async function run(scriptsDir, mode, args, log, options) {
    const allowElevation = !options || options.allowElevation !== false;
    ensureScripts(scriptsDir);
    const base = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(scriptsDir, 'apply.ps1'),
        '-Mode', mode,
        '-Html', args.html,
        '-Prod', args.prod || '',
        '-Key', args.key || ''
    ];
    if (args.cssHref) base.push('-CssHref', args.cssHref);
    if (args.injectHref) base.push('-InjectHref', args.injectHref);

    if (log) log(`run apply.ps1 ${mode}`);
    let r = await powershell(base);
    if (r.code === 0) return { ok: true, elevated: false, output: r.stdout };
    if (r.code === 2) {
        if (!allowElevation) return { ok: false, needElevation: true, message: '需要管理员权限' };
        if (log) log('need elevation, launching UAC');
        const elevArgs = [
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', path.join(scriptsDir, 'elevate.ps1'),
            '-Script', path.join(scriptsDir, 'apply.ps1'),
            '-Mode', mode,
            '-Html', args.html
        ];
        if (args.prod) elevArgs.push('-Prod', args.prod);
        if (args.key) elevArgs.push('-Key', args.key);
        if (args.cssHref) elevArgs.push('-CssHref', args.cssHref);
        if (args.injectHref) elevArgs.push('-InjectHref', args.injectHref);
        const e = await powershell(elevArgs);
        if (e.code === 0) return { ok: true, elevated: true, output: e.stdout };
        if (e.code === 3) return { ok: false, canceled: true, message: '已取消管理员授权' };
        return { ok: false, message: (e.stdout + e.stderr).trim() || ('exit code ' + e.code) };
    }
    return { ok: false, message: (r.stdout + r.stderr).trim() || ('exit code ' + r.code) };
}

function apply(loc, cssHref, injectHref, scriptsDir, log, options) {
    return run(scriptsDir, 'apply', {
        html: loc.htmlPath,
        prod: loc.productPath,
        key: checksumKey(loc.htmlRel),
        cssHref,
        injectHref
    }, log, options);
}

function remove(loc, scriptsDir, log, options) {
    return run(scriptsDir, 'remove', {
        html: loc.htmlPath,
        prod: loc.productPath,
        key: checksumKey(loc.htmlRel)
    }, log, options);
}

module.exports = { MARKER, locate, checksumKey, readState, apply, remove };

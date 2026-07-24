# build-msix.ps1 — 使用 Windows SDK makeappx.exe 打包 MSIX（微软商城上架用）
# 用法: .\build-msix.ps1 [-Target x86_64-pc-windows-msvc] [-Version 0.1.0.0] [-Sign]
#
# 前置条件:
#   - 已执行 `pnpm tauri build --target <target>` 生成 release 产物
#   - Windows SDK 已安装（GitHub Actions windows-latest 预装）
#
# 产物: src-tauri/target/windows-store/SnapCraft_<version>_x64.msix

param(
    [string]$Target = "x86_64-pc-windows-msvc",
    [string]$Version = "",
    [switch]$Sign
)

$ErrorActionPreference = "Stop"

# ── 路径 ──
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$srcTauri = Join-Path $repoRoot "src-tauri"
$releaseDir = Join-Path $srcTauri "target\$Target\release"
$storeDir = Join-Path $srcTauri "windows-store"
$outDir = Join-Path $srcTauri "target\windows-store"
$stageDir = Join-Path $outDir "staging"

Write-Host "=== SnapCraft MSIX Builder (makeappx) ==="
Write-Host "  Repo root:  $repoRoot"
Write-Host "  Release dir: $releaseDir"
Write-Host "  Output dir: $outDir"

# ── 版本号（4 段式，Store 要求） ──
if (-not $Version) {
    # 从 tauri.conf.json 读取版本并补第四段
    $conf = Get-Content (Join-Path $srcTauri "tauri.conf.json") -Raw | ConvertFrom-Json
    $v = $conf.version
    if ($v -match '^\d+\.\d+\.\d+$') { $Version = "$v.0" }
    elseif ($v -match '^\d+\.\d+\.\d+\.\d+$') { $Version = $v }
    else { $Version = "0.1.0.0" }
}
Write-Host "  Version: $Version"

# ── 定位 makeappx.exe ──
$sdkBinRoot = "C:\Program Files (x86)\Windows Kits\10\bin"
$makeappx = $null
if (Test-Path $sdkBinRoot) {
    # 取最新版本目录
    $makeappx = Get-ChildItem -Path $sdkBinRoot -Recurse -Filter "makeappx.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "x64" } |
        Sort-Object { $_.DirectoryName } -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $makeappx) {
    # 回退：PATH 中查找
    $makeappx = (Get-Command makeappx.exe -ErrorAction SilentlyContinue).Source
}
if (-not $makeappx) {
    Write-Error "makeappx.exe not found. Ensure Windows 10 SDK is installed."
    exit 1
}
Write-Host "  makeappx: $makeappx"

# ── 定位 SignTool（可选签名） ──
$signtool = $null
if ($Sign) {
    if (Test-Path $sdkBinRoot) {
        $signtool = Get-ChildItem -Path $sdkBinRoot -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match "x64" } |
            Sort-Object { $_.DirectoryName } -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $signtool) { $signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source }
    if (-not $signtool) {
        Write-Warning "signtool.exe not found — skipping signing."
        $Sign = $false
    }
}

# ── 清理 & 创建 staging 目录 ──
if (Test-Path $stageDir) { Remove-Item -Recurse -Force $stageDir }
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
$assetsDir = Join-Path $stageDir "Assets"
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

# ── 拷贝主程序 + DLL ──
$exe = Join-Path $releaseDir "snap-craft.exe"
if (-not (Test-Path $exe)) {
    Write-Error "snap-craft.exe not found at $exe. Run 'pnpm tauri build' first."
    exit 1
}
Copy-Item $exe (Join-Path $stageDir "snap-craft.exe")
Write-Host "  Copied: snap-craft.exe"

# 拷贝所有 DLL（WebView2 loader 等）
$dlls = Get-ChildItem -Path $releaseDir -Filter "*.dll" -ErrorAction SilentlyContinue
foreach ($dll in $dlls) {
    Copy-Item $dll.FullName (Join-Path $stageDir $dll.Name)
    Write-Host "  Copied DLL: $($dll.Name)"
}

# 拷贝 resources 目录（lproj 等，如果存在）
$resourcesDir = Join-Path $releaseDir "resources"
if (Test-Path $resourcesDir) {
    Copy-Item -Recurse $resourcesDir (Join-Path $stageDir "resources")
    Write-Host "  Copied: resources/"
}

# ── 拷贝 Store 图标资源 ──
$iconsDir = Join-Path $srcTauri "icons"
$storeAssets = @(
    "Square44x44Logo.png",
    "Square71x71Logo.png",
    "Square150x150Logo.png",
    "Square310x310Logo.png",
    "StoreLogo.png"
)
foreach ($asset in $storeAssets) {
    $src = Join-Path $iconsDir $asset
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $assetsDir $asset)
        Write-Host "  Asset: $asset"
    } else {
        Write-Warning "  Missing asset: $asset (Store may reject)"
    }
}

# ── 生成 AppxManifest.xml（替换版本号） ──
$manifestTemplate = Get-Content (Join-Path $storeDir "AppxManifest.xml") -Raw
# 用 -creplace（区分大小写）：只替换 Identity 的大写 Version，
# 不动 XML 声明的小写 version（否则 makeappx 报 "Incorrect xml declaration syntax"）
$manifest = $manifestTemplate -creplace 'Version="[^"]*"', "Version=`"$Version`""
$manifestPath = Join-Path $stageDir "AppxManifest.xml"
# 必须写无 BOM 的 UTF-8，否则 makeappx 同样报 XML 解析错误
[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))
Write-Host "  Generated: AppxManifest.xml (Version=$Version)"

# ── 打包 MSIX ──
$arch = if ($Target -match "aarch64") { "arm64" } else { "x64" }
$msixName = "SnapCraft_${Version}_${arch}.msix"
$msixPath = Join-Path $outDir $msixName

Write-Host ""
Write-Host "=== Packing MSIX ==="
& $makeappx pack /d $stageDir /p $msixPath /o
if ($LASTEXITCODE -ne 0) {
    Write-Error "makeappx pack failed with exit code $LASTEXITCODE"
    exit 1
}
Write-Host "  Created: $msixPath"

# ── 可选：自签名（sideload 测试用；Store 提交不需要） ──
if ($Sign -and $signtool) {
    $certPath = $env:MSIX_CERTIFICATE_PATH
    $certPwd = $env:MSIX_CERTIFICATE_PASSWORD
    if ($certPath -and (Test-Path $certPath)) {
        Write-Host "=== Signing MSIX (sideload) ==="
        & $signtool sign /fd sha256 /f $certPath /p $certPwd $msixPath
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Signing failed — MSIX is still valid for Store submission (unsigned)."
        } else {
            Write-Host "  Signed: $msixPath"
        }
    } else {
        Write-Host "  No certificate provided — MSIX left unsigned (OK for Store submission)."
    }
}

# ── 输出摘要 ──
$fileSize = (Get-Item $msixPath).Length / 1MB
Write-Host ""
Write-Host "=== Done ==="
Write-Host "  MSIX: $msixPath ($([math]::Round($fileSize, 2)) MB)"
Write-Host "  For Microsoft Store: upload this file via Partner Center (Store will re-sign)."
Write-Host "  For sideload: enable Developer Mode, then 'Add-AppxPackage -Path $msixPath'"

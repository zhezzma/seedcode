# 设置控制台编码为 UTF-8 以支持 emoji
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# 获取项目根目录 (脚本所在位置的父级)
$projectRoot = Split-Path -Parent $PSScriptRoot

# 0. 从 .env 加载环境变量
$envFile = "$projectRoot\.env"
if (Test-Path $envFile) {
    Write-Host "正在加载 .env 文件..."
    Get-Content $envFile | ForEach-Object {
        if ($_ -match "^\s*([^#=]+)\s*=\s*(.*)$") {
            [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
        }
    }
}

# 配置信息
$keystore = "$projectRoot\release.keystore"
$alias = "seedcode"

# 签名口令必须显式提供：默认口令回退等价于公开签名私钥，
# 且 Android 签名密钥不可轮换（代码审核 #3）
$keystorePass = $env:ANDROID_KEYSTORE_PASS
if ([string]::IsNullOrWhiteSpace($keystorePass)) {
    Write-Error "ANDROID_KEYSTORE_PASS not set - refusing to sign with a fallback password"
    exit 1
}

$keyPass = $env:ANDROID_KEY_PASS
if ([string]::IsNullOrWhiteSpace($keyPass)) {
    # 未单独提供时沿用 keystore 口令（同一口令是常见做法，但必须显式给出第一个）
    $keyPass = $keystorePass
}

# 设置 Gradle 所需的环境变量 (供 build.gradle.kts 使用)
[Environment]::SetEnvironmentVariable("ANDROID_KEYSTORE_PATH", $keystore, "Process")
[Environment]::SetEnvironmentVariable("ANDROID_KEYSTORE_PASSWORD", $keystorePass, "Process")
[Environment]::SetEnvironmentVariable("ANDROID_KEY_ALIAS", $alias, "Process")
[Environment]::SetEnvironmentVariable("ANDROID_KEY_PASSWORD", $keyPass, "Process")

Write-Host "ANDROID_KEYSTORE_PATH: $env:ANDROID_KEYSTORE_PATH"

# 设置 Android SDK 路径 (硬编码以避免重装系统后需要重新配置环境变量)
# 若已设置系统环境变量 ANDROID_HOME 则优先使用它，否则回退到下方固定路径
$androidSdk = $env:ANDROID_HOME
if ([string]::IsNullOrWhiteSpace($androidSdk)) { $androidSdk = "D:\Install\Android\Sdk" }
if (-not (Test-Path $androidSdk)) {
    Write-Host "`n❌ Android SDK 未找到：$androidSdk" -ForegroundColor Red
    Write-Host "   请确认 SDK 安装位置，或设置 ANDROID_HOME 环境变量。" -ForegroundColor Red
    Pause
    exit
}
[Environment]::SetEnvironmentVariable("ANDROID_HOME", $androidSdk, "Process")
[Environment]::SetEnvironmentVariable("ANDROID_SDK_ROOT", $androidSdk, "Process")
Write-Host "ANDROID_HOME: $androidSdk"

# 检查符号链接权限 (Tauri 在 jniLibs 目录创建软链接需要；开发者模式开启 或 管理员权限 均可)
$devModeKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock"
$devMode = (Get-ItemProperty -Path $devModeKey -Name "AllowDevelopmentWithoutDevLicense" -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($devMode -ne 1 -and -not $isAdmin) {
    Write-Host "`n❌ 当前无法创建符号链接，Android 构建将会失败！" -ForegroundColor Red
    Write-Host "   Tauri 需要在 jniLibs 目录创建符号链接，Windows 默认禁止，请满足以下任一条件：`n" -ForegroundColor Yellow
    Write-Host "   方式一：开启开发者模式（推荐，一次性设置，之后普通权限即可构建）" -ForegroundColor Cyan
    Write-Host "     · 图形界面：设置 → 系统 → 开发者选项 → 开启「开发人员模式」"
    Write-Host "     · 命令行（在管理员 PowerShell 中运行一次）：" -ForegroundColor DarkGray
    Write-Host "       New-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' -Name 'AllowDevelopmentWithoutDevLicense' -Value 1 -PropertyType DWord -Force`n" -ForegroundColor DarkGray
    Write-Host "   方式二：以管理员身份运行本脚本`n" -ForegroundColor Cyan
    Pause
    exit
}
Write-Host "✅ 符号链接权限检查通过 ($(if ($devMode -eq 1) { '开发者模式已开启' } else { '当前为管理员权限' }))" -ForegroundColor Green

# ==============================================================================
# [Windows 环境构建说明]
# 本地构建 Android 版本时，由于使用了 `openssl` (vendored)，需要编译 C 源码。
# Windows 默认环境缺失 Unix 编译工具 (perl, make)，必须通过 MSYS2 提供。
# 如果你在新环境部署，请确保：
# 1. 安装 MSYS2: scoop install msys2
# 2. 安装编译工具: 进入 msys2 目录或使用 bash 调用 pacman -S --noconfirm perl make
# (macOS/Linux 无需此步骤，系统自带工具即可)
# ==============================================================================

# OpenSSL (Android) 构建需要产生 Unix 路径的 Perl (MSYS2/Cygwin)，Strawberry Perl (Windows) 会导致路径错误。
# 检测并使用 Scoop 安装的 MSYS2 环境
$msys2Bin = "D:\Applications\Scoop\apps\msys2\current\usr\bin"
if (Test-Path "$msys2Bin\perl.exe") {
    Write-Host "`n⚠️  检测到 MSYS2 环境 (Perl/Unix工具链)，正在优先添加到 PATH 以支持 OpenSSL 交叉编译: $msys2Bin" -ForegroundColor Yellow
    # 将 MSYS2 bin 放在最前面以覆盖可能的 Windows Perl
    $env:PATH = "$msys2Bin;$env:PATH"
}

# 自动检测 NDK 并强制设置 CC/AR/RANLIB 为 Unix 风格路径 (解决 OpenSSL makefile 中反斜杠路径失效问题)
$ndkRoot = "$androidSdk\ndk"
if (Test-Path $ndkRoot) {
    # 获取最新的 NDK 版本
    $ndkVer = Get-ChildItem $ndkRoot | Sort-Object Name | Select-Object -Last 1 -ExpandProperty Name
    $toolchainBin = "$ndkRoot\$ndkVer\toolchains\llvm\prebuilt\windows-x86_64\bin"
    
    if (Test-Path $toolchainBin) {
        # 转换为 Unix 路径 (Forward Slashes)
        $toolchainBinUnix = $toolchainBin -replace '\\', '/'
        
        # 直接使用 clang.exe (Unix Style Path)，因为 Cargo (cc-rs) 需要 Win32 可执行文件，而 Make 需要 Unix 路径。
        # OpenSSL Configure 会自动添加 --target 参数，所以不需要 NDK wrapper 脚本。
        $clangExe = "$toolchainBinUnix/clang.exe"
        $ar = "$toolchainBinUnix/llvm-ar.exe"
        $ranlib = "$toolchainBinUnix/llvm-ranlib.exe"

        Write-Host "`n⚠️  OpenSSL Cross-Compile Config: 强制设置 NDK 编译器路径 (Unix Style)..." -ForegroundColor Yellow
        Write-Host "   CC: $clangExe"
        $env:CC_aarch64_linux_android = $clangExe
        $env:AR_aarch64_linux_android = $ar
        $env:RANLIB_aarch64_linux_android = $ranlib
        
        # 设置 Cargo 惯用的环境变量
        $env:CC_aarch64_linux_android = $clangExe
        $env:AR_aarch64_linux_android = $ar
    }
}

# 确保 Gradle 全局镜像配置存在 (阿里云, 解决国内访问 Maven Central / Google 的 TLS 握手失败)
# 重装系统后 ~/.gradle 会丢失, 此处自动重建, 无需手动配置
$initGradleDir = "$env:USERPROFILE\.gradle\init.d"
$initGradleFile = "$initGradleDir\init.gradle"
if (-not (Test-Path $initGradleFile)) {
    Write-Host "`n📦 配置 Gradle 全局镜像 (阿里云) 以加速国内依赖下载..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $initGradleDir -Force | Out-Null
    $initContent = @'
// 全局 Gradle 镜像 (阿里云) - 由 build_android.ps1 自动生成
// 解决国内访问 Maven Central / Google / Gradle Plugin Portal 的 TLS 握手失败
// 移除所有国外源并注入阿里云镜像, 对所有 Gradle 项目(含 buildSrc / buildscript)生效

def aliyunRepos = [
    'public'        : 'https://maven.aliyun.com/repository/public',
    'google'        : 'https://maven.aliyun.com/repository/google',
    'gradle-plugin' : 'https://maven.aliyun.com/repository/gradle-plugin',
    'central'       : 'https://maven.aliyun.com/repository/central',
]

def blocked = [
    'repo.maven.apache.org/maven2',
    'repo1.maven.org/maven2',
    'dl.google.com/dl/android/maven2',
    'plugins.gradle.org/m2',
    'jcenter.bintray.com',
]

allprojects {
    buildscript {
        repositories {
            all { ArtifactRepository repo ->
                if (repo instanceof MavenArtifactRepository) {
                    def url = repo.url.toString()
                    if (blocked.any { url.contains(it) }) { remove repo }
                }
            }
            maven { url aliyunRepos['gradle-plugin'] }
            maven { url aliyunRepos['google'] }
            maven { url aliyunRepos['public'] }
        }
    }
    repositories {
        all { ArtifactRepository repo ->
            if (repo instanceof MavenArtifactRepository) {
                def url = repo.url.toString()
                if (blocked.any { url.contains(it) }) { remove repo }
            }
        }
        maven { url aliyunRepos['google'] }
        maven { url aliyunRepos['public'] }
        maven { url aliyunRepos['central'] }
        maven { url aliyunRepos['gradle-plugin'] }
    }
}

settingsEvaluated { settings ->
    ['pluginManagement', 'dependencyResolutionManagement'].each { blockName ->
        def block = settings."$blockName"
        if (block?.hasProperty('repositories')) {
            block.repositories {
                all { ArtifactRepository repo ->
                    if (repo instanceof MavenArtifactRepository) {
                        def url = repo.url.toString()
                        if (blocked.any { url.contains(it) }) { remove repo }
                    }
                }
                maven { url aliyunRepos['google'] }
                maven { url aliyunRepos['public'] }
                maven { url aliyunRepos['gradle-plugin'] }
            }
        }
    }
}
'@
    [System.IO.File]::WriteAllText($initGradleFile, $initContent, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "   已创建：$initGradleFile" -ForegroundColor Green
} else {
    Write-Host "✅ Gradle 全局镜像已配置：$initGradleFile" -ForegroundColor DarkGray
}

# 1. 构建 Release APK (此时可能已由 Gradle 签名，也可能未签名)
# Android 版不含内置服务端：内置服务端的 resources 只在
# tauri.bundled.conf.json / tauri.server.conf.json overlay 中，基础配置不含
# resources，因此 package-desktop.ps1 的 Windows 装配残留不会被打进 APK
Write-Host "`n🚀 正在构建 Release APK..."
cd $projectRoot
npx tauri android build --target aarch64

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n❌ 构建失败！" -ForegroundColor Red
    Pause
    exit
}

# 2. 定位构建产物
$apkDir = "$projectRoot\src-tauri\gen\android\app\build\outputs\apk\universal\release"
$gradleSignedApk = "$apkDir\app-universal-release.apk"
$unsignedApk = "$apkDir\app-universal-release-unsigned.apk"
$signedApk = "$apkDir\app-release-signed.apk"

# 检查 Gradle 是否已经生成了已签名的 APK (通过环境变量注入)
if (Test-Path $gradleSignedApk) {
    Write-Host "`n✅ 发现 Gradle 已签名的 APK：$gradleSignedApk" -ForegroundColor Green
    Copy-Item $gradleSignedApk $signedApk -Force
    Write-Host "   已复制到：$signedApk"

    # 归档到根目录 dist-android（.gitignore 已忽略）：固定出口，免每次翻 gen 目录找包
    $distDir = "$projectRoot\dist-android"
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
    Copy-Item $signedApk "$distDir\app-release-signed.apk" -Force
    Write-Host "   已归档到：$distDir\app-release-signed.apk"

    Write-Host "`n✅ 成功！已签名 APK 准备就绪 (跳过手动签名)。" -ForegroundColor Green
    explorer $distDir
    # 【重点】如果已经有签名包了，直接退出！不再执行后续的手动签名步骤
    exit 
}

# 如果没找到签名包，检查是否有未签名包 (准备进行手动签名)
if (-not (Test-Path $unsignedApk)) {
    Write-Host "`n❌ 未找到 APK 文件 (已检查已签名和未签名版本)：" -ForegroundColor Red
    Write-Host "   已签名版本：   $gradleSignedApk"
    Write-Host "   未签名版本： $unsignedApk"
    Pause
    exit
}

# 3. 如果密钥库不存在则生成 (仅针对手动签名流程)
if (-not (Test-Path $keystore)) {
    Write-Host "`n🔑 正在生成密钥库..."
    keytool -genkey -v -keystore $keystore -storepass $keystorePass -alias $alias -keypass $keyPass -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=zhepama, OU=godgodgame, O=godgodgame, L=bengbu, ST=anhui, C=cn"
}

# 4. 手动签名 APK (仅当 Gradle 未签名时执行)
Write-Host "`n✍️ 正在手动签名 APK..."
# 使用 ANDROID_HOME 查找 apksigner

$apksigner = Get-ChildItem "$env:ANDROID_HOME\build-tools\*\apksigner.bat" | Sort-Object Name -Descending | Select-Object -First 1

if (-not $apksigner) {
    Write-Host "`n❌ 在 SDK 中未找到 apksigner！" -ForegroundColor Red
    Pause
    exit
}
Write-Host "使用 apksigner：$($apksigner.FullName)"

& $apksigner.FullName sign --ks $keystore --ks-pass pass:$keystorePass --key-pass pass:$keyPass --out $signedApk $unsignedApk

if ($LASTEXITCODE -eq 0) {
    # 同 Gradle 已签名分支：归档到根目录 dist-android 固定出口
    $distDir = "$projectRoot\dist-android"
    New-Item -ItemType Directory -Force -Path $distDir | Out-Null
    Copy-Item $signedApk "$distDir\app-release-signed.apk" -Force
    Write-Host "`n✅ 成功！已创建签名 APK：" -ForegroundColor Green
    Write-Host $signedApk
    Write-Host "   已归档到：$distDir\app-release-signed.apk"
    explorer $distDir
} else {
    Write-Host "`n❌ 手动签名失败！" -ForegroundColor Red
}

Pause

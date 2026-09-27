<#
  build-apk.ps1 -- minimal hand-rolled Android APK builder (no Gradle, no AndroidX).

  Pipeline:  aapt(package + R.java) -> javac -> d8 -> aapt(package apk + assets)
             -> zipalign -> apksigner sign -> apksigner verify

  Why hand-rolled: works fully offline (no Maven/Gradle downloads), and is the same
  approach used by the Android DSH ports. Fine for small/medium apps.

  Expected project layout:
      <Project>/AndroidManifest.xml
      <Project>/src/**/*.java
      <Project>/res/**                 (optional)
      <Project>/assets/**              (optional)

  Usage:
      pwsh -File D:\Android\build-apk.ps1 -Project D:\Android\hello

  ASCII only on purpose: Windows PowerShell 5.1 decodes .ps1 as ANSI/GBK and
  non-ASCII comments can eat following lines.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Project,
    [string]$Sdk          = $env:ANDROID_HOME,
    [string]$JavaHome     = $env:JAVA_HOME,
    [string]$BuildTools   = "34.0.0",
    [string]$Platform     = "android-35",
    [int]$MinApi          = 26,
    [string]$Keystore     = "$env:USERPROFILE\.android\debug.keystore",
    [string]$KsAlias      = "androiddebugkey",
    [string]$KsPass       = "android",
    [string]$AssetsDir    = "",
    [string]$OutApk       = "",
    [string]$ExtraClasspath = ""
)

function Die([string]$msg) { Write-Host ("ERROR: " + $msg) -ForegroundColor Red; exit 1 }

function Invoke-Native([string]$label, [string]$exe, [string[]]$argv) {
    Write-Host ("  -> " + $label)
    $captured = & $exe @argv 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        Write-Host ($captured | Out-String)
        Die ("step failed: " + $label + " (exit " + $code + ")")
    }
    return $captured
}

if (-not $Sdk)      { Die "ANDROID_HOME not set; pass -Sdk" }
if (-not $JavaHome) { Die "JAVA_HOME not set; pass -JavaHome" }
if (-not (Test-Path $Project)) { Die ("project not found: " + $Project) }
if (-not $AssetsDir) { $AssetsDir = Join-Path $Project "assets" }
if (-not $OutApk)   { $OutApk = Join-Path $Project ("build\" + (Split-Path $Project -Leaf) + ".apk") }

$bt         = Join-Path $Sdk ("build-tools\" + $BuildTools)
$aapt       = Join-Path $bt "aapt.exe"
$aapt2      = Join-Path $bt "aapt2.exe"
$d8         = Join-Path $bt "d8.bat"
$zipalign   = Join-Path $bt "zipalign.exe"
$apksigner  = Join-Path $bt "apksigner.bat"
$javac      = Join-Path $JavaHome "bin\javac.exe"
$androidJar = Join-Path $Sdk ("platforms\" + $Platform + "\android.jar")
$manifest   = Join-Path $Project "AndroidManifest.xml"
$resDir     = Join-Path $Project "res"
$srcDir     = Join-Path $Project "src"

foreach ($need in @($aapt, $d8, $zipalign, $apksigner, $javac, $androidJar, $manifest)) {
    if (-not (Test-Path $need)) { Die ("missing required path: " + $need) }
}
if (-not (Test-Path $Keystore)) { Die ("keystore not found: " + $Keystore) }

$buildDir = Join-Path $Project "build"
$genDir   = Join-Path $buildDir "gen"
$clsDir   = Join-Path $buildDir "classes"
$dexDir   = Join-Path $buildDir "dex"
$unsigned = Join-Path $buildDir "unsigned.apk"
$aligned  = Join-Path $buildDir "aligned.apk"

Remove-Item $genDir, $clsDir, $dexDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $unsigned, $aligned -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $genDir, $clsDir, $dexDir | Out-Null

Write-Host ("project   : " + $Project)
Write-Host ("sdk       : " + $Sdk)
Write-Host ("buildtools: " + $BuildTools)
Write-Host ("platform  : " + $Platform + "   minApi: " + $MinApi)

# ---- 1. resources -> R.java -------------------------------------------------
Write-Host "[1/7] aapt: generate R.java"
$stepArgs = @("package", "-f", "-m", "-J", $genDir, "-M", $manifest, "-I", $androidJar)
if (Test-Path $resDir) { $stepArgs += @("-S", $resDir) }
Invoke-Native "aapt package -m" $aapt $stepArgs | Out-Null

# ---- 2. javac ---------------------------------------------------------------
Write-Host "[2/7] javac"
$sources = @()
if (Test-Path $srcDir) { $sources += (Get-ChildItem $srcDir -Recurse -Filter *.java | ForEach-Object { $_.FullName }) }
$sources += (Get-ChildItem $genDir -Recurse -Filter *.java | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) { Die "no .java sources found" }

$cp = $genDir
if ($ExtraClasspath) { $cp = $cp + ";" + $ExtraClasspath }
$base = @("-encoding", "UTF-8", "-source", "8", "-target", "8", "-nowarn", "-classpath", $cp, "-d", $clsDir)
# JDK 9+ only accepts -bootclasspath together with -source 8; fall back if refused.
$out = & $javac @base -bootclasspath $androidJar @sources 2>&1
if ($LASTEXITCODE -ne 0) {
    # Always show the REAL errors from this attempt: the retry below fails on every
    # android.* import, and printing only its output hides the actual cause.
    Write-Host ($out | Out-String)
    Write-Host "  (retrying javac without -bootclasspath)"
    $out = & $javac @base @sources 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Host ($out | Out-String); Die "javac failed" }
}
$ncls = (Get-ChildItem $clsDir -Recurse -Filter *.class | Measure-Object).Count
Write-Host ("  -> " + $ncls + " class files")
if ($ncls -eq 0) { Die "javac produced no classes" }

# ---- 3. d8 -> dex -----------------------------------------------------------
Write-Host "[3/7] d8: classes -> dex"
$classFiles = (Get-ChildItem $clsDir -Recurse -Filter *.class | ForEach-Object { $_.FullName })
$d8Args = @("--release", "--lib", $androidJar, "--min-api", "$MinApi", "--output", $dexDir) + $classFiles
Invoke-Native "d8" $d8 $d8Args | Out-Null
$dexFile = Join-Path $dexDir "classes.dex"
if (-not (Test-Path $dexFile)) { Die "d8 produced no classes.dex" }

# ---- 4. package unsigned apk ------------------------------------------------
Write-Host "[4/7] aapt: package apk"
$pkgArgs = @("package", "-f", "-M", $manifest, "-I", $androidJar)
if (Test-Path $resDir)    { $pkgArgs += @("-S", $resDir) }
if (Test-Path $AssetsDir) { $pkgArgs += @("-A", $AssetsDir) }
$pkgArgs += @("-F", $unsigned)
Invoke-Native "aapt package -F" $aapt $pkgArgs | Out-Null

# ---- 5. add classes.dex -----------------------------------------------------
Write-Host "[5/7] add classes.dex"
Push-Location $dexDir
$aaptAdd = & $aapt add $unsigned "classes.dex" 2>&1
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Write-Host ($aaptAdd | Out-String); Die "aapt add classes.dex failed" }

# ---- 6. zipalign ------------------------------------------------------------
Write-Host "[6/7] zipalign"
Invoke-Native "zipalign" $zipalign @("-f", "-p", "4", $unsigned, $aligned) | Out-Null

# ---- 7. sign + verify -------------------------------------------------------
Write-Host "[7/7] apksigner"
New-Item -ItemType Directory -Force -Path (Split-Path $OutApk) | Out-Null
$signArgs = @("sign", "--ks", $Keystore, "--ks-key-alias", $KsAlias,
              "--ks-pass", ("pass:" + $KsPass), "--key-pass", ("pass:" + $KsPass),
              "--out", $OutApk, $aligned)
Invoke-Native "apksigner sign" $apksigner $signArgs | Out-Null
Invoke-Native "apksigner verify" $apksigner @("verify", "--print-certs", $OutApk) | Out-Null

$size = (Get-Item $OutApk).Length
Write-Host ""
Write-Host ("BUILD OK  ->  " + $OutApk + "   (" + [math]::Round($size / 1KB, 1) + " KB)")
# Cosmetic only. aapt.exe cannot open a path containing non-ASCII characters
# ("Illegal byte sequence"), so never let this step fail the build.
try {
    $aaptBadge = & $aapt dump badging $OutApk 2>&1
    if ($LASTEXITCODE -eq 0 -and $aaptBadge) {
        $aaptBadge | Select-String -Pattern "^package:|^launchable-activity:|^sdkVersion:|^targetSdkVersion:|^native-code:" |
            ForEach-Object { Write-Host ("  " + $_.ToString().Trim()) }
    } else {
        Write-Host "  (aapt dump badging unavailable for this path - APK itself is fine)"
    }
} catch {
    Write-Host "  (aapt dump badging skipped)"
}

#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Bump version, commit, tag and push a new Md-Reader release.

.DESCRIPTION
    Vérifie que la version donnée est strictement supérieure à l'actuelle,
    met à jour package.json, src-tauri/tauri.conf.json et src-tauri/Cargo.toml,
    crée un commit + tag vX.Y.Z et pousse le tout vers origin.

    GitHub Actions prend ensuite le relais pour builder et publier la Release.

.PARAMETER Version
    Nouvelle version au format X.Y.Z (ex: 0.1.1).

.PARAMETER SkipPush
    Si présent, fait le commit et le tag mais ne push pas.

.PARAMETER Yes
    Saute la demande de confirmation.

.EXAMPLE
    .\scripts\release.ps1 0.1.1
    .\scripts\release.ps1 0.2.0 -Yes
    .\scripts\release.ps1 0.1.1 -SkipPush
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version,

    [switch]$SkipPush,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'

function Fail($msg) {
    Write-Host "✗ $msg" -ForegroundColor Red
    exit 1
}

function Info($msg) {
    Write-Host "→ $msg" -ForegroundColor Cyan
}

function OK($msg) {
    Write-Host "✓ $msg" -ForegroundColor Green
}

# Se placer à la racine du repo (parent du dossier scripts)
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# --- 1. Valider le format de la version ---
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Fail "Format invalide : '$Version'. Attendu X.Y.Z (ex: 0.1.1)"
}

# --- 2. Lire la version actuelle dans package.json ---
$pkgPath = Join-Path $repoRoot 'package.json'
$tauriConfPath = Join-Path $repoRoot 'src-tauri/tauri.conf.json'
$cargoPath = Join-Path $repoRoot 'src-tauri/Cargo.toml'

foreach ($p in @($pkgPath, $tauriConfPath, $cargoPath)) {
    if (-not (Test-Path $p)) {
        Fail "Fichier introuvable : $p"
    }
}

$pkgJson = Get-Content $pkgPath -Raw | ConvertFrom-Json
$currentVersion = $pkgJson.version

if (-not $currentVersion) {
    Fail "Impossible de lire la version actuelle dans package.json"
}

Info "Version actuelle : $currentVersion"
Info "Nouvelle version : $Version"

# --- 3. Comparer semver (strict > pour empêcher de re-tagger la même version) ---
function Compare-Semver([string]$a, [string]$b) {
    $pa = $a.Split('.') | ForEach-Object { [int]$_ }
    $pb = $b.Split('.') | ForEach-Object { [int]$_ }
    for ($i = 0; $i -lt 3; $i++) {
        if ($pa[$i] -lt $pb[$i]) { return -1 }
        if ($pa[$i] -gt $pb[$i]) { return 1 }
    }
    return 0
}

$cmp = Compare-Semver $currentVersion $Version
if ($cmp -eq 0) {
    Fail "La nouvelle version est identique à l'actuelle ($currentVersion). Choisis un numéro plus élevé."
}
if ($cmp -gt 0) {
    Fail "La nouvelle version ($Version) est inférieure à l'actuelle ($currentVersion). Tu ne peux pas régresser."
}

# --- 4. Vérifier qu'on est sur main et que le working tree est clean ---
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') {
    Write-Host "⚠ Tu es sur la branche '$branch' (pas 'main')." -ForegroundColor Yellow
    if (-not $Yes) {
        $resp = Read-Host "Continuer quand même ? (o/N)"
        if ($resp -ne 'o' -and $resp -ne 'O') { Fail "Abandonné." }
    }
}

$status = git status --porcelain
if ($status) {
    Write-Host "⚠ Working tree non vide :" -ForegroundColor Yellow
    git status --short
    if (-not $Yes) {
        $resp = Read-Host "Ces changements seront inclus dans le commit de release. Continuer ? (o/N)"
        if ($resp -ne 'o' -and $resp -ne 'O') { Fail "Abandonné." }
    }
}

# --- 5. Vérifier que le tag n'existe pas déjà ---
$tag = "v$Version"
$existingTag = git tag -l $tag
if ($existingTag) {
    Fail "Le tag $tag existe déjà localement. Supprime-le d'abord : git tag -d $tag"
}

# --- 6. Mettre à jour les 3 fichiers ---
Info "Mise à jour de package.json"
$pkgRaw = Get-Content $pkgPath -Raw
$pkgNew = $pkgRaw -replace '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}"
[System.IO.File]::WriteAllText($pkgPath, $pkgNew)

Info "Mise à jour de src-tauri/tauri.conf.json"
$tauriRaw = Get-Content $tauriConfPath -Raw
$tauriNew = $tauriRaw -replace '("version"\s*:\s*")[^"]+(")', "`${1}$Version`${2}"
[System.IO.File]::WriteAllText($tauriConfPath, $tauriNew)

Info "Mise à jour de src-tauri/Cargo.toml"
$cargoRaw = Get-Content $cargoPath -Raw
# Vise spécifiquement la ligne `version = "X.Y.Z"` du [package], pas les deps
$cargoNew = $cargoRaw -replace '(?m)^version\s*=\s*"[^"]+"', "version = `"$Version`""
[System.IO.File]::WriteAllText($cargoPath, $cargoNew)

OK "Fichiers mis à jour."

# --- 7. Mettre à jour Cargo.lock (sinon Cargo râle) ---
Info "Mise à jour de Cargo.lock"
Push-Location (Join-Path $repoRoot 'src-tauri')
try {
    cargo update --workspace --offline 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        # Si --offline échoue, retomber sur un update normal
        cargo update --workspace 2>&1 | Out-Null
    }
} finally {
    Pop-Location
}

# --- 8. Afficher le diff ---
Write-Host ""
Info "Aperçu des changements :"
git --no-pager diff --stat
Write-Host ""

if (-not $Yes) {
    $resp = Read-Host "Tout est OK ? Créer le commit + tag $tag et push ? (o/N)"
    if ($resp -ne 'o' -and $resp -ne 'O') {
        Write-Host "Abandonné. Les fichiers restent modifiés en local." -ForegroundColor Yellow
        exit 0
    }
}

# --- 9. Commit + tag + push ---
Info "Création du commit"
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Bump version to $Version"
if ($LASTEXITCODE -ne 0) { Fail "git commit a échoué." }

Info "Création du tag $tag"
git tag $tag
if ($LASTEXITCODE -ne 0) { Fail "git tag a échoué." }

if ($SkipPush) {
    OK "Commit et tag créés. Push ignoré (option -SkipPush)."
    Write-Host ""
    Write-Host "Pour pousser plus tard :" -ForegroundColor Yellow
    Write-Host "  git push" -ForegroundColor White
    Write-Host "  git push origin $tag" -ForegroundColor White
    exit 0
}

Info "Push de la branche"
git push
if ($LASTEXITCODE -ne 0) { Fail "git push a échoué." }

Info "Push du tag $tag"
git push origin $tag
if ($LASTEXITCODE -ne 0) { Fail "git push du tag a échoué." }

Write-Host ""
OK "Release $tag déclenchée."
Write-Host ""
Write-Host "GitHub Actions est en train de builder et publier :" -ForegroundColor Cyan
Write-Host "  https://github.com/Theo-Lempereur/Md-Reader/actions" -ForegroundColor White
Write-Host ""
Write-Host "La Release apparaîtra dans ~5-10 min ici :" -ForegroundColor Cyan
Write-Host "  https://github.com/Theo-Lempereur/Md-Reader/releases" -ForegroundColor White

# Sync .env secrets to Fly (joes-jarvis). Run from repo root after: fly auth login
$ErrorActionPreference = "Stop"
$envFile = Join-Path $PSScriptRoot "..\.env"
if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }

function Get-EnvValue([string]$key) {
  $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$([regex]::Escape($key))=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace "^[^=]+=", "").Trim()
}

$keys = @(
  "ANTHROPIC_API_KEY",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "GMAIL_REDIRECT_URI",
  "DEEPGRAM_API_KEY",
  "DEEPGRAM_VOICE",
  "TTS_PROVIDER",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_MODEL",
  "JOE_PRIVATE_NUMBER",
  "BRAVE_API_KEY"
)

$pairs = @()
foreach ($k in $keys) {
  $v = Get-EnvValue $k
  if ([string]::IsNullOrWhiteSpace($v)) {
    Write-Warning "Skipping empty: $k"
    continue
  }
  $pairs += "${k}=$v"
}

if ($pairs.Count -eq 0) { throw "No secrets to set" }

Write-Host "Setting $($pairs.Count) secrets on joes-jarvis..."
& fly secrets set @pairs -a joes-jarvis
Write-Host "Done. Run: fly secrets list -a joes-jarvis"

param(
  [string]$ApiBaseUrl = "http://localhost:3000",
  [int]$StartupTimeoutSec = 25,
  [switch]$KeepServerRunning
)

$ErrorActionPreference = "Stop"

function Write-Section([string]$title) {
  Write-Host ""
  Write-Host "== $title ==" -ForegroundColor Cyan
}

function Invoke-Json([string]$method, [string]$path, [hashtable]$headers = $null, $body = $null) {
  $uri = ($ApiBaseUrl.TrimEnd("/") + $path)
  $params = @{
    Method = $method
    Uri = $uri
    TimeoutSec = 20
  }
  if ($headers) { $params.Headers = $headers }
  if ($null -ne $body) {
    $params.ContentType = "application/json"
    $params.Body = ($body | ConvertTo-Json -Depth 20)
  }
  return Invoke-RestMethod @params
}

function Try-Call([string]$name, [scriptblock]$fn) {
  try {
    $res = & $fn
    return @{ ok = $true; name = $name; res = $res; err = $null }
  } catch {
    return @{ ok = $false; name = $name; res = $null; err = $_.Exception.Message }
  }
}

function Wait-ForHealth() {
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $res = Invoke-Json "GET" "/health"
      if ($res.ok -eq $true) { return $true }
    } catch {
      Start-Sleep -Milliseconds 600
    }
  }
  return $false
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $repoRoot) { $repoRoot = (Get-Location).Path }

Write-Section "Starting backend"
$server = Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden

try {
  if (-not (Wait-ForHealth)) {
    throw "Backend did not become healthy at $ApiBaseUrl within $StartupTimeoutSec seconds."
  }
  Write-Host "Backend healthy at $ApiBaseUrl" -ForegroundColor Green

  Write-Section "Auth smoke"
  $stamp = Get-Date -Format "yyyyMMddHHmmss"
  $email = "smoke+$stamp@example.com"
  $password = "TestPassw0rd!"

  $register = Try-Call "POST /auth/register" { Invoke-Json "POST" "/auth/register" $null @{ email = $email; password = $password; name = "Smoke Test" } }
  if (-not $register.ok) { throw "Register failed: $($register.err)" }

  $token = $register.res.token
  if (-not $token) { throw "Register did not return token." }
  $workspaceId = $register.res.workspace.id
  if (-not $workspaceId) { throw "Register did not return workspace id." }
  $authHeaders = @{ Authorization = "Bearer $token"; "x-workspace-id" = $workspaceId }

  $me = Try-Call "GET /auth/me" { Invoke-Json "GET" "/auth/me" $authHeaders }
  if (-not $me.ok) { throw "Me failed: $($me.err)" }
  Write-Host ("User: {0}" -f $me.res.user.email)
  Write-Host ("Workspace: {0}" -f $workspaceId)

  Write-Section "Core tenant endpoints"
  $workspaces = Try-Call "GET /workspaces" { Invoke-Json "GET" "/workspaces" $authHeaders }
  $wallet = Try-Call "GET /wallet" { Invoke-Json "GET" "/wallet" $authHeaders }
  $templates = Try-Call "GET /templates" { Invoke-Json "GET" "/templates" $authHeaders }
  $contacts = Try-Call "GET /contacts?limit=5" { Invoke-Json "GET" "/contacts?limit=5" $authHeaders }
  $convos = Try-Call "GET /conversations?limit=5" { Invoke-Json "GET" "/conversations?limit=5" $authHeaders }
  $analytics = Try-Call "GET /analytics/overview" { Invoke-Json "GET" "/analytics/overview" $authHeaders }
  $campaigns = Try-Call "GET /campaigns" { Invoke-Json "GET" "/campaigns" $authHeaders }
  $metaConnect = Try-Call "GET /auth/meta" { Invoke-Json "GET" "/auth/meta" $authHeaders }

  foreach ($call in @($workspaces, $wallet, $templates, $contacts, $convos, $analytics, $campaigns, $metaConnect)) {
    if ($call.ok) {
      Write-Host ("OK: {0}" -f $call.name) -ForegroundColor Green
    } else {
      Write-Host ("FAIL: {0} -> {1}" -f $call.name, $call.err) -ForegroundColor Yellow
    }
  }

  Write-Host ("templates: {0}" -f (($templates.res.templates | Measure-Object).Count))
  Write-Host ("contacts:  {0}" -f (($contacts.res.contacts | Measure-Object).Count))
  Write-Host ("threads:   {0}" -f (($convos.res.conversations | Measure-Object).Count))
  if ($wallet.ok) {
    Write-Host ("wallet:    {0} {1}" -f $wallet.res.wallet.balance, $wallet.res.wallet.currency)
  }

  Write-Section "Create sample template + contact + tracked link"
  $templateName = ("smoke_offer_{0}" -f (Get-Date -Format "HHmmss"))
  $templateCreate = Try-Call "POST /templates" {
    Invoke-Json "POST" "/templates" $authHeaders @{
      name = $templateName
      language = "en_US"
      category = "marketing"
      components = @(
        @{
          type = "BODY"
          text = "Hello {{1}}, welcome to smoke test"
        }
      )
    }
  }
  if ($templateCreate.ok) {
    Write-Host ("OK: {0}" -f $templateCreate.name) -ForegroundColor Green
  } else {
    Write-Host ("SKIP/FAIL: {0} -> {1}" -f $templateCreate.name, $templateCreate.err) -ForegroundColor Yellow
  }

  $phoneSeed = Get-Random -Minimum 7000000000 -Maximum 9999999999
  $samplePhone = "91$phoneSeed"
  $contactCreate = Try-Call "POST /contacts" {
    Invoke-Json "POST" "/contacts" $authHeaders @{
      phone = $samplePhone
      name = "Demo Customer"
      email = "demo.customer@example.com"
      company = "Demo Co"
      tags = @("lead", "demo")
      notes = "Created by smoke-test.ps1"
    }
  }
  if ($contactCreate.ok) {
    Write-Host ("OK: {0}" -f $contactCreate.name) -ForegroundColor Green
  } else {
    Write-Host ("SKIP/FAIL: {0} -> {1}" -f $contactCreate.name, $contactCreate.err) -ForegroundColor Yellow
  }

  $linkCreate = Try-Call "POST /links" {
    Invoke-Json "POST" "/links" $authHeaders @{
      url = "https://example.com/?src=smoke"
    }
  }
  if ($linkCreate.ok) {
    Write-Host ("OK: {0}" -f $linkCreate.name) -ForegroundColor Green
    Write-Host ("trackedUrl: {0}" -f $linkCreate.res.trackedUrl)
  } else {
    Write-Host ("FAIL: {0} -> {1}" -f $linkCreate.name, $linkCreate.err) -ForegroundColor Yellow
  }

  Write-Section "WhatsApp send (conditional)"
  $creds = Try-Call "GET /credentials/whatsapp" { Invoke-Json "GET" "/credentials/whatsapp" $authHeaders }
  $hasCreds = $creds.ok -and $creds.res.success -and $creds.res.credentials -and ($creds.res.credentials.isValid -eq $true)
  if (-not $hasCreds) {
    Write-Host "SKIP: WhatsApp credentials not configured/validated for this user." -ForegroundColor Yellow
    Write-Host "Hint: UI -> Credentials page, then add token + phoneNumberId + wabaId and validate."
  } else {
    $tplRes = Invoke-Json "GET" "/templates?status=approved" $authHeaders
    $approved = @($tplRes.templates | Where-Object { $_.status -eq "approved" })
    if ($approved.Count -eq 0) {
      Write-Host "SKIP: No approved templates available. Create/submit template and wait approval." -ForegroundColor Yellow
    } else {
      $tpl = $approved[0]
      $send = Try-Call "POST /messages/send" {
        Invoke-Json "POST" "/messages/send" $authHeaders @{
          templateId = $tpl._id
          to = $samplePhone
          variables = @("Demo", "10")
        }
      }
      if ($send.ok -and $send.res.success) {
        $msgId = $null
        if ($send.res.message -and $send.res.message.whatsappMessageId) { $msgId = $send.res.message.whatsappMessageId }
        elseif ($send.res.message -and $send.res.message._id) { $msgId = $send.res.message._id }
        else { $msgId = "<unknown>" }
        Write-Host ("OK: Sent message (id: {0})" -f $msgId) -ForegroundColor Green
      } else {
        $errText = if ($send.err) { $send.err } else { "Unknown" }
        Write-Host ("FAIL: /messages/send -> {0}" -f $errText) -ForegroundColor Yellow
      }
    }
  }

  Write-Section "Done"
  Write-Host "If anything shows FAIL above, paste that line here and I'll fix it." -ForegroundColor Cyan
} finally {
  if ($KeepServerRunning) {
    Write-Host ""
    Write-Host ("Server left running (pid {0}). Stop it manually when done." -f $server.Id) -ForegroundColor Yellow
  } else {
    try { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
}

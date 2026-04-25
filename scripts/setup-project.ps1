#!/usr/bin/env pwsh
$ErrorActionPreference = "Stop"

function Read-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{}
  }

  $raw = Get-Content -LiteralPath $Path -Raw
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return [pscustomobject]@{}
  }

  return $raw | ConvertFrom-Json -Depth 100
}

function Ensure-Property {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$Value
  )

  if ($Object.PSObject.Properties.Name -contains $Name) {
    return
  }

  $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
}

$secureKey = Read-Host "Enter your Jules API key" -AsSecureString
$apiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
)

if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw "Jules API key cannot be empty."
}

$projectRootInput = Read-Host "Enter absolute path to your project root"
if ([string]::IsNullOrWhiteSpace($projectRootInput)) {
  throw "Project root path cannot be empty."
}

$projectRoot = (Resolve-Path -LiteralPath $projectRootInput).Path
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$mcpRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
$indexPath = (Resolve-Path (Join-Path $mcpRoot "index.js")).Path

$configPath = Join-Path $projectRoot ".mcp.json"
$stateFile = Join-Path $projectRoot ".jules-sessions.json"

$config = Read-JsonFile -Path $configPath
Ensure-Property -Object $config -Name "mcpServers" -Value ([pscustomobject]@{})

if ($config.mcpServers.PSObject.Properties.Name -contains "jules") {
  $config.mcpServers.PSObject.Properties.Remove("jules")
}

$config.mcpServers | Add-Member -NotePropertyName "jules" -NotePropertyValue ([pscustomobject]@{
  command = "node"
  args    = @($indexPath)
  env     = [pscustomobject]@{
    JULES_API_KEY    = $apiKey
    JULES_STATE_FILE = $stateFile
  }
})

$json = $config | ConvertTo-Json -Depth 100
Set-Content -LiteralPath $configPath -Value $json -Encoding utf8

Write-Host "Updated project MCP config: $configPath"
Write-Host "Jules MCP entry points to: $indexPath"
Write-Host "Session state file path set to: $stateFile"

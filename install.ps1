# agy-memory one-command installer for Windows PowerShell
# Local usage:
#   .\install.ps1
#   .\install.ps1 --project C:\path\to\repo
#   .\install.ps1 doctor
#   .\install.ps1 uninstall
# Remote usage:
#   irm https://raw.githubusercontent.com/maxLWS/agy-memory/main/install.ps1 | iex

$__agyMemScriptPath = ""
if ($null -ne $MyInvocation.MyCommand -and $null -ne $MyInvocation.MyCommand.PSObject.Properties["Path"]) {
  $__agyMemScriptPath = [string]$MyInvocation.MyCommand.Path
}
$__agyMemScriptRoot = if ($null -ne $PSScriptRoot) { [string]$PSScriptRoot } else { "" }
$__agyMemIsFile = -not [string]::IsNullOrEmpty($__agyMemScriptPath)
$__agyMemAcceptArgs = $__agyMemIsFile -or ($MyInvocation.InvocationName -eq "&")
$__agyMemArgList = New-Object 'System.Collections.Generic.List[string]'
if ($__agyMemAcceptArgs -and $null -ne $args) {
  foreach ($__agyMemItem in $args) {
    if ($null -ne $__agyMemItem) {
      $__agyMemArgList.Add([string]$__agyMemItem)
    }
  }
}
[string[]]$__agyMemRawArgs = $__agyMemArgList.ToArray()
$__agyMemState = @{ ExitCode = 0 }

& {
  param(
    [string[]]$InputArgs = @(),
    [string]$ScriptRoot = "",
    [hashtable]$State
  )

  $ErrorActionPreference = "Stop"
  $defaultRepo = "https://github.com/maxLWS/agy-memory.git"

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js >= 20 is required. Install Node.js first: https://nodejs.org/"
    $State.ExitCode = 1
    return
  }

  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $nodeMajorRaw = (& node -p "process.versions.node.split('.')[0]" | Out-String).Trim()
    $nodeCheckExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
  $nodeMajor = 0
  if ($nodeCheckExit -ne 0 -or -not [int]::TryParse($nodeMajorRaw, [ref]$nodeMajor) -or $nodeMajor -lt 20) {
    $nodeVer = (& node -v 2>$null | Out-String).Trim()
    Write-Error "Node.js >= 20 is required (found $nodeVer)."
    $State.ExitCode = 1
    return
  }

  $subcommands = @("install", "update", "uninstall", "status", "doctor", "-h", "--help")
  $hasSubcmd = ($InputArgs.Length -gt 0) -and ($subcommands -contains $InputArgs[0])

  $forwardList = New-Object 'System.Collections.Generic.List[string]'
  if (-not $hasSubcmd) {
    $forwardList.Add("install")
  }
  foreach ($a in $InputArgs) {
    $forwardList.Add([string]$a)
  }
  [string[]]$forwardArgs = $forwardList.ToArray()

  function Invoke-NodeInstaller {
    param(
      [string]$InstallerPath,
      [string[]]$ForwardArgs,
      [hashtable]$RunState
    )
    $argList = New-Object 'System.Collections.Generic.List[string]'
    $argList.Add($InstallerPath)
    foreach ($fa in $ForwardArgs) {
      $argList.Add([string]$fa)
    }
    [string[]]$nodeArgs = $argList.ToArray()

    $savedEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & node @nodeArgs
      $RunState.ExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $savedEap
    }
  }

  $scriptDir = if (-not [string]::IsNullOrEmpty($ScriptRoot)) { $ScriptRoot } else { "" }
  if (-not [string]::IsNullOrEmpty($scriptDir)) {
    $localManifest = Join-Path $scriptDir "plugin.json"
    $localInstaller = Join-Path $scriptDir "scripts\install.mjs"
    if ((Test-Path $localManifest) -and (Test-Path $localInstaller)) {
      try {
        $manifestJson = Get-Content -Path $localManifest -Raw | ConvertFrom-Json
        if ($manifestJson.name -eq "agy-memory") {
          Invoke-NodeInstaller -InstallerPath $localInstaller -ForwardArgs $forwardArgs -RunState $State
          return
        }
      } catch {
        # Fall through to remote install
      }
    }
  }

  $defaultTarget = Join-Path $env:USERPROFILE ".gemini\config\plugins\agy-memory"
  $installedInstaller = Join-Path $defaultTarget "scripts\install.mjs"
  if ($hasSubcmd -and ($InputArgs[0] -ne "install") -and (Test-Path $installedInstaller)) {
    Invoke-NodeInstaller -InstallerPath $installedInstaller -ForwardArgs $forwardArgs -RunState $State
    return
  }

  $repoUrl = if ($env:AGY_MEMORY_REPO) { $env:AGY_MEMORY_REPO } else { $defaultRepo }

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "git is required for remote installation."
    $State.ExitCode = 1
    return
  }

  $tmpClone = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-memory-install-" + [System.Guid]::NewGuid().ToString("N"))
  try {
    Write-Host "Cloning agy-memory from $repoUrl..."
    $savedEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & git clone --depth 1 $repoUrl $tmpClone
      $gitExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $savedEap
    }
    if ($gitExit -ne 0) {
      Write-Error "git clone failed with exit code $gitExit."
      $State.ExitCode = $gitExit
      return
    }

    $clonedInstaller = Join-Path $tmpClone "scripts\install.mjs"
    Invoke-NodeInstaller -InstallerPath $clonedInstaller -ForwardArgs $forwardArgs -RunState $State
  } finally {
    if (Test-Path $tmpClone) {
      Remove-Item -Path $tmpClone -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
} -InputArgs $__agyMemRawArgs -ScriptRoot $__agyMemScriptRoot -State $__agyMemState

$__agyMemFinalExit = $__agyMemState.ExitCode
$__agyMemWasFile = $__agyMemIsFile
Remove-Variable -Name __agyMemScriptPath, __agyMemScriptRoot, __agyMemIsFile, __agyMemAcceptArgs, __agyMemArgList, __agyMemItem, __agyMemRawArgs, __agyMemState -ErrorAction SilentlyContinue
if ($__agyMemWasFile) {
  Remove-Variable -Name __agyMemWasFile -ErrorAction SilentlyContinue
  exit $__agyMemFinalExit
}
Remove-Variable -Name __agyMemFinalExit, __agyMemWasFile -ErrorAction SilentlyContinue

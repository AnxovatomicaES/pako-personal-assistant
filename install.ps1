# Pako on Windows, in one line (Windows PowerShell 5.1 or PowerShell 7), with no administrator:
#
#   irm https://raw.githubusercontent.com/AnxovatomicaES/pako-personal-assistant/main/install.ps1 | iex
#
# (The address is OWNER/REPO from package.json's "repository", on its default branch: the same rule as install.sh, checked by a test.)
# or, from a copy of Pako you already have:  powershell -ExecutionPolicy Bypass -File install.ps1
#
# What it does, and nothing more: checks Node.js 22.18 or newer and git (when one is missing it prints the winget command and stops), puts
# Pako in %USERPROFILE%\pako or updates the copy there, installs its pieces (npm ci --omit=dev --ignore-scripts), checks Claude Code, asks
# whether Pako should start by itself when you sign in (src/autostart-windows.ts), starts Pako and prints the panel's address.
# Running it again updates Pako. docs/install-windows.md explains each step and how to undo it.
#
# Optional settings: PAKO_DIR (the folder), PAKO_REPO (the git address), PAKO_AUTOSTART=1 or 0 (the answer, without the question),
# PAKO_HOME (Pako's own folder for notes and settings, ~/.pako by default, as for npm start).
#
# Only ASCII in this file: Windows PowerShell 5.1 reads a saved script without a BOM in the old ANSI code page, which would garble the
# Spanish. Its accents are written ^a ^e ^i ^o ^u ^n ^? ^! and put back by T.
# Everything is inside a function: through iex, an `exit` would close the person's window and $ErrorActionPreference would stay in it.

function Install-Pako {
  $ErrorActionPreference = 'Stop'
  # git and npm write progress to stderr. Under $ErrorActionPreference = 'Stop', Windows PowerShell 5.1 turns that into a terminating error
  # whenever the output is captured (ISE, some terminals, a background job): the clone would "fail" while it works. So each native program
  # runs with 'Continue', and its exit code decides, as before.
  function Run-Native([scriptblock]$block) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $block } finally { $ErrorActionPreference = $saved }
  }
  # The same address as package.json's "repository", and as DEFAULT_REPO in install.sh (a test checks they agree).
  $DefaultRepo = 'https://github.com/AnxovatomicaES/pako-personal-assistant.git'
  $spanish = (Get-UICulture).TwoLetterISOLanguageName -eq 'es'
  $accents = @{ 'a' = [char]0xE1; 'e' = [char]0xE9; 'i' = [char]0xED; 'o' = [char]0xF3; 'u' = [char]0xFA; 'n' = [char]0xF1; '?' = [char]0xBF; '!' = [char]0xA1 }

  # The text in the person's language (Spanish when Windows is in Spanish, English otherwise).
  function T([string]$es, [string]$en) {
    if (-not $spanish) { return $en }
    foreach ($k in $accents.Keys) { $es = $es.Replace('^' + $k, [string]$accents[$k]) }
    return $es
  }
  function Say([string]$es, [string]$en) { Write-Host ('  ' + (T $es $en)) }

  Write-Host ''
  Say 'Instalando Pako, tu asistente.' 'Installing Pako, your assistant.'
  Write-Host ''

  # ---- Node.js and git: without them nothing else can run. Installing them is the person's call, so it is said, not done.
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $nodeOk = $false
  if ($node) {
    $version = (& $node.Source -p 'process.versions.node' | Out-String).Trim()
    $parts = $version.Split('.')
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    # The oldest Node that runs Pako's TypeScript as it is: 22.18, or 23.6 on the short-lived 23 line (as bin/preflight.cjs says).
    $nodeOk = ($major -gt 23) -or ($major -eq 22 -and $minor -ge 18) -or ($major -eq 23 -and $minor -ge 6)
  }
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $nodeOk -or -not $git) {
    if (-not $nodeOk) {
      if ($node) { Say "Pako necesita Node.js 22.18 o m^as nuevo, y aqu^i hay $version." "Pako needs Node.js 22.18 or newer, and this is $version." }
      else { Say 'Pako necesita Node.js 22.18 o m^as nuevo, y no est^a instalado.' 'Pako needs Node.js 22.18 or newer, and it is not installed.' }
      Write-Host '      winget install --id OpenJS.NodeJS.LTS -e'
    }
    if (-not $git) {
      Say 'Pako necesita git (Claude Code tambi^en lo usa en Windows), y no est^a instalado.' 'Pako needs git (Claude Code uses it on Windows too), and it is not installed.'
      Write-Host '      winget install --id Git.Git -e'
    }
    Write-Host ''
    Say 'Inst^alalo con lo de arriba, cierra esta ventana, abre otra y vuelve a pegar la misma l^inea.' 'Install it with the line above, close this window, open a new one and paste the same line again.'
    Write-Host ''
    return
  }
  $nodeExe = $node.Source
  $npm = Join-Path (Split-Path -Parent $nodeExe) 'npm.cmd'
  # npm.cmd, never npm: PowerShell would pick npm.ps1, which a computer that runs no scripts (the default) refuses.
  if (-not (Test-Path -LiteralPath $npm)) { $npm = 'npm.cmd' }

  # ---- Where: PAKO_DIR, else the copy this script is in (run as a file), else %USERPROFILE%\pako.
  $dir = $env:PAKO_DIR
  if (-not $dir) {
    if ($PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'src\server.ts'))) { $dir = $PSScriptRoot }
    else { $dir = Join-Path $HOME 'pako' }
  }
  $repo = $env:PAKO_REPO
  if (-not $repo) { $repo = $DefaultRepo }

  # Pako's own files, not only its name: the npm compression library is called "pako" too, and a clone of it may well be in %USERPROFILE%\pako.
  # A folder without them is left alone: no git pull, no npm ci (which would empty its node_modules), no npm start of someone else's project.
  $isPako = $true
  foreach ($f in 'package.json', 'src\server.ts', 'src\autostart-windows.ts', 'bin\panel.cjs') {
    if (-not (Test-Path -LiteralPath (Join-Path $dir $f))) { $isPako = $false }
  }
  if ($isPako) { $isPako = [bool](Select-String -LiteralPath (Join-Path $dir 'package.json') -Pattern '"name": "pako"' -SimpleMatch -Quiet) }
  if (-not $isPako -and (Test-Path -LiteralPath $dir) -and (Get-ChildItem -Force -LiteralPath $dir | Select-Object -First 1)) {
    Say "$dir ya existe y no es una copia de Pako: no la toco. Elige otra carpeta con `$env:PAKO_DIR." "$dir already exists and is not a copy of Pako: leaving it alone. Pick another folder with `$env:PAKO_DIR."
    return
  }

  if ($isPako -and (Test-Path -LiteralPath (Join-Path $dir '.git'))) {
    Say "Actualizando Pako en $dir..." "Updating Pako in $dir..."
    Run-Native { & git -C $dir pull --ff-only }
    if ($LASTEXITCODE -ne 0) {
      Say "git no pudo actualizar $dir (mira el mensaje de arriba). Pako sigue como estaba." "git could not update $dir (see the message above). Pako is as it was."
      return
    }
  } elseif ($isPako) {
    # A copy without git (a downloaded zip): used as it is, and updated by downloading it again.
    Say "Usando la copia de Pako que hay en $dir." "Using the copy of Pako in $dir."
  } else {
    Say "Descargando Pako en $dir..." "Downloading Pako into $dir..."
    Run-Native { & git clone --depth 1 $repo $dir }
    if ($LASTEXITCODE -ne 0) {
      Say 'git no pudo descargar Pako (mira el mensaje de arriba).' 'git could not download Pako (see the message above).'
      return
    }
  }

  # ---- Its pieces: only what it runs with, and no package's own install scripts.
  Push-Location -LiteralPath $dir
  try {
    Say 'Instalando sus piezas (npm ci)...' 'Installing its pieces (npm ci)...'
    Run-Native { & $npm ci --omit=dev --ignore-scripts --no-audit --no-fund }
    if ($LASTEXITCODE -ne 0) {
      Say 'npm no pudo instalar las piezas de Pako (mira el mensaje de arriba).' 'npm could not install Pako''s pieces (see the message above).'
      return
    }

    # ---- Claude Code: Pako's brain. Without it Pako still starts, says so in its chat, and picks it up once it is installed.
    $claude = (Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath (Join-Path $HOME '.local\bin\claude.exe'))
    if (-not $claude -and $env:APPDATA) { $claude = Test-Path -LiteralPath (Join-Path $env:APPDATA 'npm\claude.cmd') }
    if ($claude) {
      Say 'Claude Code est^a instalado: si a^un no has entrado, escribe claude en una ventana y entra con tu cuenta.' 'Claude Code is installed: if you have not signed in yet, type claude in a window and sign in.'
    } else {
      Say 'Falta Claude Code, el cerebro de Pako. Inst^alalo y entra con tu cuenta (Pako lo encuentra solo):' 'Claude Code, Pako''s brain, is missing. Install it and sign in (Pako finds it by itself):'
      Write-Host '      irm https://claude.ai/install.ps1 | iex'
      Write-Host '      claude'
    }
    Write-Host ''

    # ---- Already running (this run is an update): it keeps running the old code until it is started again.
    $pakoHome = $env:PAKO_HOME
    if (-not $pakoHome) { $pakoHome = Join-Path $HOME '.pako' }
    $lockPath = Join-Path $pakoHome '.lock'
    $running = $null
    if (Test-Path -LiteralPath $lockPath) {
      $pidText = (Get-Content -LiteralPath $lockPath -TotalCount 1)
      if ($pidText -match '^\d+$') { $running = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'node' } }
    }
    if ($running) {
      Say "Pako ya est^a en marcha (proceso $($running.Id)): para usar lo nuevo, p^aralo y arr^ancalo otra vez." "Pako is already running (process $($running.Id)): to use the update, stop it and start it again."
      Write-Host "      Stop-Process -Id $($running.Id)"
      Write-Host ''
      & $nodeExe (Join-Path $dir 'bin\panel.cjs')
      return
    }

    # ---- Autostart: a task of this account's own, at sign-in, with no window (src/autostart-windows.ts).
    $auto = $env:PAKO_AUTOSTART
    if ($auto -ne '1' -and $auto -ne '0') {
      $answer = Read-Host ('  ' + (T '^?Arranco Pako solo cada vez que inicies sesi^on en Windows, sin ventana? [S/n]' 'Start Pako by itself each time you sign in to Windows, with no window? [Y/n]'))
      if ($answer -match '^\s*n') { $auto = '0' } else { $auto = '1' }
    }
    $autostart = Join-Path $dir 'src\autostart-windows.ts'
    $started = $false
    if ($auto -eq '1') {
      & $nodeExe --disable-warning=ExperimentalWarning $autostart enable
      if ($LASTEXITCODE -eq 0) {
        & $nodeExe --disable-warning=ExperimentalWarning $autostart start
        $started = ($LASTEXITCODE -eq 0)
      }
    }

    if ($started) {
      # Wait for it to listen: its lock holds its port (src/local.ts, lockHome), then bin/panel.cjs asks it for a link.
      $ready = $false
      for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Test-Path -LiteralPath $lockPath)) { continue }
        $lines = @(Get-Content -LiteralPath $lockPath)
        if ($lines.Count -lt 2 -or $lines[1] -notmatch '^\d+$') { continue }
        $client = New-Object System.Net.Sockets.TcpClient
        try { $ready = $client.ConnectAsync('127.0.0.1', [int]$lines[1]).Wait(300) } catch { $ready = $false } finally { $client.Dispose() }
      }
      if ($ready) {
        & $nodeExe (Join-Path $dir 'bin\panel.cjs')
        Say "Pako sigue en marcha aunque cierres esta ventana. Otro enlace al panel: cd `"$dir`"; npm run panel" "Pako keeps running if you close this window. Another link to the panel: cd `"$dir`"; npm run panel"
      } else {
        Say 'Pako tarda en arrancar. Mira qu^e dice en:' 'Pako is slow to start. See what it says in:'
        Write-Host ('      ' + (Join-Path $pakoHome 'logs\pako.err.log'))
      }
      Write-Host ''
      return
    }

    # ---- No autostart (or it could not be made): Pako runs in this window, which prints the panel's address and opens the browser.
    Say 'Pako se queda en marcha en esta ventana: si la cierras, se para. Para volver a arrancarlo: cd a su carpeta y npm start.' 'Pako runs in this window: closing it stops Pako. To start it again: cd to its folder and npm start.'
    Run-Native { & $npm start }
  } finally {
    Pop-Location
  }
}

Install-Pako

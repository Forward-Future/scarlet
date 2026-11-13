# Windows main launcher

The Windows shortcut verifies the installed app and engine locally and opens Scarlet immediately, including offline. A single background worker checks GitHub `main`, builds new commits in a private checkout, smoke-tests the engine, and stages a verified installer. It waits for the installed editor and engine to exit before applying the update. Reopening the shortcut while the worker is building brings Scarlet forward. If installation is already underway, the shortcut waits for it to finish.

Only first installation or repair requires a foreground build. A background build failure leaves the working installation available. The worker records its progress in `launch.log` and `status.txt` beside the launcher. Local installers skip compression to save packaging time and use more disk space in the build cache.

Use a regular 64-bit Windows PowerShell session in the repository root so the launcher goes into the same profile as the Start menu. Install the Windows desktop build tools, Git, standalone `pnpm.exe`, and Node at `%ProgramFiles%\nodejs\node.exe`. Git must have noninteractive read access to the Scarlet repository.

To transcribe on the GPU, also install the Vulkan SDK for all users, so `VULKAN_SDK` is set for the launcher, then reopen Scarlet. The next update includes the GPU build. Without the SDK the launcher builds Whisper for the CPU only and says so in `launch.log`. A GPU build that fails does not stop an update: it is left out and the update carries on.

```powershell
$source = Join-Path $PWD 'apps\desktop\scripts\windows-main-launcher'
$dest = Join-Path $env:LOCALAPPDATA 'ScarletMainLauncher'
$null = New-Item -ItemType Directory -Force -Path $dest
Copy-Item -LiteralPath (Join-Path $source 'update.mjs') -Destination $dest
@{
    git = (Get-Command git.exe -ErrorAction Stop).Source
    pnpm = (Get-Command pnpm.exe -ErrorAction Stop).Source
    cmake = (Get-Command cmake.exe -ErrorAction SilentlyContinue).Source
} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $dest 'tools.json')
$icon = Join-Path $PWD 'apps\desktop\src-tauri\icons\icon.ico'
$launcher = Join-Path $dest 'Scarlet.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /platform:x64 /optimize+ /r:System.Windows.Forms.dll /r:System.Drawing.dll "/win32icon:$icon" "/out:$launcher" (Join-Path $source 'Scarlet.cs')
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
$update = Start-Process -FilePath $launcher -ArgumentList '--prepare-only' -Wait -PassThru
if ($update.ExitCode -ne 0) { throw "See $dest\launch.log" }
```

Point the existing **Scarlet** Start menu shortcut and any Scarlet launch shortcuts at `%LOCALAPPDATA%\ScarletMainLauncher\Scarlet.exe`. Direct launches of the native executable bypass the update check. To verify the installation without opening or updating it, run the launcher with `--check-only` and check for exit code `0`.

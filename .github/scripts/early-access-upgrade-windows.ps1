param([string] $Previous, [string] $Candidate, [Parameter(Mandatory)] [string] $Version, [switch] $AsTestUser)
$ErrorActionPreference = 'Stop'

if ($AsTestUser) {
    # Start-Process -Credential can inherit the runner's environment. Use the loaded test account's profile.
    $env:PSModulePath = "$PSHOME\Modules"
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) { throw 'Expected a standard account.' }
    $profileKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $identity.User.Value
    $env:USERPROFILE = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty $profileKey).ProfileImagePath)
    $env:HOME = $env:USERPROFILE
    $env:USERNAME = ($identity.Name -split '\\')[-1]
    $env:USERDOMAIN = $env:COMPUTERNAME
    $env:APPDATA = Join-Path $env:USERPROFILE 'AppData\Roaming'
    $env:LOCALAPPDATA = Join-Path $env:USERPROFILE 'AppData\Local'
    $env:TEMP = $env:TMP = Join-Path $env:LOCALAPPDATA 'Temp'
    New-Item -ItemType Directory -Force -Path $env:TEMP,$env:APPDATA | Out-Null
    $uninstall = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Scarlet Early Access'
    $vendor = 'HKCU:\Software\Forward Future\Scarlet Early Access'
    $expectedPath = Join-Path $env:LOCALAPPDATA 'Scarlet Early Access'
    if ((Test-Path $uninstall) -or (Test-Path $expectedPath)) { throw 'The test profile already has Scarlet Early Access.' }

    function Install-And-Check($setup, $expectedVersion) {
        $process = Start-Process -FilePath $setup -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
        if ($process.ExitCode -ne 0) { throw "Setup exited $($process.ExitCode)." }
        $entry = Get-ItemProperty -LiteralPath $uninstall
        $location = $entry.InstallLocation.Trim('"')
        if ($entry.DisplayName -ne 'Scarlet Early Access' -or $entry.Publisher -ne 'Forward Future' -or
            $entry.DisplayVersion -ne $expectedVersion -or $location -ne $expectedPath -or
            (Get-Item -LiteralPath $vendor).GetValue('') -ne $expectedPath) { throw "Incorrect per-user installation for $expectedVersion at $location." }
        $engine = Join-Path $location 'scarlet-engine.exe'
        if (!(Test-Path -LiteralPath $engine -PathType Leaf)) { throw 'Missing installed engine.' }
        return $engine
    }

    $fixture = Join-Path $env:TEMP 'early-access-expected.json'
    foreach ($phase in 'seed','verify') {
        if ($phase -eq 'seed') {
            $engine = Install-And-Check "$PSScriptRoot\previous.exe" '0.1.3'
            $expectedEngine = '0dc7801de88876b67751f99b1e9b87335dd3e299601e72bdc1050c59de49f9ae'
        } else {
            $engine = Install-And-Check "$PSScriptRoot\candidate.exe" $Version
            $expectedEngine = Get-Content "$PSScriptRoot\candidate-engine-sha256.txt"
        }
        $hash = & "$PSScriptRoot\node.exe" -e "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))" $engine
        if ($LASTEXITCODE -ne 0 -or $hash -ne $expectedEngine) { throw "Setup left the wrong engine in place for $phase." }
        $installedVersion = (Get-ItemProperty -LiteralPath $uninstall).DisplayVersion
        Write-Host "Verified installed $installedVersion in $(Split-Path $engine), engine SHA-256 $hash."
        & "$PSScriptRoot\node.exe" "$PSScriptRoot\early-access-upgrade-library.mjs" $phase $engine $fixture
        if ($LASTEXITCODE -ne 0) { throw "Library $phase failed (exit $LASTEXITCODE)." }
    }
    exit 0
}

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Run this installer check on the disposable hosted Windows runner.' }
$suffix = [Guid]::NewGuid().ToString('N').Substring(0,12)
$name = "Scarlet$suffix"
$base = Join-Path $env:SystemDrive "ScarletEA-$suffix"
$scripts = Join-Path $PSScriptRoot '..\..\apps\desktop\scripts'
$password = ConvertTo-SecureString ([guid]::NewGuid().ToString('N') + 'bB9!') -AsPlainText -Force
$user = New-LocalUser -Name $name -Password $password -Description 'Disposable Early Access upgrade check'
try {
    $users = Get-LocalGroup -SID S-1-5-32-545
    if (!(Get-LocalGroupMember -Group $users.Name | Where-Object { $_.SID -eq $user.SID })) { Add-LocalGroupMember -Group $users.Name -Member $user }
    New-Item -ItemType Directory -Path $base | Out-Null
    Copy-Item -LiteralPath $Previous -Destination "$base\previous.exe"
    Copy-Item -LiteralPath $Candidate -Destination "$base\candidate.exe"
    Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination "$base\node.exe"
    Copy-Item -LiteralPath $PSCommandPath -Destination "$base\verify.ps1"
    $candidateEngine = Join-Path (Split-Path $env:BUNDLE) 'scarlet-engine.exe'
    (Get-FileHash -LiteralPath $candidateEngine -Algorithm SHA256).Hash | Set-Content "$base\candidate-engine-sha256.txt"
    foreach ($script in 'early-access-upgrade-library.mjs','early-access-product.mjs','smoke-engine-startup.mjs') {
        Copy-Item -LiteralPath (Join-Path $scripts $script) -Destination $base
    }
    $login = "$env:COMPUTERNAME\$name"
    icacls.exe $base /grant "${login}:(OI)(CI)(RX)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant the test account access to the payload.' }
    if ((Get-Service seclogon).Status -ne 'Running') { Start-Service seclogon }
    $argsForUser = @('-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',"$base\verify.ps1",'-AsTestUser','-Version',$Version)
    $shell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $worker = Start-Process $shell -Credential ([pscredential]::new($login,$password)) -LoadUserProfile -WorkingDirectory $base -WindowStyle Hidden -ArgumentList $argsForUser -PassThru -RedirectStandardOutput "$base\stdout.log" -RedirectStandardError "$base\stderr.log"
    if (!$worker.WaitForExit(360000)) { $worker.Kill(); throw 'The standard-account upgrade exceeded six minutes.' }
    $worker.WaitForExit()
    Get-Content "$base\stdout.log", "$base\stderr.log"
    if ($worker.ExitCode -ne 0) { throw "Standard-account upgrade failed with code $($worker.ExitCode)." }
} finally {
    Remove-LocalUser -Name $name
    Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue
}

[CmdletBinding()]
param(
    [string]$Release = $env:CODEX_RELEASE
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([string]::IsNullOrWhiteSpace($Release)) {
    $Release = "latest"
}

$NonInteractive = $env:CODEX_NON_INTERACTIVE -match "^(?i:1|true|yes)$"
$DefaultPreferReleasesOpenAICom = $true
$PreferReleasesOpenAICom = if ([string]::IsNullOrWhiteSpace($env:CODEX_INSTALLER_USE_RELEASES_OPENAI_COM)) {
    $DefaultPreferReleasesOpenAICom
} else {
    $env:CODEX_INSTALLER_USE_RELEASES_OPENAI_COM -match "^(?i:1|true|yes)$"
}
$ReleasesBaseUri = "https://releases.openai.com/codex"
$ReleasesMetadataTimeoutSec = 30
$ReleasesAssetTimeoutSec = 300

function Write-Step {
    param(
        [string]$Message
    )

    Write-Host "==> $Message"
}

function Write-WarningStep {
    param(
        [string]$Message
    )

    Write-Warning $Message
}

function Prompt-YesNo {
    param(
        [string]$Prompt
    )

    if ($NonInteractive) {
        return $false
    }

    if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
        return $false
    }

    $choice = Read-Host "$Prompt [y/N]"
    return $choice -match "^(?i:y(?:es)?)$"
}

function Normalize-Version {
    param(
        [string]$RawVersion
    )

    if ([string]::IsNullOrWhiteSpace($RawVersion) -or $RawVersion -eq "latest") {
        return "latest"
    }

    if ($RawVersion.StartsWith("rust-v")) {
        return $RawVersion.Substring(6)
    }

    if ($RawVersion.StartsWith("v")) {
        return $RawVersion.Substring(1)
    }

    return $RawVersion
}

function Assert-ValidReleaseVersion {
    param(
        [string]$Version
    )

    if ($Version -cne "latest" -and $Version -cnotmatch "^[0-9]+\.[0-9]+\.[0-9]+(?:-alpha(?:\.[0-9]+){0,2}|-beta(?:\.[0-9]+)?)?$") {
        throw "Invalid Codex release version: $Version. Expected latest or x.y.z[-alpha[.N[.M]]|-beta[.N]]."
    }
}

function Find-ReleaseAssetMetadata {
    param(
        [string]$AssetName,
        [object]$ReleaseMetadata,
        [string]$Url = $null,
        [string]$FallbackUrl = $null
    )

    $asset = $ReleaseMetadata.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
    if ($null -eq $asset) {
        return $null
    }

    $digestMatch = [regex]::Match([string]$asset.digest, "^sha256:([0-9a-fA-F]{64})$")
    if (-not $digestMatch.Success) {
        throw "Could not find SHA-256 digest for release asset $AssetName."
    }

    return [PSCustomObject]@{
        Url = if ([string]::IsNullOrWhiteSpace($Url)) { $asset.browser_download_url } else { $Url }
        FallbackUrl = $FallbackUrl
        Sha256 = $digestMatch.Groups[1].Value.ToLowerInvariant()
    }
}

function Invoke-WebRequestWithFallback {
    param(
        [object]$Metadata,
        [string]$OutFile,
        [string]$ExpectedDigest,
        [string]$AssetName,
        [string]$ReleaseVersion,
        [string]$RequiredManifestAsset
    )

    try {
        if ($Metadata.Url.StartsWith("$ReleasesBaseUri/", [System.StringComparison]::OrdinalIgnoreCase)) {
            Invoke-WebRequest -UseBasicParsing -Uri $Metadata.Url -OutFile $OutFile -TimeoutSec $ReleasesAssetTimeoutSec
        } else {
            Invoke-WebRequest -UseBasicParsing -Uri $Metadata.Url -OutFile $OutFile
        }
        Test-ArchiveDigest -ArchivePath $OutFile -ExpectedDigest $ExpectedDigest
        if (-not [string]::IsNullOrWhiteSpace($RequiredManifestAsset)) {
            $null = Get-PackageArchiveDigest -ManifestPath $OutFile -AssetName $RequiredManifestAsset
        }
    } catch {
        if ([string]::IsNullOrWhiteSpace($Metadata.FallbackUrl)) {
            throw
        }
        Write-WarningStep "Could not download or verify $($Metadata.Url); retrying from GitHub Releases."
        Invoke-WebRequest -UseBasicParsing -Uri $Metadata.FallbackUrl -OutFile $OutFile
        try {
            Test-ArchiveDigest -ArchivePath $OutFile -ExpectedDigest $ExpectedDigest
            if (-not [string]::IsNullOrWhiteSpace($RequiredManifestAsset)) {
                $null = Get-PackageArchiveDigest -ManifestPath $OutFile -AssetName $RequiredManifestAsset
            }
        } catch {
            $githubRelease = Resolve-ReleaseFromGitHub -NormalizedVersion $ReleaseVersion
            $githubAssetMetadata = Find-ReleaseAssetMetadata -AssetName $AssetName -ReleaseMetadata $githubRelease.Metadata
            if ($null -eq $githubAssetMetadata) {
                throw "Could not find GitHub release metadata for asset $AssetName."
            }
            Test-ArchiveDigest -ArchivePath $OutFile -ExpectedDigest $githubAssetMetadata.Sha256
            if (-not [string]::IsNullOrWhiteSpace($RequiredManifestAsset)) {
                $null = Get-PackageArchiveDigest -ManifestPath $OutFile -AssetName $RequiredManifestAsset
            }
        }
    }
}

function Resolve-ReleaseAssetSelection {
    param(
        [object]$ResolvedRelease,
        [string]$Target,
        [string]$NpmTag
    )

    $version = $ResolvedRelease.Version
    $releaseMetadata = $ResolvedRelease.Metadata
    $packageAsset = "codex-package-$Target.tar.gz"
    $checksumAsset = "codex-package_SHA256SUMS"
    $packageUrl = $null
    $packageFallbackUrl = $null
    $checksumUrl = $null
    $checksumFallbackUrl = $null
    if ($ResolvedRelease.Source -eq "ReleasesOpenAICom") {
        $packageUrl = "$ReleasesBaseUri/releases/$version/$packageAsset"
        $packageFallbackUrl = "https://github.com/openai/codex/releases/download/rust-v$version/$packageAsset"
        $checksumUrl = "$ReleasesBaseUri/releases/$version/$checksumAsset"
        $checksumFallbackUrl = "https://github.com/openai/codex/releases/download/rust-v$version/$checksumAsset"
    }

    $packageMetadata = Find-ReleaseAssetMetadata -AssetName $packageAsset -ReleaseMetadata $releaseMetadata -Url $packageUrl -FallbackUrl $packageFallbackUrl
    $checksumMetadata = Find-ReleaseAssetMetadata -AssetName $checksumAsset -ReleaseMetadata $releaseMetadata -Url $checksumUrl -FallbackUrl $checksumFallbackUrl
    if ($null -ne $packageMetadata -and $null -ne $checksumMetadata) {
        return [PSCustomObject]@{
            PackageAsset = $packageAsset
            PackageMetadata = $packageMetadata
            ChecksumMetadata = $checksumMetadata
            InstallLayout = "Package"
        }
    }

    $packageAsset = "codex-npm-$NpmTag-$version.tgz"
    $packageUrl = $null
    $packageFallbackUrl = $null
    if ($ResolvedRelease.Source -eq "ReleasesOpenAICom") {
        $packageUrl = "$ReleasesBaseUri/releases/$version/$packageAsset"
        $packageFallbackUrl = "https://github.com/openai/codex/releases/download/rust-v$version/$packageAsset"
    }
    $packageMetadata = Find-ReleaseAssetMetadata -AssetName $packageAsset -ReleaseMetadata $releaseMetadata -Url $packageUrl -FallbackUrl $packageFallbackUrl
    if ($null -eq $packageMetadata) {
        throw "Could not find Codex package or platform npm release assets for Codex $version."
    }

    return [PSCustomObject]@{
        PackageAsset = $packageAsset
        PackageMetadata = $packageMetadata
        ChecksumMetadata = $null
        InstallLayout = "LegacyPlatformNpm"
    }
}

function Test-ArchiveDigest {
    param(
        [string]$ArchivePath,
        [string]$ExpectedDigest
    )

    # A native launcher can pass PowerShell 7 module paths to Windows PowerShell,
    # preventing Get-FileHash from loading. Hash directly without module lookup.
    $providerPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ArchivePath)
    $sha256 = [System.Security.Cryptography.SHA256CryptoServiceProvider]::new()
    try {
        $stream = [System.IO.File]::OpenRead($providerPath)
        try {
            $actualDigest = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha256.Dispose()
    }

    if ($actualDigest -ne $ExpectedDigest) {
        throw "Downloaded Codex archive checksum did not match expected digest. Expected $ExpectedDigest but got $actualDigest."
    }
}

function Get-PackageArchiveDigest {
    param(
        [string]$ManifestPath,
        [string]$AssetName
    )

    $escapedAssetName = [regex]::Escape($AssetName)
    foreach ($line in Get-Content -LiteralPath $ManifestPath) {
        $match = [regex]::Match($line, "^\s*([0-9a-fA-F]{64})\s+$escapedAssetName\s*$")
        if ($match.Success) {
            return $match.Groups[1].Value.ToLowerInvariant()
        }
    }

    throw "Could not find SHA-256 digest for $AssetName in codex-package_SHA256SUMS."
}

function Path-Contains {
    param(
        [string]$PathValue,
        [string]$Entry
    )

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $false
    }

    $needle = $Entry.TrimEnd("\")
    foreach ($segment in $PathValue.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries)) {
        if ($segment.TrimEnd("\") -ieq $needle) {
            return $true
        }
    }

    return $false
}

function Prepend-PathEntry {
    param(
        [string]$PathValue,
        [string]$Entry
    )

    $needle = $Entry.TrimEnd("\")
    $segments = @($Entry)
    if (-not [string]::IsNullOrWhiteSpace($PathValue)) {
        $segments += $PathValue.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries) |
            Where-Object { $_.TrimEnd("\") -ine $needle }
    }

    return ($segments -join ";")
}

function Invoke-WithInstallLock {
    param(
        [string]$LockPath,
        [scriptblock]$Script
    )

    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LockPath) | Out-Null
    $lock = $null
    while ($null -eq $lock) {
        try {
            $lock = [System.IO.File]::Open(
                $LockPath,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
        } catch [System.IO.IOException] {
            Start-Sleep -Milliseconds 250
        }
    }
    try {
        & $Script
    } finally {
        $lock.Dispose()
    }
}

function Remove-StaleInstallArtifacts {
    param(
        [string]$ReleasesDir
    )

    if (Test-Path -LiteralPath $ReleasesDir -PathType Container) {
        Get-ChildItem -LiteralPath $ReleasesDir -Force -Directory -Filter ".staging.*" -ErrorAction SilentlyContinue |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-VersionFromReleaseMetadata {
    param(
        [object]$ReleaseMetadata
    )

    if (-not $ReleaseMetadata.tag_name) {
        throw "Failed to resolve the latest Codex release version."
    }

    $resolvedVersion = Normalize-Version -RawVersion $ReleaseMetadata.tag_name
    Assert-ValidReleaseVersion -Version $resolvedVersion
    return $resolvedVersion
}

function Resolve-ReleaseFromGitHub {
    param(
        [string]$NormalizedVersion
    )

    if ($NormalizedVersion -eq "latest") {
        $requestedRelease = "latest"
        $metadataUri = "https://api.github.com/repos/openai/codex/releases/latest"
    } else {
        $resolvedVersion = $NormalizedVersion
        $requestedRelease = $resolvedVersion
        $metadataUri = "https://api.github.com/repos/openai/codex/releases/tags/rust-v$resolvedVersion"
    }

    try {
        $releaseMetadata = Invoke-RestMethod -Uri $metadataUri
    } catch {
        throw "Could not fetch GitHub release metadata for Codex $requestedRelease. GitHub API may be unavailable or rate limited. $($_.Exception.Message)"
    }

    if ($NormalizedVersion -eq "latest") {
        $resolvedVersion = Resolve-VersionFromReleaseMetadata -ReleaseMetadata $releaseMetadata
    }

    return [PSCustomObject]@{
        Version = $resolvedVersion
        Metadata = $releaseMetadata
        Source = "GitHub"
    }
}

function Resolve-ReleaseFromReleases {
    param(
        [string]$NormalizedVersion
    )

    $metadataUri = if ($NormalizedVersion -eq "latest") {
        "$ReleasesBaseUri/channels/latest"
    } else {
        "$ReleasesBaseUri/releases/$NormalizedVersion/release.json"
    }
    try {
        $metadataResponse = Invoke-WebRequest -UseBasicParsing -Uri $metadataUri -TimeoutSec $ReleasesMetadataTimeoutSec
        $releaseMetadata = [string]$metadataResponse.Content | ConvertFrom-Json -ErrorAction Stop
        $resolvedVersion = Resolve-VersionFromReleaseMetadata -ReleaseMetadata $releaseMetadata
        if ($NormalizedVersion -ne "latest" -and $resolvedVersion -cne $NormalizedVersion) {
            throw "Release metadata version did not match requested Codex version $NormalizedVersion."
        }
        $resolvedRelease = [PSCustomObject]@{
            Version = $resolvedVersion
            Metadata = $releaseMetadata
            Source = "ReleasesOpenAICom"
        }
        $null = Resolve-ReleaseAssetSelection -ResolvedRelease $resolvedRelease -Target $target -NpmTag $npmTag
    } catch {
        return $null
    }
    return $resolvedRelease
}

function Resolve-Release {
    $normalizedVersion = Normalize-Version -RawVersion $Release
    Assert-ValidReleaseVersion -Version $normalizedVersion

    if ($PreferReleasesOpenAICom) {
        $release = Resolve-ReleaseFromReleases -NormalizedVersion $normalizedVersion
        if ($null -ne $release) {
            return $release
        }
        Write-WarningStep "releases.openai.com is unavailable; falling back to GitHub Releases."
    }

    return Resolve-ReleaseFromGitHub -NormalizedVersion $normalizedVersion
}

function Get-VersionFromBinary {
    param(
        [string]$CodexPath
    )

    if (-not (Test-Path -LiteralPath $CodexPath -PathType Leaf)) {
        return $null
    }

    try {
        $versionOutput = & $CodexPath --version 2>$null
    } catch {
        return $null
    }

    if ($versionOutput -match '([0-9][0-9A-Za-z.+-]*)$') {
        return $matches[1]
    }

    return $null
}

function Get-CurrentInstalledVersion {
    param(
        [string]$StandaloneCurrentDir
    )

    $standaloneVersion = Get-VersionFromBinary -CodexPath (Join-Path $StandaloneCurrentDir "bin\codex.exe")
    if (-not [string]::IsNullOrWhiteSpace($standaloneVersion)) {
        return $standaloneVersion
    }

    $standaloneVersion = Get-VersionFromBinary -CodexPath (Join-Path $StandaloneCurrentDir "codex.exe")
    if (-not [string]::IsNullOrWhiteSpace($standaloneVersion)) {
        return $standaloneVersion
    }

    return $null
}

function Test-OldStandaloneBinLayout {
    param(
        [string]$VisibleBinDir,
        [string]$DefaultVisibleBinDir
    )

    if (-not $VisibleBinDir.Equals($DefaultVisibleBinDir, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    if (-not (Test-Path -LiteralPath $VisibleBinDir -PathType Container)) {
        return $false
    }

    $item = Get-Item -LiteralPath $VisibleBinDir -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        return $false
    }

    $requiredFiles = @("codex.exe", "rg.exe")
    foreach ($fileName in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $VisibleBinDir $fileName) -PathType Leaf)) {
            return $false
        }
    }

    $knownFiles = @(
        "codex.exe",
        "rg.exe",
        "codex-command-runner.exe",
        "codex-windows-sandbox.exe",
        "codex-windows-sandbox-setup.exe"
    )
    foreach ($child in Get-ChildItem -LiteralPath $VisibleBinDir -Force) {
        if ($child.PSIsContainer) {
            return $false
        }
        if ($knownFiles -notcontains $child.Name) {
            return $false
        }
    }

    return $true
}

function Move-OldStandaloneBinIfApproved {
    param(
        [string]$VisibleBinDir,
        [string]$DefaultVisibleBinDir
    )

    if (-not (Test-OldStandaloneBinLayout -VisibleBinDir $VisibleBinDir -DefaultVisibleBinDir $DefaultVisibleBinDir)) {
        return $null
    }

    Write-Step "We found an older Codex install at $VisibleBinDir"
    Write-WarningStep "To continue, Codex needs to update the install at this path."
    if (-not (Prompt-YesNo "Replace it with the current Codex setup now?")) {
        throw "Cannot replace older standalone install without confirmation: $VisibleBinDir"
    }

    $backupDir = "$VisibleBinDir.backup.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()).$PID"
    Write-Step "Moving older standalone install to $backupDir"
    Move-Item -LiteralPath $VisibleBinDir -Destination $backupDir
    return $backupDir
}

function Add-JunctionSupportType {
    # Older installer types remain loaded when users rerun irm | iex in one session.
    if (([System.Management.Automation.PSTypeName]'CodexInstaller.JunctionV3').Type) {
        return
    }

    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace CodexInstaller
{
    public static class JunctionV3
    {
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint FILE_SHARE_DELETE = 0x00000004;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const uint FSCTL_SET_REPARSE_POINT = 0x000900A4;
        private const uint IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003;
        private const int HeaderLength = 20;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DeviceIoControl(
            SafeFileHandle hDevice,
            uint dwIoControlCode,
            byte[] lpInBuffer,
            int nInBufferSize,
            IntPtr lpOutBuffer,
            int nOutBufferSize,
            out int lpBytesReturned,
            IntPtr lpOverlapped);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle file, StringBuilder path, uint length, uint flags);

        // Read the journal entry for the junction itself, never the target.
        // Unlike a timestamp this changes on an in-place retarget, including away and back.
        public static string SelectionIdentity(string path)
        {
            using (SafeFileHandle handle = CreateFileW(
                path, 0x80, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                IntPtr.Zero, OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero))
            {
                if (handle.IsInvalid) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
                IntPtr buffer = Marshal.AllocHGlobal(1024);
                try {
                    int returned;
                    // No input requests USN_RECORD_V2. current's filename fits in 1024 bytes.
                    if (!DeviceIoControl(handle, 0x000900eb, null, 0, buffer, 1024, out returned, IntPtr.Zero)) {
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    }
                    long usn = Marshal.ReadInt64(buffer, 24);
                    if (returned < 32 || Marshal.ReadInt16(buffer, 4) != 2 || usn <= 0) {
                        throw new IOException("No reliable daemon selection journal record.");
                    }
                    return Marshal.ReadInt64(buffer, 8).ToString("x")
                        + " " + usn.ToString("x");
                } finally {
                    Marshal.FreeHGlobal(buffer);
                }
            }
        }

        public static string ResolveDirectory(string path)
        {
            using (SafeFileHandle handle = CreateFileW(
                path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero))
            {
                if (handle.IsInvalid) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
                StringBuilder resolved = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandleW(handle, resolved, (uint)resolved.Capacity, 0);
                if (length == 0) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
                if (length >= resolved.Capacity) { throw new IOException("Resolved path is too long."); }
                return resolved.ToString().TrimEnd('\\');
            }
        }

        public static void SetTarget(string linkPath, string targetPath)
        {
            string substituteName = "\\??\\" + Path.GetFullPath(targetPath);
            byte[] substituteNameBytes = Encoding.Unicode.GetBytes(substituteName);
            if (substituteNameBytes.Length > ushort.MaxValue - HeaderLength) {
                throw new ArgumentException("Junction target path is too long.", "targetPath");
            }

            byte[] reparseBuffer = new byte[substituteNameBytes.Length + HeaderLength];
            WriteUInt32(reparseBuffer, 0, IO_REPARSE_TAG_MOUNT_POINT);
            WriteUInt16(reparseBuffer, 4, checked((ushort)(substituteNameBytes.Length + 12)));
            WriteUInt16(reparseBuffer, 8, 0);
            WriteUInt16(reparseBuffer, 10, checked((ushort)substituteNameBytes.Length));
            WriteUInt16(reparseBuffer, 12, checked((ushort)(substituteNameBytes.Length + 2)));
            WriteUInt16(reparseBuffer, 14, 0);
            Buffer.BlockCopy(substituteNameBytes, 0, reparseBuffer, 16, substituteNameBytes.Length);

            using (SafeFileHandle handle = CreateFileW(
                linkPath,
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero))
            {
                if (handle.IsInvalid) {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }

                int bytesReturned;
                if (!DeviceIoControl(
                    handle,
                    FSCTL_SET_REPARSE_POINT,
                    reparseBuffer,
                    reparseBuffer.Length,
                    IntPtr.Zero,
                    0,
                    out bytesReturned,
                    IntPtr.Zero))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
        }

        private static void WriteUInt16(byte[] buffer, int offset, ushort value)
        {
            buffer[offset] = (byte)value;
            buffer[offset + 1] = (byte)(value >> 8);
        }

        private static void WriteUInt32(byte[] buffer, int offset, uint value)
        {
            buffer[offset] = (byte)value;
            buffer[offset + 1] = (byte)(value >> 8);
            buffer[offset + 2] = (byte)(value >> 16);
            buffer[offset + 3] = (byte)(value >> 24);
        }
    }
}
"@
}

function Set-JunctionTarget {
    param(
        [string]$LinkPath,
        [string]$TargetPath
    )

    Add-JunctionSupportType
    [CodexInstaller.JunctionV3]::SetTarget($LinkPath, $TargetPath)
}

function Test-IsJunction {
    param(
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    $item = Get-Item -LiteralPath $Path -Force
    return ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $item.LinkType -eq "Junction"
}

function Ensure-Junction {
    param(
        [string]$LinkPath,
        [string]$TargetPath,
        [string]$InstallerOwnedTargetPrefix
    )

    if (-not (Test-Path -LiteralPath $LinkPath)) {
        New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath | Out-Null
        return
    }

    $item = Get-Item -LiteralPath $LinkPath -Force
    if (Test-IsJunction -Path $LinkPath) {
        Add-JunctionSupportType
        $existingTarget = [CodexInstaller.JunctionV3]::ResolveDirectory($LinkPath)
        if (-not [string]::IsNullOrWhiteSpace($InstallerOwnedTargetPrefix)) {
            $ownedTargetPrefix = [CodexInstaller.JunctionV3]::ResolveDirectory($InstallerOwnedTargetPrefix) + "\"
            if (-not $existingTarget.StartsWith($ownedTargetPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to retarget junction at $LinkPath because it is not managed by this installer."
            }
        }
        if ($existingTarget.Equals([CodexInstaller.JunctionV3]::ResolveDirectory($TargetPath), [System.StringComparison]::OrdinalIgnoreCase)) {
            return
        }

        # Keep the path itself in place and only retarget the junction. That
        # avoids a gap where current or the visible bin path disappears during
        # an update.
        Set-JunctionTarget -LinkPath $LinkPath -TargetPath $TargetPath
        return
    }

    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to replace non-junction reparse point at $LinkPath."
    }

    if ($item.PSIsContainer) {
        if ((Get-ChildItem -LiteralPath $LinkPath -Force | Select-Object -First 1) -ne $null) {
            throw "Refusing to replace non-empty directory at $LinkPath with a junction."
        }

        Remove-Item -LiteralPath $LinkPath -Force
        New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath | Out-Null
        return
    }

    throw "Refusing to replace file at $LinkPath with a junction."
}

function Test-PackageContentsAreComplete {
    param(
        [string]$PackageDir
    )

    if (-not (Test-Path -LiteralPath $PackageDir -PathType Container)) {
        return $false
    }

    $expectedFiles = @(
        "codex-package.json",
        "bin\codex.exe",
        "bin\codex-code-mode-host.exe",
        "codex-path\rg.exe",
        "codex-resources\codex-command-runner.exe",
        "codex-resources\codex-windows-sandbox-setup.exe"
    )
    try {
        $metadataPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath((Join-Path $PackageDir "codex-package.json"))
        $metadata = [System.IO.File]::ReadAllText($metadataPath)
        # Older canonical packages do not advertise or contain the executor.
        if ([regex]::IsMatch($metadata, '"execServer"\s*:')) {
            $expectedFiles += "bin\codex-exec-server.exe"
        }
    } catch {
        return $false
    }
    foreach ($name in $expectedFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $PackageDir $name) -PathType Leaf)) {
            return $false
        }
    }

    return $true
}

function Test-LegacyPlatformNpmContentsAreComplete {
    param(
        [string]$PackageDir
    )

    if (-not (Test-Path -LiteralPath $PackageDir -PathType Container)) {
        return $false
    }

    $expectedFiles = @(
        "codex.exe",
        "codex-resources\codex-command-runner.exe",
        "codex-resources\codex-windows-sandbox-setup.exe",
        "codex-resources\rg.exe"
    )
    foreach ($name in $expectedFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $PackageDir $name) -PathType Leaf)) {
            return $false
        }
    }

    return $true
}

function Test-ReleaseIsComplete {
    param(
        [string]$ReleaseDir,
        [string]$ExpectedVersion,
        [string]$ExpectedTarget,
        [string]$Layout
    )

    switch ($Layout) {
        "Package" {
            if (-not (Test-PackageContentsAreComplete -PackageDir $ReleaseDir)) {
                return $false
            }
            $codexPath = Join-Path $ReleaseDir "bin\codex.exe"
        }
        "LegacyPlatformNpm" {
            if (-not (Test-LegacyPlatformNpmContentsAreComplete -PackageDir $ReleaseDir)) {
                return $false
            }
            $codexPath = Join-Path $ReleaseDir "codex.exe"
        }
        default {
            throw "Unknown Codex installer layout: $Layout"
        }
    }

    return (Split-Path -Leaf $ReleaseDir) -eq "$ExpectedVersion-$ExpectedTarget" -and
        (Get-VersionFromBinary -CodexPath $codexPath) -ceq $ExpectedVersion
}

function Get-ExistingCodexCommand {
    $existing = Get-Command codex -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        return $null
    }

    return $existing.Source
}

function Get-ExistingCodexManager {
    param(
        [string]$ExistingPath,
        [string]$VisibleBinDir
    )

    if ([string]::IsNullOrWhiteSpace($ExistingPath)) {
        return $null
    }

    if ($ExistingPath.StartsWith($VisibleBinDir, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }

    if ($ExistingPath -match "\\.bun\\") {
        return "bun"
    }

    if ($ExistingPath -match "node_modules" -or $ExistingPath -match "\\npm\\") {
        return "npm"
    }

    return $null
}

function Get-ConflictingInstall {
    param(
        [string]$VisibleBinDir
    )

    $existingPath = Get-ExistingCodexCommand
    $manager = Get-ExistingCodexManager -ExistingPath $existingPath -VisibleBinDir $VisibleBinDir
    if ($null -eq $manager) {
        return $null
    }

    Write-Step "Detected existing $manager-managed Codex at $existingPath"
    Write-WarningStep "Multiple managed Codex installs can be ambiguous because PATH order decides which one runs."

    return [PSCustomObject]@{
        Manager = $manager
        Path = $existingPath
    }
}

function Maybe-HandleConflictingInstall {
    param(
        [object]$Conflict
    )

    if ($null -eq $Conflict) {
        return
    }

    $manager = $Conflict.Manager

    $uninstallArgs = if ($manager -eq "bun") {
        @("remove", "-g", "@openai/codex")
    } else {
        @("uninstall", "-g", "@openai/codex")
    }
    $uninstallCommand = if ($manager -eq "bun") { "bun" } else { "npm" }

    if (Prompt-YesNo "Uninstall the existing $manager-managed Codex now?") {
        Write-Step "Running: $uninstallCommand $($uninstallArgs -join ' ')"
        try {
            & $uninstallCommand @uninstallArgs
        } catch {
            Write-WarningStep "Failed to uninstall the existing $manager-managed Codex. Continuing with the standalone install."
        }
    } else {
        Write-WarningStep "Leaving the existing $manager-managed Codex installed. PATH order will determine which codex runs."
    }
}

function Test-VisibleCodexCommand {
    param(
        [string]$VisibleBinDir
    )

    $codexCommand = Join-Path $VisibleBinDir "codex.exe"
    & $codexCommand --version *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Installed Codex command failed verification: $codexCommand --version"
    }
}

if ($env:OS -ne "Windows_NT") {
    Write-Error "install.ps1 supports Windows only. Use install.sh on macOS or Linux."
    exit 1
}

if (-not [Environment]::Is64BitOperatingSystem) {
    Write-Error "Codex requires a 64-bit version of Windows."
    exit 1
}

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$target = $null
$platformLabel = $null
$npmTag = $null
switch ($architecture) {
    "Arm64" {
        $target = "aarch64-pc-windows-msvc"
        $platformLabel = "Windows (ARM64)"
        $npmTag = "win32-arm64"
    }
    "X64" {
        $target = "x86_64-pc-windows-msvc"
        $platformLabel = "Windows (x64)"
        $npmTag = "win32-x64"
    }
    default {
        Write-Error "Unsupported architecture: $architecture"
        exit 1
    }
}

$codexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    Join-Path $env:USERPROFILE ".codex"
} else {
    $env:CODEX_HOME
}
$daemonOnly = $env:CODEX_INSTALL_DAEMON_ONLY -eq "1"
$standaloneRoot = Join-Path $codexHome $(if ($daemonOnly) { "packages\app-server-daemon" } else { "packages\standalone" })
$releasesDir = Join-Path $standaloneRoot "releases"
$currentDir = Join-Path $standaloneRoot "current"
$deferSelection = $env:CODEX_INSTALL_DEFER_SELECTION -eq "1"
if ($deferSelection) {
    if (-not $daemonOnly) { throw "Deferred selection requires a daemon-only installation." }
    $currentDir = Join-Path $standaloneRoot ".migration-current"
}
$autoUpdateVersion = Join-Path $standaloneRoot "auto-update-version"
$lockPath = Join-Path $standaloneRoot "install.lock"

$defaultVisibleBinDir = Join-Path $env:LOCALAPPDATA "Programs\OpenAI\Codex\bin"
if ([string]::IsNullOrWhiteSpace($env:CODEX_INSTALL_DIR)) {
    $visibleBinDir = $defaultVisibleBinDir
} else {
    $visibleBinDir = $env:CODEX_INSTALL_DIR
}

$currentVersion = Get-CurrentInstalledVersion -StandaloneCurrentDir $currentDir
$resolvedRelease = Resolve-Release
$resolvedVersion = $resolvedRelease.Version
$releaseMetadata = $resolvedRelease.Metadata
$releaseName = "$resolvedVersion-$target"
$releaseDir = Join-Path $releasesDir $releaseName

if (-not [string]::IsNullOrWhiteSpace($currentVersion) -and $currentVersion -ne $resolvedVersion) {
    Write-Step "Updating Codex CLI from $currentVersion to $resolvedVersion"
} elseif (-not [string]::IsNullOrWhiteSpace($currentVersion)) {
    Write-Step "Updating Codex CLI"
} else {
    Write-Step "Installing Codex CLI"
}
Write-Step "Detected platform: $platformLabel"
Write-Step "Resolved version: $resolvedVersion"

$conflictingInstall = if ($daemonOnly) { $null } else { Get-ConflictingInstall -VisibleBinDir $visibleBinDir }
$oldStandaloneBackup = $null

$checksumAsset = "codex-package_SHA256SUMS"
$assetSelection = Resolve-ReleaseAssetSelection -ResolvedRelease $resolvedRelease -Target $target -NpmTag $npmTag
$packageAsset = $assetSelection.PackageAsset
$packageMetadata = $assetSelection.PackageMetadata
$checksumMetadata = $assetSelection.ChecksumMetadata
$installLayout = $assetSelection.InstallLayout
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$guardRejected = $false

try {
    Invoke-WithInstallLock -LockPath $lockPath -Script {
        $updaterRecord = Join-Path $codexHome "app-server-daemon\app-server-updater.pid"
        if ($daemonOnly) { $updaterRecord = Join-Path $codexHome "app-server-daemon\daemon-updater.pid" }
        $oldUpdaterParent = $false
        if ($Release -eq "latest" -and $env:CODEX_INSTALL_IF_LATEST -ne "1" -and $env:CODEX_INSTALL_IF_CURRENT -ne "1" -and (Test-Path -LiteralPath $updaterRecord)) {
            $updaterPid = $null
            $updaterStartTime = $null
            try {
                $record = Get-Content -LiteralPath $updaterRecord -Raw | ConvertFrom-Json
                $updaterPid = [long]$record.pid
                $updaterStartTime = [string]$record.processStartTime
            } catch {
                # Empty or stale PID reservations must not block a manual install.
            }
            if ($null -ne $updaterPid -and $updaterPid -gt 0 -and -not [string]::IsNullOrEmpty($updaterStartTime)) {
                $updaterProcess = Get-Process -Id $updaterPid -ErrorAction SilentlyContinue
                if ($null -ne $updaterProcess -and $updaterStartTime -eq [string]$updaterProcess.StartTime.ToFileTimeUtc()) {
                    try {
                        $parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop).ParentProcessId
                        if ([long]$parentPid -le 0) { throw "Missing updater parent process." }
                    } catch {
                        try {
                            $parentPid = (Get-WmiObject Win32_Process -Filter "ProcessId = $PID" -ErrorAction Stop).ParentProcessId
                            if ([long]$parentPid -le 0) { throw "Missing updater parent process." }
                        } catch {
                            throw "Cannot verify whether the standalone installer was launched by an older updater."
                        }
                    }
                    $oldUpdaterParent = $updaterPid -eq $parentPid
                }
            }
        }
        if ($env:CODEX_INSTALL_IF_LATEST -eq "1" -or $env:CODEX_INSTALL_IF_CURRENT -eq "1" -or $oldUpdaterParent) {
            $previousRelease = if ($oldUpdaterParent -and (Test-Path -LiteralPath $autoUpdateVersion)) {
                [System.IO.File]::ReadAllText($autoUpdateVersion)
            } else {
                $env:CODEX_UPDATE_FROM_RELEASE
            }
            Add-JunctionSupportType
            $currentTarget = if (Test-Path -LiteralPath $currentDir) { (Get-Item -LiteralPath $currentDir).Target } else { $null }
            if ($Release -ne "latest" -or [string]::IsNullOrEmpty($previousRelease) -or [string]::IsNullOrEmpty($currentTarget) -or
                -not (Test-Path -LiteralPath (Join-Path $releasesDir $previousRelease)) -or
                [CodexInstaller.JunctionV3]::ResolveDirectory($currentDir) -ne [CodexInstaller.JunctionV3]::ResolveDirectory((Join-Path $releasesDir $previousRelease))) {
                if ($env:CODEX_INSTALL_IF_CURRENT -eq "1") { throw "Daemon selection changed; retry the update." }
                $script:guardRejected = $true
                return
            }
            # Explicit daemon updates may leave a local or pinned release.
            if ($env:CODEX_INSTALL_IF_CURRENT -ne "1" -and
                (-not (Test-Path -LiteralPath $autoUpdateVersion) -or
                [System.IO.File]::ReadAllText($autoUpdateVersion) -cne $previousRelease)) {
                $script:guardRejected = $true
                return
            }
        }
        Remove-StaleInstallArtifacts -ReleasesDir $releasesDir

        if (-not (Test-ReleaseIsComplete -ReleaseDir $releaseDir -ExpectedVersion $resolvedVersion -ExpectedTarget $target -Layout $installLayout)) {
            if (Test-Path -LiteralPath $releaseDir) {
                if ($daemonOnly) { throw "Refusing to overwrite existing daemon release $releaseDir." }
                Write-WarningStep "Found incomplete existing release at $releaseDir. Reinstalling."
            }

            $archivePath = Join-Path $tempDir $packageAsset
            $checksumPath = Join-Path $tempDir $checksumAsset
            $stagingDir = Join-Path $releasesDir ".staging.$releaseName.$PID"

            Write-Step "Downloading Codex CLI"
            if ($installLayout -eq "Package") {
                Invoke-WebRequestWithFallback -Metadata $checksumMetadata -OutFile $checksumPath -ExpectedDigest $checksumMetadata.Sha256 -AssetName $checksumAsset -ReleaseVersion $resolvedVersion -RequiredManifestAsset $packageAsset
                $expectedPackageDigest = Get-PackageArchiveDigest -ManifestPath $checksumPath -AssetName $packageAsset
            } else {
                $expectedPackageDigest = $packageMetadata.Sha256
            }
            Invoke-WebRequestWithFallback -Metadata $packageMetadata -OutFile $archivePath -ExpectedDigest $expectedPackageDigest -AssetName $packageAsset -ReleaseVersion $resolvedVersion

            New-Item -ItemType Directory -Force -Path $releasesDir | Out-Null
            if (Test-Path -LiteralPath $stagingDir) {
                Remove-Item -LiteralPath $stagingDir -Recurse -Force
            }
            New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null
            if ($installLayout -eq "Package") {
                tar -xzf $archivePath -C $stagingDir
                if (-not (Test-PackageContentsAreComplete -PackageDir $stagingDir)) {
                    throw "Downloaded Codex package archive did not contain the expected package layout."
                }
            } else {
                $extractDir = Join-Path $tempDir "extract"
                New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
                tar -xzf $archivePath -C $extractDir

                $vendorRoot = Join-Path $extractDir "package/vendor/$target"
                $resourcesDir = Join-Path $stagingDir "codex-resources"
                New-Item -ItemType Directory -Force -Path $resourcesDir | Out-Null
                $copyMap = @{
                    "codex/codex.exe" = "codex.exe"
                    "codex/codex-command-runner.exe" = "codex-resources\codex-command-runner.exe"
                    "codex/codex-windows-sandbox-setup.exe" = "codex-resources\codex-windows-sandbox-setup.exe"
                    "path/rg.exe" = "codex-resources\rg.exe"
                }

                foreach ($relativeSource in $copyMap.Keys) {
                    Copy-Item -LiteralPath (Join-Path $vendorRoot $relativeSource) -Destination (Join-Path $stagingDir $copyMap[$relativeSource])
                }

                if (-not (Test-LegacyPlatformNpmContentsAreComplete -PackageDir $stagingDir)) {
                    throw "Downloaded Codex npm archive did not contain the expected legacy platform package layout."
                }
            }

            if (Test-Path -LiteralPath $releaseDir) {
                Remove-Item -LiteralPath $releaseDir -Recurse -Force
            }
            Move-Item -LiteralPath $stagingDir -Destination $releaseDir
        }

        if (-not (Test-ReleaseIsComplete -ReleaseDir $releaseDir -ExpectedVersion $resolvedVersion -ExpectedTarget $target -Layout $installLayout)) {
            throw "Installed Codex command did not report expected version $resolvedVersion."
        }

        New-Item -ItemType Directory -Force -Path $standaloneRoot | Out-Null
        if ($deferSelection -and (Get-Item -LiteralPath (Join-Path $standaloneRoot "current") -Force -ErrorAction SilentlyContinue)) {
            throw "A dedicated daemon is already selected; retry the update."
        }
        if ($daemonOnly -and -not $deferSelection) {
            $installedCodex = Join-Path $releaseDir $(if ($installLayout -eq "Package") { "bin\codex.exe" } else { "codex.exe" })
            & $installedCodex app-server daemon pid-update-loop --check-package-ownership | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "The production release does not support daemon-owned packages; the current selection was left unchanged."
            }
        }
        $previousDirectory = $null
        if ($daemonOnly -and -not $deferSelection) {
            Add-JunctionSupportType
            if (Test-Path -LiteralPath $currentDir) {
                $previousDirectory = [CodexInstaller.JunctionV3]::ResolveDirectory($currentDir)
            }
        }
        Ensure-Junction -LinkPath $currentDir -TargetPath $releaseDir -InstallerOwnedTargetPrefix $releasesDir
        if ($daemonOnly -and -not $deferSelection -and
            $previousDirectory -cne [CodexInstaller.JunctionV3]::ResolveDirectory($currentDir)) {
            try {
                $previousName = if ($null -eq $previousDirectory) { "" } else { Split-Path -Leaf $previousDirectory }
                $selectionId = [CodexInstaller.JunctionV3]::SelectionIdentity($currentDir)
                $history = Join-Path $standaloneRoot "selection-history"
                [System.IO.File]::WriteAllText("$history.tmp.$PID", "$releaseName`n$previousName`n$selectionId`n")
                Move-Item -LiteralPath "$history.tmp.$PID" -Destination $history -Force -ErrorAction Stop
            } catch {
                Write-WarningStep "Could not record daemon selection; pruning will be skipped."
            }
        }
        if ($Release -eq "latest") {
            $tempMarker = "$autoUpdateVersion.tmp.$PID"
            [System.IO.File]::WriteAllText($tempMarker, $releaseName)
            Move-Item -LiteralPath $tempMarker -Destination $autoUpdateVersion -Force
        } else {
            if (Test-Path -LiteralPath $autoUpdateVersion) {
                Remove-Item -LiteralPath $autoUpdateVersion -Force -ErrorAction Stop
            }
        }

        if ($daemonOnly) { return }
        $visibleParent = Split-Path -Parent $visibleBinDir
        $currentBinDir = if ($installLayout -eq "Package") {
            Join-Path $currentDir "bin"
        } else {
            $currentDir
        }
        New-Item -ItemType Directory -Force -Path $visibleParent | Out-Null
        $oldStandaloneBackup = Move-OldStandaloneBinIfApproved -VisibleBinDir $visibleBinDir -DefaultVisibleBinDir $defaultVisibleBinDir
        try {
            Ensure-Junction -LinkPath $visibleBinDir -TargetPath $currentBinDir -InstallerOwnedTargetPrefix $standaloneRoot
            Test-VisibleCodexCommand -VisibleBinDir $visibleBinDir
        } catch {
            if ($null -ne $oldStandaloneBackup -and (Test-Path -LiteralPath $oldStandaloneBackup)) {
                if (Test-Path -LiteralPath $visibleBinDir) {
                    Remove-Item -LiteralPath $visibleBinDir -Recurse -Force
                }
                Move-Item -LiteralPath $oldStandaloneBackup -Destination $visibleBinDir
            }
            throw
        }
        if ($null -ne $oldStandaloneBackup) {
            Remove-Item -LiteralPath $oldStandaloneBackup -Recurse -Force
        }
    }
} finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}
if ($guardRejected -or $daemonOnly) { return }

Maybe-HandleConflictingInstall -Conflict $conflictingInstall

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$prioritizeVisibleBin = $null -ne $conflictingInstall
if ($prioritizeVisibleBin) {
    $newUserPath = Prepend-PathEntry -PathValue $userPath -Entry $visibleBinDir
    if ($newUserPath -cne $userPath) {
        [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
        Write-Step "PATH updated for future PowerShell sessions."
    } else {
        Write-Step "$visibleBinDir is already first on PATH."
    }
} elseif (-not (Path-Contains -PathValue $userPath -Entry $visibleBinDir)) {
    if ([string]::IsNullOrWhiteSpace($userPath)) {
        $newUserPath = $visibleBinDir
    } else {
        $newUserPath = "$visibleBinDir;$userPath"
    }

    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    Write-Step "PATH updated for future PowerShell sessions."
} elseif (Path-Contains -PathValue $env:Path -Entry $visibleBinDir) {
    Write-Step "$visibleBinDir is already on PATH."
} else {
    Write-Step "PATH is already configured for future PowerShell sessions."
}

if ($prioritizeVisibleBin) {
    $env:Path = Prepend-PathEntry -PathValue $env:Path -Entry $visibleBinDir
} elseif (-not (Path-Contains -PathValue $env:Path -Entry $visibleBinDir)) {
    if ([string]::IsNullOrWhiteSpace($env:Path)) {
        $env:Path = $visibleBinDir
    } else {
        $env:Path = "$visibleBinDir;$env:Path"
    }
}

Write-Step "Current PowerShell session: codex"
Write-Step "Future PowerShell windows: open a new PowerShell window and run: codex"
Write-Host "Codex CLI $resolvedVersion installed successfully."

$codexCommand = Join-Path $visibleBinDir "codex.exe"
if (Prompt-YesNo "Start Codex now?") {
    Write-Step "Launching Codex"
    & $codexCommand
}

# SIG # Begin signature block
# MII9OwYJKoZIhvcNAQcCoII9LDCCPSgCAQExDzANBglghkgBZQMEAgEFADB5Bgor
# BgEEAYI3AgEEoGswaTA0BgorBgEEAYI3AgEeMCYCAwEAAAQQH8w7YFlLCE63JNLG
# KX7zUQIBAAIBAAIBAAIBAAIBADAxMA0GCWCGSAFlAwQCAQUABCB4ncvH+oAu0M7x
# ziEHjWoFjlesg/Db3ok3Ua0bkqHC26CCIgAwggXMMIIDtKADAgECAhBUmNLR1FsZ
# lUgTecgRwIeZMA0GCSqGSIb3DQEBDAUAMHcxCzAJBgNVBAYTAlVTMR4wHAYDVQQK
# ExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xSDBGBgNVBAMTP01pY3Jvc29mdCBJZGVu
# dGl0eSBWZXJpZmljYXRpb24gUm9vdCBDZXJ0aWZpY2F0ZSBBdXRob3JpdHkgMjAy
# MDAeFw0yMDA0MTYxODM2MTZaFw00NTA0MTYxODQ0NDBaMHcxCzAJBgNVBAYTAlVT
# MR4wHAYDVQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xSDBGBgNVBAMTP01pY3Jv
# c29mdCBJZGVudGl0eSBWZXJpZmljYXRpb24gUm9vdCBDZXJ0aWZpY2F0ZSBBdXRo
# b3JpdHkgMjAyMDCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBALORKgeD
# Bmf9np3gx8C3pOZCBH8Ppttf+9Va10Wg+3cL8IDzpm1aTXlT2KCGhFdFIMeiVPvH
# or+Kx24186IVxC9O40qFlkkN/76Z2BT2vCcH7kKbK/ULkgbk/WkTZaiRcvKYhOuD
# PQ7k13ESSCHLDe32R0m3m/nJxxe2hE//uKya13NnSYXjhr03QNAlhtTetcJtYmrV
# qXi8LW9J+eVsFBT9FMfTZRY33stuvF4pjf1imxUs1gXmuYkyM6Nix9fWUmcIxC70
# ViueC4fM7Ke0pqrrBc0ZV6U6CwQnHJFnni1iLS8evtrAIMsEGcoz+4m+mOJyoHI1
# vnnhnINv5G0Xb5DzPQCGdTiO0OBJmrvb0/gwytVXiGhNctO/bX9x2P29Da6SZEi3
# W295JrXNm5UhhNHvDzI9e1eM80UHTHzgXhgONXaLbZ7LNnSrBfjgc10yVpRnlyUK
# xjU9lJfnwUSLgP3B+PR0GeUw9gb7IVc+BhyLaxWGJ0l7gpPKWeh1R+g/OPTHU3mg
# trTiXFHvvV84wRPmeAyVWi7FQFkozA8kwOy6CXcjmTimthzax7ogttc32H83rwjj
# O3HbbnMbfZlysOSGM1l0tRYAe1BtxoYT2v3EOYI9JACaYNq6lMAFUSw0rFCZE4e7
# swWAsk0wAly4JoNdtGNz764jlU9gKL431VulAgMBAAGjVDBSMA4GA1UdDwEB/wQE
# AwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBTIftJqhSobyhmYBAcnz1AQ
# T2ioojAQBgkrBgEEAYI3FQEEAwIBADANBgkqhkiG9w0BAQwFAAOCAgEAr2rd5hnn
# LZRDGU7L6VCVZKUDkQKL4jaAOxWiUsIWGbZqWl10QzD0m/9gdAmxIR6QFm3FJI9c
# Zohj9E/MffISTEAQiwGf2qnIrvKVG8+dBetJPnSgaFvlVixlHIJ+U9pW2UYXeZJF
# xBA2CFIpF8svpvJ+1Gkkih6PsHMNzBxKq7Kq7aeRYwFkIqgyuH4yKLNncy2RtNwx
# AQv3Rwqm8ddK7VZgxCwIo3tAsLx0J1KH1r6I3TeKiW5niB31yV2g/rarOoDXGpc8
# FzYiQR6sTdWD5jw4vU8w6VSp07YEwzJ2YbuwGMUrGLPAgNW3lbBeUU0i/OxYqujY
# lLSlLu2S3ucYfCFX3VVj979tzR/SpncocMfiWzpbCNJbTsgAlrPhgzavhgplXHT2
# 6ux6anSg8Evu75SjrFDyh+3XOjCDyft9V77l4/hByuVkrrOj7FjshZrM77nq81YY
# uVxzmq/FdxeDWds3GhhyVKVB0rYjdaNDmuV3fJZ5t0GNv+zcgKCf0Xd1WF81E+Al
# GmcLfc4l+gcK5GEh2NQc5QfGNpn0ltDGFf5Ozdeui53bFv0ExpK91IjmqaOqu/dk
# ODtfzAzQNb50GQOmxapMomE2gj4d8yu8l13bS3g7LfU772Aj6PXsCyM2la+YZr9T
# 03u4aUoqlmZpxJTG9F9urJh4iIAGXKKy7aIwggatMIIElaADAgECAhMzAAqfKX1g
# qK9tJL7cAAAACp8pMA0GCSqGSIb3DQEBDAUAMFoxCzAJBgNVBAYTAlVTMR4wHAYD
# VQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xKzApBgNVBAMTIk1pY3Jvc29mdCBJ
# RCBWZXJpZmllZCBDUyBFT0MgQ0EgMDQwHhcNMjYxMTE4MjE1NzEyWhcNMjYxMTIx
# MjE1NzEyWjBwMQswCQYDVQQGEwJVUzETMBEGA1UECBMKQ2FsaWZvcm5pYTEWMBQG
# A1UEBxMNU2FuIEZyYW5jaXNjbzEZMBcGA1UEChMQT3BlbkFJIE9wQ28sIExMQzEZ
# MBcGA1UEAxMQT3BlbkFJIE9wQ28sIExMQzCCAaIwDQYJKoZIhvcNAQEBBQADggGP
# ADCCAYoCggGBAJhGvEU4Jn0qRdoPNllOlhpD/WJ0f8YBbHjtwRII72sT+kA2o18s
# /tOyRJezfjt7st/cNV7tx1eZ5dOQDjeT3kCIzNKaZPuRoeHNmziuIohyn+vVs+Pd
# qRWusI+8dif9pu6vcl5MJy3GBNyIF2XNr8zetOMifkG2xSNxRJ3jSN6gkn1l31ML
# gA2Aw3yqSeEsvqhvme6We0/zZ/GJJg4cgzAXedgzgVXAsH5IX9k7BxmxcnaUU7yA
# zDfpzrQV6pURWmFoC6Z95p8Tnm70tvX03QViyCTpg1WomNDQ7SFubUAagNx9uCYF
# rCU9Cfd9pkNcJg5ECQa6YpyIkIeQPdMyUti77ZYYQINYLi5Ql8JN8yX0DA7uYy50
# VYedeAKAQVRUn8H6lj/P+5YQLmqU1eODzB37SwHJvn55R3FTDpxsn5rAlcvSy9uZ
# grGTVJX6x4gp3Jr9E+iMVjbadO/vtFgJaqSwpw+r3qk1Y9zwLs0JS9Nl/IFhtlz2
# RwxwwsXyd5Vd7wIDAQABo4IB1DCCAdAwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8E
# BAMCB4AwOwYDVR0lBDQwMgYKKwYBBAGCN2EBAAYIKwYBBQUHAwMGGisGAQQBgjdh
# kLSmdILG8u8FgtbC+HXA0usHMB0GA1UdDgQWBBT/EaQYp0vzGAmQ40uKslwlxkVU
# djAfBgNVHSMEGDAWgBSa8VR3dQyHFjdGoKzeefn0f8F46TBnBgNVHR8EYDBeMFyg
# WqBYhlZodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtpb3BzL2NybC9NaWNyb3Nv
# ZnQlMjBJRCUyMFZlcmlmaWVkJTIwQ1MlMjBFT0MlMjBDQSUyMDA0LmNybDB0Bggr
# BgEFBQcBAQRoMGYwZAYIKwYBBQUHMAKGWGh0dHA6Ly93d3cubWljcm9zb2Z0LmNv
# bS9wa2lvcHMvY2VydHMvTWljcm9zb2Z0JTIwSUQlMjBWZXJpZmllZCUyMENTJTIw
# RU9DJTIwQ0ElMjAwNC5jcnQwVAYDVR0gBE0wSzBJBgRVHSAAMEEwPwYIKwYBBQUH
# AgEWM2h0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvRG9jcy9SZXBvc2l0
# b3J5Lmh0bTANBgkqhkiG9w0BAQwFAAOCAgEAZfkUsl1F/Z/kq78x1nzyBqZoWce0
# B43RgSZhL56q6Nzoni9DavoFSXYBjarAPX1OFjk33+wrMV9W/+TvSXVuOgvDkUvI
# fSZI8C1ZWyj76Q6LZOnbggw0ZAR74ejick+6jP4QEFsyT0OM6OiyJHMlg8/Qg2Xn
# Z4gjwPwzy/mRh/sTwfoKkR5CTnf2/ErwwMDxypLYDz9uRh3lTGzkiK+pacPAWxjD
# IW8tcAFuRMsl6xCnSeGEEA+rvqHLGQZmzVSsAvrla2R3cHMWQP6KnKpYHz3VNuk8
# lR5e09K8pcgABNs4bRJdkV9IDfS/LGjZ/asn5+EywlafMluNM8qee/k5rzSbOvs8
# JOg2WcAsA5EYIvelDsBodITu8VB3cNryUHlM5DfdmRpEHpApECRFeevTkFuXGijl
# qut66ShZ0mv7QIt+EuQnsU/mL3SYGxS7Hn7uZ0N7ZlZDwH6Z8LzaGfS19GtE542A
# Ch7kvvNkaqWoaEvx4RCNx3KYgfJq1+6Q9A9hEbZup617wsG/kwdNueZElIpMF6Uz
# 2q/EadWi8qY1gDrsI4BOy2XGHcY5ABKFi2hB+JAhkGC6Esv4X7YRSuHdTpo2LNAa
# JNyqtlGTDyrnSwzuXnZvCaVnQeHD08WKSmQ1QNQJ33IX3pVxNEu8qNYKky9dBAhw
# n+nhbWQ1UewSr+wwggatMIIElaADAgECAhMzAAqfKX1gqK9tJL7cAAAACp8pMA0G
# CSqGSIb3DQEBDAUAMFoxCzAJBgNVBAYTAlVTMR4wHAYDVQQKExVNaWNyb3NvZnQg
# Q29ycG9yYXRpb24xKzApBgNVBAMTIk1pY3Jvc29mdCBJRCBWZXJpZmllZCBDUyBF
# T0MgQ0EgMDQwHhcNMjYxMTE4MjE1NzEyWhcNMjYxMTIxMjE1NzEyWjBwMQswCQYD
# VQQGEwJVUzETMBEGA1UECBMKQ2FsaWZvcm5pYTEWMBQGA1UEBxMNU2FuIEZyYW5j
# aXNjbzEZMBcGA1UEChMQT3BlbkFJIE9wQ28sIExMQzEZMBcGA1UEAxMQT3BlbkFJ
# IE9wQ28sIExMQzCCAaIwDQYJKoZIhvcNAQEBBQADggGPADCCAYoCggGBAJhGvEU4
# Jn0qRdoPNllOlhpD/WJ0f8YBbHjtwRII72sT+kA2o18s/tOyRJezfjt7st/cNV7t
# x1eZ5dOQDjeT3kCIzNKaZPuRoeHNmziuIohyn+vVs+PdqRWusI+8dif9pu6vcl5M
# Jy3GBNyIF2XNr8zetOMifkG2xSNxRJ3jSN6gkn1l31MLgA2Aw3yqSeEsvqhvme6W
# e0/zZ/GJJg4cgzAXedgzgVXAsH5IX9k7BxmxcnaUU7yAzDfpzrQV6pURWmFoC6Z9
# 5p8Tnm70tvX03QViyCTpg1WomNDQ7SFubUAagNx9uCYFrCU9Cfd9pkNcJg5ECQa6
# YpyIkIeQPdMyUti77ZYYQINYLi5Ql8JN8yX0DA7uYy50VYedeAKAQVRUn8H6lj/P
# +5YQLmqU1eODzB37SwHJvn55R3FTDpxsn5rAlcvSy9uZgrGTVJX6x4gp3Jr9E+iM
# VjbadO/vtFgJaqSwpw+r3qk1Y9zwLs0JS9Nl/IFhtlz2RwxwwsXyd5Vd7wIDAQAB
# o4IB1DCCAdAwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwOwYDVR0lBDQw
# MgYKKwYBBAGCN2EBAAYIKwYBBQUHAwMGGisGAQQBgjdhkLSmdILG8u8FgtbC+HXA
# 0usHMB0GA1UdDgQWBBT/EaQYp0vzGAmQ40uKslwlxkVUdjAfBgNVHSMEGDAWgBSa
# 8VR3dQyHFjdGoKzeefn0f8F46TBnBgNVHR8EYDBeMFygWqBYhlZodHRwOi8vd3d3
# Lm1pY3Jvc29mdC5jb20vcGtpb3BzL2NybC9NaWNyb3NvZnQlMjBJRCUyMFZlcmlm
# aWVkJTIwQ1MlMjBFT0MlMjBDQSUyMDA0LmNybDB0BggrBgEFBQcBAQRoMGYwZAYI
# KwYBBQUHMAKGWGh0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvY2VydHMv
# TWljcm9zb2Z0JTIwSUQlMjBWZXJpZmllZCUyMENTJTIwRU9DJTIwQ0ElMjAwNC5j
# cnQwVAYDVR0gBE0wSzBJBgRVHSAAMEEwPwYIKwYBBQUHAgEWM2h0dHA6Ly93d3cu
# bWljcm9zb2Z0LmNvbS9wa2lvcHMvRG9jcy9SZXBvc2l0b3J5Lmh0bTANBgkqhkiG
# 9w0BAQwFAAOCAgEAZfkUsl1F/Z/kq78x1nzyBqZoWce0B43RgSZhL56q6Nzoni9D
# avoFSXYBjarAPX1OFjk33+wrMV9W/+TvSXVuOgvDkUvIfSZI8C1ZWyj76Q6LZOnb
# ggw0ZAR74ejick+6jP4QEFsyT0OM6OiyJHMlg8/Qg2XnZ4gjwPwzy/mRh/sTwfoK
# kR5CTnf2/ErwwMDxypLYDz9uRh3lTGzkiK+pacPAWxjDIW8tcAFuRMsl6xCnSeGE
# EA+rvqHLGQZmzVSsAvrla2R3cHMWQP6KnKpYHz3VNuk8lR5e09K8pcgABNs4bRJd
# kV9IDfS/LGjZ/asn5+EywlafMluNM8qee/k5rzSbOvs8JOg2WcAsA5EYIvelDsBo
# dITu8VB3cNryUHlM5DfdmRpEHpApECRFeevTkFuXGijlqut66ShZ0mv7QIt+EuQn
# sU/mL3SYGxS7Hn7uZ0N7ZlZDwH6Z8LzaGfS19GtE542ACh7kvvNkaqWoaEvx4RCN
# x3KYgfJq1+6Q9A9hEbZup617wsG/kwdNueZElIpMF6Uz2q/EadWi8qY1gDrsI4BO
# y2XGHcY5ABKFi2hB+JAhkGC6Esv4X7YRSuHdTpo2LNAaJNyqtlGTDyrnSwzuXnZv
# CaVnQeHD08WKSmQ1QNQJ33IX3pVxNEu8qNYKky9dBAhwn+nhbWQ1UewSr+wwggco
# MIIFEKADAgECAhMzAAAAFydFCQuLh6/GAAAAAAAXMA0GCSqGSIb3DQEBDAUAMGMx
# CzAJBgNVBAYTAlVTMR4wHAYDVQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xNDAy
# BgNVBAMTK01pY3Jvc29mdCBJRCBWZXJpZmllZCBDb2RlIFNpZ25pbmcgUENBIDIw
# MjEwHhcNMjYwMzI2MTgxMTMxWhcNMzEwMzI2MTgxMTMxWjBaMQswCQYDVQQGEwJV
# UzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMSswKQYDVQQDEyJNaWNy
# b3NvZnQgSUQgVmVyaWZpZWQgQ1MgRU9DIENBIDA0MIICIjANBgkqhkiG9w0BAQEF
# AAOCAg8AMIICCgKCAgEAgsdk/gMPZioBlcyfk6tDzJ+PRt4rSLGKW8ewpS0kRxXt
# URC3T3GdbCKljobEn8ussqhGqQpRh/SXvRVwNXEIGb76UG5IPkCJ1S6/9BD61QQs
# KzPepW0SNj8TXgsFxvS7MltoRuikIIp7Q5jQgaOM6QyK9++6ZVXUpYmZulAe6x8J
# rwZ0dNkE+rZ66lqtoocwepUSVUxM7odDmn8yDHjJ2DNPsfr3uRDix3X4qvh14jH/
# SW+2Cx7WIMhyIiQO201i6hUixmk4e2ZW8W7C1wPdTjq6BKb+zo8xbrt7ZKQvRX5Q
# OA6dhLquPqj5sVKnxqfk19IC0SafTSTs8yC43Ew965BRRW8VL9ccoOmr4rxQy7aC
# gYTNk3dd/LphNaTTmnGp7kmLTxyHkB5geoWhYuuGrywS8E0wJv0W4rfOtHBV0e9s
# KvuUIeIUpnsx6ilxEVj6VQXvgD6yeCKnPmj3jJiJKAlmUDtth5yzRVBUl44sMiG4
# L5R/yyACRKk2n088Q2YCoZS1O86+oMLKt1jaXGECOjbsVp8Id1VQw8he6J0KirOS
# 5e25XlTdGPFb6oBOOaacgW78Kjf0bp+XzAgkc92mDGNJGYSjvdnj+7eMx6meW0DA
# IGdLRNj8/429MIspFBfz3KDqqpN71S4kQ2LLer3dxhDDczKVFL0HLwRuOvgjiG8C
# AwEAAaOCAdwwggHYMA4GA1UdDwEB/wQEAwIBhjAQBgkrBgEEAYI3FQEEAwIBADAd
# BgNVHQ4EFgQUmvFUd3UMhxY3RqCs3nn59H/BeOkwVAYDVR0gBE0wSzBJBgRVHSAA
# MEEwPwYIKwYBBQUHAgEWM2h0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMv
# RG9jcy9SZXBvc2l0b3J5Lmh0bTAZBgkrBgEEAYI3FAIEDB4KAFMAdQBiAEMAQTAS
# BgNVHRMBAf8ECDAGAQH/AgEAMB8GA1UdIwQYMBaAFNlBKbAPD2Ns72nX9c0pnqRI
# ajDmMHAGA1UdHwRpMGcwZaBjoGGGX2h0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9w
# a2lvcHMvY3JsL01pY3Jvc29mdCUyMElEJTIwVmVyaWZpZWQlMjBDb2RlJTIwU2ln
# bmluZyUyMFBDQSUyMDIwMjEuY3JsMH0GCCsGAQUFBwEBBHEwbzBtBggrBgEFBQcw
# AoZhaHR0cDovL3d3dy5taWNyb3NvZnQuY29tL3BraW9wcy9jZXJ0cy9NaWNyb3Nv
# ZnQlMjBJRCUyMFZlcmlmaWVkJTIwQ29kZSUyMFNpZ25pbmclMjBQQ0ElMjAyMDIx
# LmNydDANBgkqhkiG9w0BAQwFAAOCAgEAkHVaGf1NJt/JdoimmRZbMWr6baaDi8mk
# dWvWStk0hdZDpxSYTA7HuipAoLL3qIhI101XOl7fOiCh5++jZOamQdAV79ojEUNo
# IgCZmL2XJrLaGanwdjNynecJyYVCTrRf2+h7KknpWOp4axdOs6K9ZQ5g0IsQWXCw
# fc0dfkSkLKNY3pDcWLlJPh2jd5NUue6pNDv/2G5MFNJhCwltODebyAjGceU+XOza
# v+7i721YQnQ+39m2aQOFO7zpAdaKAeAGhEd6Y6CdDGneSxcoujWvafWbv4ay3jo1
# ORSLUuWMbKr5X18QE4Sde+gppGLLSkZsrUh2eyYSkX1envWX7ZPzg2/wiuKRlQFa
# rDn+N9+20BqzhxwkNyLzfYJp1Lg4fCXb24XqFjx8SDdRgebFImOfOLVze8XQ/Cwk
# rEaib0PHu2t4GVk4FYroEbNUFqvjdBvTY3uiR5TdQoyXoYHvh+TxpLSY2vo7hhK9
# D/rpEpHC+qmmcRUE4d0gyO9Zb1vvt25fxM3ekjvDfVHcPq3qMr0Rwsk4krKZWUEg
# U1SXT5qN6gqRrshxbT6OQgZ9/xT04qiXdzPQR6KindBvSpoOnxnALxcJyzVwNpKL
# +9u8EZYy98qX6i+4gE/2J6cbpekcB0ZXDn/XQxoNUUb6/djT/wllVyG+vIHkdq71
# PzbH5rYxdcAwggeeMIIFhqADAgECAhMzAAAAB4ejNKN7pY4cAAAAAAAHMA0GCSqG
# SIb3DQEBDAUAMHcxCzAJBgNVBAYTAlVTMR4wHAYDVQQKExVNaWNyb3NvZnQgQ29y
# cG9yYXRpb24xSDBGBgNVBAMTP01pY3Jvc29mdCBJZGVudGl0eSBWZXJpZmljYXRp
# b24gUm9vdCBDZXJ0aWZpY2F0ZSBBdXRob3JpdHkgMjAyMDAeFw0yMTA0MDEyMDA1
# MjBaFw0zNjA0MDEyMDE1MjBaMGMxCzAJBgNVBAYTAlVTMR4wHAYDVQQKExVNaWNy
# b3NvZnQgQ29ycG9yYXRpb24xNDAyBgNVBAMTK01pY3Jvc29mdCBJRCBWZXJpZmll
# ZCBDb2RlIFNpZ25pbmcgUENBIDIwMjEwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAw
# ggIKAoICAQCy8MCvGYgo4t1UekxJbGkIVQm0Uv96SvjB6yUo92cXdylN65Xy96q2
# YpWCiTas7QPTkGnK9QMKDXB2ygS27EAIQZyAd+M8X+dmw6SDtzSZXyGkxP8a8Hi6
# EO9Zcwh5A+wOALNQbNO+iLvpgOnEM7GGB/wm5dYnMEOguua1OFfTUITVMIK8faxk
# P/4fPdEPCXYyy8NJ1fmskNhW5HduNqPZB/NkWbB9xxMqowAeWvPgHtpzyD3PLGVO
# mRO4ka0WcsEZqyg6efk3JiV/TEX39uNVGjgbODZhzspHvKFNU2K5MYfmHh4H1qOb
# U4JKEjKGsqqA6RziybPqhvE74fEp4n1tiY9/ootdU0vPxRp4BGjQFq28nzawuvaC
# qUUF2PWxh+o5/TRCb/cHhcYU8Mr8fTiS15kRmwFFzdVPZ3+JV3s5MulIf3II5FXe
# ghlAH9CvicPhhP+VaSFW3Da/azROdEm5sv+EUwhBrzqtxoYyE2wmuHKws00x4GGI
# x7NTWznOm6x/niqVi7a/mxnnMvQq8EMse0vwX2CfqM7Le/smbRtsEeOtbnJBbtLf
# oAsC3TdAOnBbUkbUfG78VRclsE7YDDBUbgWt75lDk53yi7C3n0WkHFU4EZ83i83a
# bd9nHWCqfnYa9qIHPqjOiuAgSOf4+FRcguEBXlD9mAInS7b6V0UaNwIDAQABo4IC
# NTCCAjEwDgYDVR0PAQH/BAQDAgGGMBAGCSsGAQQBgjcVAQQDAgEAMB0GA1UdDgQW
# BBTZQSmwDw9jbO9p1/XNKZ6kSGow5jBUBgNVHSAETTBLMEkGBFUdIAAwQTA/Bggr
# BgEFBQcCARYzaHR0cDovL3d3dy5taWNyb3NvZnQuY29tL3BraW9wcy9Eb2NzL1Jl
# cG9zaXRvcnkuaHRtMBkGCSsGAQQBgjcUAgQMHgoAUwB1AGIAQwBBMA8GA1UdEwEB
# /wQFMAMBAf8wHwYDVR0jBBgwFoAUyH7SaoUqG8oZmAQHJ89QEE9oqKIwgYQGA1Ud
# HwR9MHsweaB3oHWGc2h0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2lvcHMvY3Js
# L01pY3Jvc29mdCUyMElkZW50aXR5JTIwVmVyaWZpY2F0aW9uJTIwUm9vdCUyMENl
# cnRpZmljYXRlJTIwQXV0aG9yaXR5JTIwMjAyMC5jcmwwgcMGCCsGAQUFBwEBBIG2
# MIGzMIGBBggrBgEFBQcwAoZ1aHR0cDovL3d3dy5taWNyb3NvZnQuY29tL3BraW9w
# cy9jZXJ0cy9NaWNyb3NvZnQlMjBJZGVudGl0eSUyMFZlcmlmaWNhdGlvbiUyMFJv
# b3QlMjBDZXJ0aWZpY2F0ZSUyMEF1dGhvcml0eSUyMDIwMjAuY3J0MC0GCCsGAQUF
# BzABhiFodHRwOi8vb25lb2NzcC5taWNyb3NvZnQuY29tL29jc3AwDQYJKoZIhvcN
# AQEMBQADggIBAH8lKp7+1Kvq3WYK21cjTLpebJDjW4ZbOX3HD5ZiG84vjsFXT0OB
# +eb+1TiJ55ns0BHluC6itMI2vnwc5wDW1ywdCq3TAmx0KWy7xulAP179qX6VSBNQ
# kRXzReFyjvF2BGt6FvKFR/imR4CEESMAG8hSkPYso+GjlngM8JPn/ROUrTaeU/BR
# u/1RFESFVgK2wMz7fU4VTd8NXwGZBe/mFPZG6tWwkdmA/jLbp0kNUX7elxu2+HtH
# o0QO5gdiKF+YTYd1BGrmNG8sTURvn09jAhIUJfYNotn7OlThtfQjXqe0qrimgY4V
# poq2MgDW9ESUi1o4pzC1zTgIGtdJ/IvY6nqa80jFOTg5qzAiRNdsUvzVkoYP7bi4
# wLCj+ks2GftUct+fGUxXMdBUv5sdr0qFPLPB0b8vq516slCfRwaktAxK1S40MCvF
# bbAXXpAZnU20FaAoDwqq/jwzwd8Wo2J83r7O3onQbDO9TyDStgaBNlHzMMQgl95n
# HBYMelLEHkUnVVVTUsgC0Huj09duNfMaJ9ogxhPNThgq3i8w3DAGZ61AMeF0C1M+
# mU5eucj1Ijod5O2MMPeJQ3/vKBtqGZg4eTtUHt/BPjN74SsJsyHqAdXVS5c+ItyK
# Wg3Eforhox9k3WgtWTpgV4gkSiS4+A09roSdOI4vrRw+p+fL4WrxSK5nMYIakTCC
# Go0CAQEwcTBaMQswCQYDVQQGEwJVUzEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBv
# cmF0aW9uMSswKQYDVQQDEyJNaWNyb3NvZnQgSUQgVmVyaWZpZWQgQ1MgRU9DIENB
# IDA0AhMzAAqfKX1gqK9tJL7cAAAACp8pMA0GCWCGSAFlAwQCAQUAoF4wEAYKKwYB
# BAGCNwIBDDECMAAwGQYJKoZIhvcNAQkDMQwGCisGAQQBgjcCAQQwLwYJKoZIhvcN
# AQkEMSIEIN1ScYt7XbZI+6eewAy3L71KHcchpeJ+Jhi84/QautcUMA0GCSqGSIb3
# DQEBAQUABIIBgBhZSMQ9HFtrOutwzA71FI3n2wxnvatM4G4Jg9q4A6yxeSso4OpO
# 5wYBX2wcxipWjAHUI8X8XOnuDgwKEN4Id0szSdtHB4iqniEBRkp5HVD/d0RduQbB
# J9zR3qy37P6mP+0C6rwQ1ifp6lvFbD8YWCxx06Zz+vUrXjSggMS+rT4g7x7aVV5r
# G21HzbTBwuuLfOSO4Qp6XRWM3Of3lv0ycBupSnEz/tzLHhZQDg33sWerm5IZ7RVx
# gioPKM/KRrEQ9slaSSrJRCvcmiDdWx4vPa/XD2iHZzDpo92scFYn+lmtowK14vxR
# vMV20VpP6MQzj7gBfNMtKFrIS96eUD4Xk0Rse7YLOO5kl+3TRbpWqwH85LrhYr9w
# hwUV6ZmprJRYWfB2K0PXG/S5zCkicqGfEWksxn+OxkkjpWiEapdhmnImATXUHg74
# kOOd1r64H5+i6ZeqPcf6VRir00cWeaqWTVO+VjHZR3VYc+Kl3iVt/Hd5F5EpqhAF
# MGAMvobi16HBqaGCGBEwghgNBgorBgEEAYI3AwMBMYIX/TCCF/kGCSqGSIb3DQEH
# AqCCF+owghfmAgEDMQ8wDQYJYIZIAWUDBAIBBQAwggFiBgsqhkiG9w0BCRABBKCC
# AVEEggFNMIIBSQIBAQYKKwYBBAGEWQoDATAxMA0GCWCGSAFlAwQCAQUABCCRUNlT
# rOyp+wuUi7g3X/cG6x76izOPxi3OgqH68cLD7AIGavzr6zT6GBMyMDI2MTExOTIz
# NDQzOS41NzNaMASAAgH0oIHhpIHeMIHbMQswCQYDVQQGEwJVUzETMBEGA1UECBMK
# V2FzaGluZ3RvbjEQMA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0
# IENvcnBvcmF0aW9uMSUwIwYDVQQLExxNaWNyb3NvZnQgQW1lcmljYSBPcGVyYXRp
# b25zMScwJQYDVQQLEx5uU2hpZWxkIFRTUyBFU046NzgwMC0wNUUwLUQ5NDcxNTAz
# BgNVBAMTLE1pY3Jvc29mdCBQdWJsaWMgUlNBIFRpbWUgU3RhbXBpbmcgQXV0aG9y
# aXR5oIIPITCCB4IwggVqoAMCAQICEzMAAAAF5c8P/2YuyYcAAAAAAAUwDQYJKoZI
# hvcNAQEMBQAwdzELMAkGA1UEBhMCVVMxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jw
# b3JhdGlvbjFIMEYGA1UEAxM/TWljcm9zb2Z0IElkZW50aXR5IFZlcmlmaWNhdGlv
# biBSb290IENlcnRpZmljYXRlIEF1dGhvcml0eSAyMDIwMB4XDTIwMTExOTIwMzIz
# MVoXDTM1MTExOTIwNDIzMVowYTELMAkGA1UEBhMCVVMxHjAcBgNVBAoTFU1pY3Jv
# c29mdCBDb3Jwb3JhdGlvbjEyMDAGA1UEAxMpTWljcm9zb2Z0IFB1YmxpYyBSU0Eg
# VGltZXN0YW1waW5nIENBIDIwMjAwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIK
# AoICAQCefOdSY/3gxZ8FfWO1BiKjHB7X55cz0RMFvWVGR3eRwV1wb3+yq0OXDEqh
# UhxqoNv6iYWKjkMcLhEFxvJAeNcLAyT+XdM5i2CgGPGcb95WJLiw7HzLiBKrxmDj
# 1EQB/mG5eEiRBEp7dDGzxKCnTYocDOcRr9KxqHydajmEkzXHOeRGwU+7qt8Md5l4
# bVZrXAhK+WSk5CihNQsWbzT1nRliVDwunuLkX1hyIWXIArCfrKM3+RHh+Sq5RZ8a
# Yyik2r8HxT+l2hmRllBvE2Wok6IEaAJanHr24qoqFM9WLeBUSudz+qL51HwDYyID
# PSQ3SeHtKog0ZubDk4hELQSxnfVYXdTGncaBnB60QrEuazvcob9n4yR65pUNBCF5
# qeA4QwYnilBkfnmeAjRN3LVuLr0g0FXkqfYdUmj1fFFhH8k8YBozrEaXnsSL3kdT
# D01X+4LfIWOuFzTzuoslBrBILfHNj8RfOxPgjuwNvE6YzauXi4orp4Sm6tF245Da
# FOSYbWFK5ZgG6cUY2/bUq3g3bQAqZt65KcaewEJ3ZyNEobv35Nf6xN6FrA6jF944
# 7+NHvCjeWLCQZ3M8lgeCcnnhTFtyQX3XgCoc6IRXvFOcPVrr3D9RPHCMS6Ckg8wg
# gTrtIVnY8yjbvGOUsAdZbeXUIQAWMs0d3cRDv09SvwVRd61evQIDAQABo4ICGzCC
# AhcwDgYDVR0PAQH/BAQDAgGGMBAGCSsGAQQBgjcVAQQDAgEAMB0GA1UdDgQWBBRr
# aSg6NS9IY0DPe9ivSek+2T3bITBUBgNVHSAETTBLMEkGBFUdIAAwQTA/BggrBgEF
# BQcCARYzaHR0cDovL3d3dy5taWNyb3NvZnQuY29tL3BraW9wcy9Eb2NzL1JlcG9z
# aXRvcnkuaHRtMBMGA1UdJQQMMAoGCCsGAQUFBwMIMBkGCSsGAQQBgjcUAgQMHgoA
# UwB1AGIAQwBBMA8GA1UdEwEB/wQFMAMBAf8wHwYDVR0jBBgwFoAUyH7SaoUqG8oZ
# mAQHJ89QEE9oqKIwgYQGA1UdHwR9MHsweaB3oHWGc2h0dHA6Ly93d3cubWljcm9z
# b2Z0LmNvbS9wa2lvcHMvY3JsL01pY3Jvc29mdCUyMElkZW50aXR5JTIwVmVyaWZp
# Y2F0aW9uJTIwUm9vdCUyMENlcnRpZmljYXRlJTIwQXV0aG9yaXR5JTIwMjAyMC5j
# cmwwgZQGCCsGAQUFBwEBBIGHMIGEMIGBBggrBgEFBQcwAoZ1aHR0cDovL3d3dy5t
# aWNyb3NvZnQuY29tL3BraW9wcy9jZXJ0cy9NaWNyb3NvZnQlMjBJZGVudGl0eSUy
# MFZlcmlmaWNhdGlvbiUyMFJvb3QlMjBDZXJ0aWZpY2F0ZSUyMEF1dGhvcml0eSUy
# MDIwMjAuY3J0MA0GCSqGSIb3DQEBDAUAA4ICAQBfiHbHfm21WhV150x4aPpO4dhE
# mSUVpbixNDmv6TvuIHv1xIs174bNGO/ilWMm+Jx5boAXrJxagRhHQtiFprSjMktT
# liL4sKZyt2i+SXncM23gRezzsoOiBhv14YSd1Klnlkzvgs29XNjT+c8hIfPRe9rv
# VCMPiH7zPZcw5nNjthDQ+zD563I1nUJ6y59TbXWsuyUsqw7wXZoGzZwijWT5oc6G
# vD3HDokJY401uhnj3ubBhbkR83RbfMvmzdp3he2bvIUztSOuFzRqrLfEvsPkVHYn
# vH1wtYyrt5vShiKheGpXa2AWpsod4OJyT4/y0dggWi8g/tgbhmQlZqDUf3UqUQsZ
# aLdIu/XSjgoZqDjamzCPJtOLi2hBwL+KsCh0Nbwc21f5xvPSwym0Ukr4o5sCcMUc
# Sy6TEP7uMV8RX0eH/4JLEpGyae6Ki8JYg5v4fsNGif1OXHJ2IWG+7zyjTDfkmQ1s
# nFOTgyEX8qBpefQbF0fx6URrYiarjmBprwP6ZObwtZXJ23jK3Fg/9uqM3j0P01nz
# VygTppBabzxPAh/hHhhls6kwo3QLJ6No803jUsZcd4JQxiYHHc+Q/wAMcPUnYKv/
# q2O444LO1+n6j01z5mggCSlRwD9faBIySAcA9S8h22hIAcRQqIGEjolCK9F6nK9Z
# yX4lhthsGHumaABdWzCCB5cwggV/oAMCAQICEzMAAABeLhFuHHac7wUAAAAAAF4w
# DQYJKoZIhvcNAQEMBQAwYTELMAkGA1UEBhMCVVMxHjAcBgNVBAoTFU1pY3Jvc29m
# dCBDb3Jwb3JhdGlvbjEyMDAGA1UEAxMpTWljcm9zb2Z0IFB1YmxpYyBSU0EgVGlt
# ZXN0YW1waW5nIENBIDIwMjAwHhcNMjYwOTE3MTg1NzIzWhcNMjcwOTE0MTg1NzIz
# WjCB2zELMAkGA1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcT
# B1JlZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjElMCMGA1UE
# CxMcTWljcm9zb2Z0IEFtZXJpY2EgT3BlcmF0aW9uczEnMCUGA1UECxMeblNoaWVs
# ZCBUU1MgRVNOOjc4MDAtMDVFMC1EOTQ3MTUwMwYDVQQDEyxNaWNyb3NvZnQgUHVi
# bGljIFJTQSBUaW1lIFN0YW1waW5nIEF1dGhvcml0eTCCAiIwDQYJKoZIhvcNAQEB
# BQADggIPADCCAgoCggIBANYLzn+RiTrerYIgiJrGpdKrEzaWWcXT2dAYG6E31aRl
# +HIkXj9Zazqhr90el4ioB6sXJKdqapzUSev3pnyDV94ncYrnrrTmETGuhnssH/l4
# SH7g2yzgb1or1QMCYKl6vXsY6aOD542hdEqwGirvhAn+ZC/4tIeaTliECBwiN1yV
# X/N+WQoZJi77gLyEODmpQB2hWKyhfDzZqpnOC36+jGNLdQXCgrU5LlSJSj+lTIyf
# Hdr7lWZyE9xWkyyUIs3AAQtTgG92UfDD0AAg2H4FDrlfuVe/egzDu8kqS+DlaDHV
# XB+5hj+S1PnGOG9DlwVJVkUUA8OhdQ7i4xSJK8IDrZ1KsC5lXj35nfV8la9yTQK8
# dmFDlYYOdcGdCiZpdX7J7HxZIZaqP4cdjQn87zv9p+yH5bonjFU5pQIiJ9ZhS2dE
# YHYMPWJJyu8z3XliL/DdBgZivHeMp9OV6KczJwH0re8V1Xo5NmrXF3RrVQYtCKCR
# za/2ieuRt0PYkloaManzMG6a0d9ahxhDtiE11aQhXrll/daZmHhBieScM97eYT4e
# +k0K3rAV96HfU6sVtGXip5LvJ3c7+PBDMkJYfQl/y/paM5nhW9wSEIAT8gYdGPRq
# KzolYdam9Gvst8XmHXkQbl6uUbMCxwA3U2CeN9vIh5Kval+7dBZsQ46Ls4jhpkBl
# AgMBAAGjggHLMIIBxzAdBgNVHQ4EFgQUkJ+O/e1ckFZIWyr7+tqwFespRu4wHwYD
# VR0jBBgwFoAUa2koOjUvSGNAz3vYr0npPtk92yEwbAYDVR0fBGUwYzBhoF+gXYZb
# aHR0cDovL3d3dy5taWNyb3NvZnQuY29tL3BraW9wcy9jcmwvTWljcm9zb2Z0JTIw
# UHVibGljJTIwUlNBJTIwVGltZXN0YW1waW5nJTIwQ0ElMjAyMDIwLmNybDB5Bggr
# BgEFBQcBAQRtMGswaQYIKwYBBQUHMAKGXWh0dHA6Ly93d3cubWljcm9zb2Z0LmNv
# bS9wa2lvcHMvY2VydHMvTWljcm9zb2Z0JTIwUHVibGljJTIwUlNBJTIwVGltZXN0
# YW1waW5nJTIwQ0ElMjAyMDIwLmNydDAMBgNVHRMBAf8EAjAAMBYGA1UdJQEB/wQM
# MAoGCCsGAQUFBwMIMA4GA1UdDwEB/wQEAwIHgDBmBgNVHSAEXzBdMFEGDCsGAQQB
# gjdMg30BATBBMD8GCCsGAQUFBwIBFjNodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20v
# cGtpb3BzL0RvY3MvUmVwb3NpdG9yeS5odG0wCAYGZ4EMAQQCMA0GCSqGSIb3DQEB
# DAUAA4ICAQBFu/ZT4cvj4lM2inZbiG/mZywlkPodAKAk3ofp/uBe/Az6gmCAK5S3
# repNjtHt+cJpGGT1WDIJkrC0HhzcgTURxBWiHuwLrdArwPlIqQgHGNV0Ku6Y1Ujs
# quXBMuT5fTVavpwqhDOgDdNDpxibvsN4IuY6AS2BhtJQo5y23Ois6RUzzdyUbEdD
# ql8Q8uG+KjkPHX9mBgdcszH2GCjvO5GONE+SpVFDUC/QiSj0LaPd1mEPBBYSPoah
# 6uxvcvTcBf+wY4s2bu24WyaF+Avcm3wP7CI3wkgYbpVmINM7BH0c7oOTMlm/5WZX
# NflehbgPD4n1g6lNeTItfFEVf7j7aW/keozG7zoBvO9R3EWY6bJZ+dmpky3/1Odu
# nEQsaeTHso4MNNQ0ODWBNeKHd8PEWEeihN4WxufOTlu9J5luUQ8HO1FmVdClL07+
# 6aYDWZ+ROTssgzv4QNeg3J3xr1SdR7Oou3l6CCFL4AH6iTkjN1FwR9q67JFfmq53
# iaiEWJ7Bo3XCpoTM+WaQPMjixJA4Xx1+G6u06EepTNi6ZJji3OW9KB2oQZdWoqaT
# evZRp6OoyDb2xPhQtKR9IDrttsDH6W0E0lW7n1sihsvRAIw3zyv6fw8D7GxmkP0V
# WtkSCyzXBbaR0RYXHEgUgnVYwXUwAa+YcudXxwJ+16JlrnnC7vSDAzGCB0Mwggc/
# AgEBMHgwYTELMAkGA1UEBhMCVVMxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3Jh
# dGlvbjEyMDAGA1UEAxMpTWljcm9zb2Z0IFB1YmxpYyBSU0EgVGltZXN0YW1waW5n
# IENBIDIwMjACEzMAAABeLhFuHHac7wUAAAAAAF4wDQYJYIZIAWUDBAIBBQCgggSc
# MBEGCyqGSIb3DQEJEAIPMQIFADAaBgkqhkiG9w0BCQMxDQYLKoZIhvcNAQkQAQQw
# HAYJKoZIhvcNAQkFMQ8XDTI2MTExOTIzNDQzOVowLwYJKoZIhvcNAQkEMSIEIFob
# IlWJgEQFT0YZ64sEnnXnhjEjev1O7q8SyLSLltLjMIG5BgsqhkiG9w0BCRACLzGB
# qTCBpjCBozCBoAQg2fVmzDuHRgytmXR5bVL7Mwh0CGqqos+3kDbmXlBX7qMwfDBl
# pGMwYTELMAkGA1UEBhMCVVMxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlv
# bjEyMDAGA1UEAxMpTWljcm9zb2Z0IFB1YmxpYyBSU0EgVGltZXN0YW1waW5nIENB
# IDIwMjACEzMAAABeLhFuHHac7wUAAAAAAF4wggNeBgsqhkiG9w0BCRACEjGCA00w
# ggNJoYIDRTCCA0EwggIpAgEBMIIBCaGB4aSB3jCB2zELMAkGA1UEBhMCVVMxEzAR
# BgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1JlZG1vbmQxHjAcBgNVBAoTFU1p
# Y3Jvc29mdCBDb3Jwb3JhdGlvbjElMCMGA1UECxMcTWljcm9zb2Z0IEFtZXJpY2Eg
# T3BlcmF0aW9uczEnMCUGA1UECxMeblNoaWVsZCBUU1MgRVNOOjc4MDAtMDVFMC1E
# OTQ3MTUwMwYDVQQDEyxNaWNyb3NvZnQgUHVibGljIFJTQSBUaW1lIFN0YW1waW5n
# IEF1dGhvcml0eaIjCgEBMAcGBSsOAwIaAxUA3q4d2bA8fHDYjXY/C+auNvH/6AWg
# ZzBlpGMwYTELMAkGA1UEBhMCVVMxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3Jh
# dGlvbjEyMDAGA1UEAxMpTWljcm9zb2Z0IFB1YmxpYyBSU0EgVGltZXN0YW1waW5n
# IENBIDIwMjAwDQYJKoZIhvcNAQELBQACBQDuqWSnMCIYDzIwMjYxMTE5MTIwNTU5
# WhgPMjAyNjExMjAxMjA1NTlaMHQwOgYKKwYBBAGEWQoEATEsMCowCgIFAO6pZKcC
# AQAwBwIBAAICAqAwBwIBAAICElYwCgIFAO6qticCAQAwNgYKKwYBBAGEWQoEAjEo
# MCYwDAYKKwYBBAGEWQoDAqAKMAgCAQACAwehIKEKMAgCAQACAwGGoDANBgkqhkiG
# 9w0BAQsFAAOCAQEARjbYrhaX3XURzJ8bsIvA2iXB1+dGxUqhZifr70xRTOl+wZhd
# Ql2eaV5ehKlK7ICtNHbUGQwfnQyEboIL8WOcf/XB5cY53zK2YYCLOmVqjSgOCOaz
# feoV3jhj1uu/TuMWF5U00oOhcc6J0973MOMRduesYAjptUYKUYv9+9WYeskstfeJ
# gD7PXUZAbfszQTGZuZBEKTvFj1igt59t7z9ubJS91dihDwuoUymR+HLVh6SaFSGR
# EaUqtJndT6Z8roC76TCebAMP9Lk1gQ4A9FuZ2ERdYhP6ftjk/Zn1ShbZA2u8y7DX
# VG8fB5WRMZvcxGiq0n6lUeWsbYcsNQflnnyv9DANBgkqhkiG9w0BAQEFAASCAgCW
# +sSzhUsCy0Tl2QSqovCG/15EUl88vWKno5pfYb7OB88TXRbg8269enyGihS3cb8t
# 6kUu2Xic/ADhrXWaT8tTFC2CMSiktkTJkKMm8dj/TFUJ+NaKza7IlA5l+BGXllSp
# UKxqcIQS/yUpPkAgLjEJlX6P6FiPOHvuaEbbFWNdQlACvyV72UMAa40NBInXXvtf
# /voMslBcgYcMLxlVXwnmaBy37rTfteIgUMZMiGSpuv1GZI5lGspL8KjXrWDts92s
# 4PYKkPGv1jq+C1JAV5d8odkLqCP5cwrPRlD+eDVphqM+MxnmKcDauK47j5REKpyy
# w+qGf2d/nl8jDLYjBCIfzatMm+q8p2vZ4G1Q1mEK2t3uA+TLdUDSpHfycXKvhIMb
# HUrrA+ELQmwcUpKMPn07WU8ikTmFGu3e77U5p13J2mqhfmweVPQtFSB5gN0h5NoA
# jdvBGDBtY9UAH/E5DjBGzr0mjQURnS0R5qRahTqtV9eEOQmVIZSaCQbu827zxGAG
# ytMNxZiNGSBGDx95KYZeOZtbhmp5NHmWW9o5PsLweMtpk0guFXQko2nG+jQbZrDH
# DHfeSmIGbfW4EOffPT1U8EqVOMPdkZcPFtrnhgcsaDOiObsJ0TwlztHEgMlhlpH3
# SyzRlsvQlFrtYsTvVQ/+R85/ULJg8MHHu5hVVVasmg==
# SIG # End signature block

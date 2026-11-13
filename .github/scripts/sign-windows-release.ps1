param([Parameter(Mandatory)][string]$File)
$ErrorActionPreference = 'Stop'
Import-Module TrustedSigning -RequiredVersion 0.5.8
$path = (Resolve-Path -LiteralPath $File).Path
Invoke-TrustedSigning -Endpoint $env:WINDOWS_SIGNING_ENDPOINT -CodeSigningAccountName $env:WINDOWS_SIGNING_ACCOUNT -CertificateProfileName $env:WINDOWS_SIGNING_PROFILE -Files $path -FileDigest SHA256 -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256
$signature = Get-AuthenticodeSignature -LiteralPath $path
if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) {
  throw "Signature verification failed for $path ($($signature.Status))."
}

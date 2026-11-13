# Hosted Windows jobs run elevated and can give newly created files to Administrators.
# Set this test process's default owner to its own login so child processes create
# fixtures as a desktop user would. Keep elevation for the foreign-owner rejection test.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class ScarletTestOwner {
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(
        SafeAccessTokenHandle token, int informationClass, ref IntPtr information, int length);

    public static void UseLogin() {
        using (var identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query | TokenAccessLevels.AdjustDefault)) {
            if (identity.User.Equals(identity.Owner)) return;
            var sid = new byte[identity.User.BinaryLength];
            identity.User.GetBinaryForm(sid, 0);
            var pinned = GCHandle.Alloc(sid, GCHandleType.Pinned);
            try {
                // TOKEN_OWNER holds one pointer to the default owner SID.
                var owner = pinned.AddrOfPinnedObject();
                const int TokenOwner = 4;
                if (!SetTokenInformation(identity.AccessToken, TokenOwner, ref owner, IntPtr.Size))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
            } finally { pinned.Free(); }
        }
    }
}
'@
[ScarletTestOwner]::UseLogin()

$probe = Join-Path $env:RUNNER_TEMP ("scarlet-owner-" + [Guid]::NewGuid())
try {
    node -e "const fs = require('node:fs'); const dir = process.argv[1]; fs.mkdirSync(dir); fs.writeFileSync(require('node:path').join(dir, 'child'), 'probe');" $probe
    if ($LASTEXITCODE -ne 0) { throw 'Node could not create the ownership probe.' }
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($path in @($probe, (Join-Path $probe 'child'))) {
        $actual = (Get-Item -LiteralPath $path).GetAccessControl().GetOwner([System.Security.Principal.SecurityIdentifier])
        if (!$actual.Equals($user)) { throw "Child process created $path under $actual instead of $user." }
    }
} finally {
    if ([System.IO.Directory]::Exists($probe)) { [System.IO.Directory]::Delete($probe, $true) }
}

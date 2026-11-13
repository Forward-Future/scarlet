import { execFileSync } from "node:child_process";
import { join } from "node:path";

// A protected or explicit child grant can survive changing the library root. Windows can open a
// known child path without granting traversal on its parents. Leave such permissions for its owner.
const checkWindowsChildren = `
$pending=New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
$pending.Push([System.IO.DirectoryInfo]::new($env:SCARLET_PRIVATE_PATH))
while ($pending.Count) {
  foreach ($entry in $pending.Pop().EnumerateFileSystemInfos()) {
    if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw 'The Scarlet library contains a linked item. Move it outside the library or choose an empty directory for --data.'
    }
    $security=$entry.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access,Owner')
    if ($security.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $id) {
      throw 'A Scarlet library item belongs to another account. Use an owner-only library or choose an empty directory for --data.'
    }
    foreach ($rule in $security.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference -ne $id) {
        throw 'The Scarlet library still grants access to another account. Restrict its existing files to your account or choose an empty directory for --data.'
      }
    }
    if ($entry -is [System.IO.DirectoryInfo]) { $pending.Push($entry) }
  }
}`;

/** Replace inherited and explicit access rules with an owner-only DACL. Library children inherit it. */
export function restrictWindowsAccess(path: string, kind: "File" | "Directory", refuseChange?: string) {
  const inheritance = kind === "Directory" ? "'ContainerInherit,ObjectInherit','None'," : "";
  const command = [
    "$ErrorActionPreference='Stop'",
    "$id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    `$acl=New-Object System.Security.AccessControl.${kind}Security`,
    "$acl.SetOwner($id)",
    "$acl.SetAccessRuleProtection($true,$false)",
    `$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl',${inheritance}'Allow'))`,
    `$current=[System.IO.${kind}]::GetAccessControl($env:SCARLET_PRIVATE_PATH)`,
    // Windows reads a protected DACL back with its auto-inherit flags ("D:PAI(...)"), which a new descriptor lacks
    // ("D:P(...)"). Compare without them, or every start rewrites the root, and Windows then re-propagates it to every
    // file in the library, moving each file's ChangeTime and with it every source's preview and render stamps.
    "$sddl={ param($s) $s.GetSecurityDescriptorSddlForm('Access,Owner') -replace '(D:P?)(?:AR|AI)+','$1' }",
    `if ((& $sddl $acl) -ne (& $sddl $current)) { if ($env:SCARLET_REFUSE_DACL_CHANGE) { throw $env:SCARLET_REFUSE_DACL_CHANGE }; [System.IO.${kind}]::SetAccessControl($env:SCARLET_PRIVATE_PATH,$acl) }`,
    kind === "Directory" ? checkWindowsChildren : "",
  ].join(";");
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { env: { ...process.env, SCARLET_PRIVATE_PATH: path, SCARLET_REFUSE_DACL_CHANGE: refuseChange ?? "" }, windowsHide: true });
}

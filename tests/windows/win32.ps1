# Drive a native tcb.exe dialog with plain Win32 messages (used by e2e.test.mjs).
# Works without keyboard focus, which GitHub's Windows runners do not give native dialogs.
#   -Title   exact top-level window title ("Unsaved changes", "Open", "Save As")
#   -Choice  Yes / No for a message box or task dialog
#   -Path    for a file dialog: text for the file-name box, then IDOK
# Prints OK / NOWINDOW / NOEDIT / STILLOPEN (+ the dialog's controls) and exits 0 / 2 / 4 / 5.
param([Parameter(Mandatory)][string]$Title, [string]$Choice, [string]$Path, [int]$Timeout = 20)
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class TcbWin32 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Text(IntPtr h) { var s = new StringBuilder(1024); GetWindowText(h, s, 1024); return s.ToString(); }
  public static string Describe(IntPtr dlg) {
    var sb = new StringBuilder();
    EnumChildWindows(dlg, (h, l) => { var c = Cls(h); if (c == "Edit" || c == "Button" || c.StartsWith("ComboBox")) sb.AppendFormat("  {0} parent={1} text='{2}'\n", c, Cls(GetParent(h)), Text(h)); return true; }, IntPtr.Zero);
    return sb.ToString();
  }
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static IntPtr FileNameEdit(IntPtr dlg) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dlg, (h, l) => {
      if (Cls(h) == "Edit") { var pc = Cls(GetParent(h)); if (pc == "ComboBox" || pc == "ComboBoxEx32") { found = h; return false; } }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$WM_SETTEXT = 0x000C; $WM_COMMAND = 0x0111; $TDM_CLICK_BUTTON = 0x0400 + 102
$deadline = (Get-Date).AddSeconds($Timeout)
$dlg = [IntPtr]::Zero
while ($dlg -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
  # [NullString]::Value, not $null: PowerShell would pass $null as "" (a class named "").
  $dlg = [TcbWin32]::FindWindow([NullString]::Value, $Title)
  if ($dlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 300 }
}
if ($dlg -eq [IntPtr]::Zero) { Write-Output "NOWINDOW"; exit 2 }
Start-Sleep -Milliseconds 500   # let the dialog finish initialising its controls

if ($Path) {
  $edit = [IntPtr]::Zero
  for ($i = 0; $i -lt 20 -and $edit -eq [IntPtr]::Zero; $i++) {
    $edit = [TcbWin32]::FileNameEdit($dlg)
    if ($edit -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 }
  }
  if ($edit -eq [IntPtr]::Zero) { Write-Output "NOEDIT"; exit 4 }
  [void][TcbWin32]::SendMessage($edit, $WM_SETTEXT, [IntPtr]::Zero, $Path)
  Start-Sleep -Milliseconds 300
  $typed = [TcbWin32]::Text($edit)
  [void][TcbWin32]::PostMessage($dlg, $WM_COMMAND, [IntPtr]1, [IntPtr]::Zero)   # IDOK
  for ($i = 0; $i -lt 20 -and [TcbWin32]::IsWindow($dlg); $i++) { Start-Sleep -Milliseconds 250 }
  if ([TcbWin32]::IsWindow($dlg)) {
    Write-Output "STILLOPEN typed='$typed'"
    Write-Output ([TcbWin32]::Describe($dlg))
    exit 5
  }
  Write-Output "OK"; exit 0
}

$id = @{ 'Yes' = 6; 'No' = 7; 'OK' = 1; 'Cancel' = 2 }[$Choice]
# Task dialog first (TDM_CLICK_BUTTON); a classic message box ignores it and takes WM_COMMAND.
[void][TcbWin32]::PostMessage($dlg, $TDM_CLICK_BUTTON, [IntPtr]$id, [IntPtr]::Zero)
Start-Sleep -Milliseconds 700
if ([TcbWin32]::IsWindow($dlg)) {
  [void][TcbWin32]::PostMessage($dlg, $WM_COMMAND, [IntPtr]$id, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 500
}
Write-Output "OK"

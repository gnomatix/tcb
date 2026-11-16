# Drive a native tcb.exe dialog with plain Win32 messages (used by e2e.test.mjs).
# Works without keyboard focus, which GitHub's Windows runners do not give native dialogs.
#   -Title   exact top-level window title ("Unsaved changes", "Open", "Save As")
#   -Choice  Yes / No for a message box or task dialog
#   -Path    for a file dialog: typed into the file-name box, then IDOK
#   -Cancel  for a file dialog: print its file-name box as TEXT=..., then IDCANCEL
# Prints OK / NOWINDOW / NOEDIT / STILLOPEN / OVERWRITEPROMPT (+ the dialog's controls) and
# exits 0 / 2 / 4 / 5 / 6.
param([Parameter(Mandatory)][string]$Title, [string]$Choice, [string]$Path, [switch]$Cancel, [int]$Timeout = 20)
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
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, StringBuilder l);
  // WM_GETTEXT works across processes; GetWindowText does not for other processes' controls.
  public static string Text(IntPtr h) { var s = new StringBuilder(1024); SendMessage(h, 0x000D, (IntPtr)1024, s); return s.ToString(); }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  // Every visible top-level window of the process that owns hwnd: class, title, enabled.
  public static string ProcessWindows(IntPtr hwnd) {
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    var sb = new StringBuilder();
    EnumWindows((h, l) => {
      uint p2; GetWindowThreadProcessId(h, out p2);
      if (p2 == pid && IsWindowVisible(h)) {
        var t = new StringBuilder(512); GetWindowText(h, t, 512);
        sb.AppendFormat("  top-level {0} '{1}' enabled={2}\n", Cls(h), t, IsWindowEnabled(h));
        if (h != hwnd) { EnumChildWindows(h, (c, l2) => { var cc = Cls(c); if (cc == "Static" || cc == "Button" || cc == "DirectUIHWND") { var ct = Text(c); if (ct.Length > 0) sb.AppendFormat("      {0} '{1}'\n", cc, ct); } return true; }, IntPtr.Zero); }
      }
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
  public static IntPtr ButtonByText(IntPtr dlg, string want) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dlg, (h, l) => { if (Cls(h) == "Button" && Text(h).Replace("&", "") == want) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string Describe(IntPtr dlg) {
    var sb = new StringBuilder();
    EnumChildWindows(dlg, (h, l) => { var c = Cls(h); if (c == "Edit" || c == "Button" || c.StartsWith("ComboBox")) sb.AppendFormat("  {0} parent={1} text='{2}'\n", c, Cls(GetParent(h)), Text(h)); return true; }, IntPtr.Zero);
    return sb.ToString();
  }
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", EntryPoint = "SendMessageW")] public static extern IntPtr SendMsg(IntPtr h, uint m, IntPtr w, IntPtr l);
  // Replace an edit control's text the way typing does: select all, then one WM_CHAR per character.
  // (The Save dialog keeps its own copy of the file name and ignores a WM_SETTEXT.)
  public static void TypeInto(IntPtr edit, string text) {
    SendMsg(edit, 0x00B1, IntPtr.Zero, (IntPtr)(-1));   // EM_SETSEL 0..end
    SendMsg(edit, 0x0102, (IntPtr)0x08, (IntPtr)1);     // WM_CHAR backspace clears the selection
    foreach (char ch in text) SendMsg(edit, 0x0102, (IntPtr)ch, (IntPtr)1);
  }
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

if ($Cancel) {
  $edit = [IntPtr]::Zero
  for ($i = 0; $i -lt 20 -and $edit -eq [IntPtr]::Zero; $i++) {
    $edit = [TcbWin32]::FileNameEdit($dlg)
    if ($edit -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 }
  }
  if ($edit -eq [IntPtr]::Zero) { Write-Output "NOEDIT"; exit 4 }
  $shown = [TcbWin32]::Text($edit)
  [void][TcbWin32]::PostMessage($dlg, $WM_COMMAND, [IntPtr]2, [IntPtr]::Zero)   # IDCANCEL
  for ($i = 0; $i -lt 20 -and [TcbWin32]::IsWindow($dlg); $i++) { Start-Sleep -Milliseconds 250 }
  if ([TcbWin32]::IsWindow($dlg)) { Write-Output "STILLOPEN TEXT=$shown"; exit 5 }
  Write-Output "OK"; Write-Output "TEXT=$shown"; exit 0
}

if ($Path) {
  $edit = [IntPtr]::Zero
  for ($i = 0; $i -lt 20 -and $edit -eq [IntPtr]::Zero; $i++) {
    $edit = [TcbWin32]::FileNameEdit($dlg)
    if ($edit -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 }
  }
  if ($edit -eq [IntPtr]::Zero) { Write-Output "NOEDIT"; exit 4 }
  [TcbWin32]::TypeInto($edit, $Path)
  Start-Sleep -Milliseconds 300
  if ([TcbWin32]::Text($edit) -ne $Path) { [void][TcbWin32]::SendMessage($edit, $WM_SETTEXT, [IntPtr]::Zero, $Path); Start-Sleep -Milliseconds 300 }
  $typed = [TcbWin32]::Text($edit)
  [void][TcbWin32]::PostMessage($dlg, $WM_COMMAND, [IntPtr]1, [IntPtr]::Zero)   # IDOK
  # A "Confirm Save As" box here is the overwrite prompt: the dialog took a file name that
  # already exists (the pre-filled one), not $Path. Answer No so nothing is overwritten, and
  # report it. It is a task dialog (its text lives in a DirectUIHWND, and it ignores a posted
  # WM_COMMAND), so press No with TDM_CLICK_BUTTON, then BM_CLICK on its No button.
  $overwritePrompt = $false
  for ($i = 0; $i -lt 16 -and [TcbWin32]::IsWindow($dlg); $i++) {
    $confirm = [TcbWin32]::FindWindow([NullString]::Value, 'Confirm Save As')
    if ($confirm -ne [IntPtr]::Zero) {
      $overwritePrompt = $true
      [void][TcbWin32]::PostMessage($confirm, $TDM_CLICK_BUTTON, [IntPtr]7, [IntPtr]::Zero)   # IDNO
      Start-Sleep -Milliseconds 500
      if ([TcbWin32]::IsWindow($confirm)) {
        $no = [TcbWin32]::ButtonByText($confirm, 'No')
        if ($no -ne [IntPtr]::Zero) { [void][TcbWin32]::PostMessage($no, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) }   # BM_CLICK
        Start-Sleep -Milliseconds 500
      }
      break
    } else { Start-Sleep -Milliseconds 250 }
  }
  if ($overwritePrompt) {
    # Leave the dialog to the caller's cleanup; the run must not fall through to a click that
    # would raise the same prompt again.
    Write-Output "OVERWRITEPROMPT typed='$typed'"
    Write-Output ([TcbWin32]::Describe($dlg))
    [void][TcbWin32]::PostMessage($dlg, $WM_COMMAND, [IntPtr]2, [IntPtr]::Zero)   # IDCANCEL
    exit 6
  }
  if ([TcbWin32]::IsWindow($dlg)) {
    # The Save dialog ignores a posted IDOK; click its default button instead.
    foreach ($label in @('Save', 'Open')) {
      $btn = [TcbWin32]::ButtonByText($dlg, $label)
      if ($btn -ne [IntPtr]::Zero) { [void][TcbWin32]::PostMessage($btn, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero); break }   # BM_CLICK
    }
    for ($i = 0; $i -lt 12 -and [TcbWin32]::IsWindow($dlg); $i++) { Start-Sleep -Milliseconds 250 }
  }
  if ([TcbWin32]::IsWindow($dlg)) {
    # Return in the file-name edit: the dialog treats it as its default (Save/Open) button.
    [void][TcbWin32]::PostMessage($edit, 0x0100, [IntPtr]0x0D, [IntPtr]0x001C0001)   # WM_KEYDOWN VK_RETURN
    [void][TcbWin32]::PostMessage($edit, 0x0102, [IntPtr]0x0D, [IntPtr]0x001C0001)   # WM_CHAR '\r'
    [void][TcbWin32]::PostMessage($edit, 0x0101, [IntPtr]0x0D, [IntPtr]0xC01C0001)   # WM_KEYUP VK_RETURN
    for ($i = 0; $i -lt 12 -and [TcbWin32]::IsWindow($dlg); $i++) { Start-Sleep -Milliseconds 250 }
  }
  if ([TcbWin32]::IsWindow($dlg)) {
    # Last resort: UI Automation Invoke on the Save / Open button.
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $AE = [System.Windows.Automation.AutomationElement]
    $root = $AE::FromHandle($dlg)
    foreach ($b in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))) {
      if (($b.Current.Name -replace '&', '') -in @('Save', 'Open')) {
        try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch { Write-Output "INVOKEFAILED $($_.Exception.Message)" }
        break
      }
    }
    for ($i = 0; $i -lt 20 -and [TcbWin32]::IsWindow($dlg); $i++) { Start-Sleep -Milliseconds 250 }
  }
  if ([TcbWin32]::IsWindow($dlg)) {
    Write-Output "STILLOPEN typed='$typed'"
    Write-Output ([TcbWin32]::Describe($dlg))
    Write-Output ([TcbWin32]::ProcessWindows($dlg))
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

# Operate a native window of tcb.exe through Windows UI Automation (used by e2e.test.mjs).
#   -Title   window title to wait for (top-level window, e.g. "Unsaved changes", "Open")
#   -Button  button to press (e.g. "Yes", "No", "Open", "Save"), or __close__ to close the
#            window itself the way its X button does (WindowPattern.Close -> WM_CLOSE)
#   -Path    optional text for the dialog's file-name box (file dialogs)
# Prints OK / NOWINDOW / NOBUTTON / NOEDIT and exits 0 / 2 / 3 / 4.
param([Parameter(Mandatory)][string]$Title, [Parameter(Mandatory)][string]$Button, [string]$Path, [int]$Timeout = 20)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
function Cond($prop, $value) { New-Object System.Windows.Automation.PropertyCondition($prop, $value) }
function And($a, $b) { New-Object System.Windows.Automation.AndCondition($a, $b) }

$deadline = (Get-Date).AddSeconds($Timeout)
$win = $null
while (-not $win -and (Get-Date) -lt $deadline) {
  $win = $AE::RootElement.FindFirst($TS::Children, (Cond $AE::NameProperty $Title))
  if (-not $win) {
    $win = $AE::RootElement.FindFirst($TS::Descendants, (And (Cond $AE::NameProperty $Title) (Cond $AE::ControlTypeProperty $CT::Window)))
  }
  if (-not $win) { Start-Sleep -Milliseconds 300 }
}
if (-not $win) { Write-Output "NOWINDOW"; exit 2 }

if ($Button -eq '__close__') {
  $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
  Write-Output "OK"; exit 0
}

if ($Path) {
  # File-name box: control id 1148 in Open dialogs, 1001 in Save dialogs.
  $edit = $null
  foreach ($id in @('1148', '1001')) {
    $edit = $win.FindFirst($TS::Descendants, (And (Cond $AE::AutomationIdProperty $id) (Cond $AE::ControlTypeProperty $CT::Edit)))
    if ($edit) { break }
  }
  if ($edit) {
    $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Path)
  } else {
    # Fallback: the file-name box has focus when a file dialog opens; type into it.
    $win.SetFocus()
    Start-Sleep -Milliseconds 300
    $escaped = ($Path -replace '([+^%~(){}\[\]])', '{$1}')
    [System.Windows.Forms.SendKeys]::SendWait($escaped)
  }
  Start-Sleep -Milliseconds 300
}

$btn = $null
for ($i = 0; $i -lt 20 -and -not $btn; $i++) {
  $btn = $win.FindFirst($TS::Descendants, (And (Cond $AE::NameProperty $Button) (Cond $AE::ControlTypeProperty $CT::Button)))
  if (-not $btn) { Start-Sleep -Milliseconds 200 }
}
if (-not $btn) {
  if ($Path) { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}'); Write-Output "OK"; exit 0 }
  Write-Output "NOBUTTON"; exit 3
}
$btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Output "OK"

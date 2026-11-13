# Operate a native dialog of tcb.exe through Windows UI Automation (used by e2e.test.mjs).
#   -Title   window title to wait for (top-level window, e.g. "Unsaved changes", "Open")
#   -Button  button to press (e.g. "Yes", "No", "Open", "Save")
#   -Path    optional text for the dialog's "File name:" box (file dialogs)
# Prints OK / NOWINDOW / NOBUTTON / NOEDIT and exits 0 / 2 / 3 / 4.
param([Parameter(Mandatory)][string]$Title, [Parameter(Mandatory)][string]$Button, [string]$Path, [int]$Timeout = 20)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
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
    # Owned dialogs can also appear under the app window.
    $win = $AE::RootElement.FindFirst($TS::Descendants, (And (Cond $AE::NameProperty $Title) (Cond $AE::ControlTypeProperty $CT::Window)))
  }
  if (-not $win) { Start-Sleep -Milliseconds 300 }
}
if (-not $win) { Write-Output "NOWINDOW"; exit 2 }

if ($Path) {
  $edit = $win.FindFirst($TS::Descendants, (And (Cond $AE::NameProperty "File name:") (Cond $AE::ControlTypeProperty $CT::Edit)))
  if (-not $edit) { Write-Output "NOEDIT"; exit 4 }
  $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Path)
  Start-Sleep -Milliseconds 300
}

$btn = $null
for ($i = 0; $i -lt 20 -and -not $btn; $i++) {
  $btn = $win.FindFirst($TS::Descendants, (And (Cond $AE::NameProperty $Button) (Cond $AE::ControlTypeProperty $CT::Button)))
  if (-not $btn) { Start-Sleep -Milliseconds 200 }
}
if (-not $btn) { Write-Output "NOBUTTON"; exit 3 }
$btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Output "OK"

# Operate a native window of tcb.exe through Windows UI Automation (used by e2e.test.mjs).
#   -Title   window title to wait for (top-level window, e.g. "Unsaved changes", "Open")
#   -Button  button to press (e.g. "Yes", "No"), __close__ to close the window the way its
#            X button does (WindowPattern.Close -> WM_CLOSE), or __exists__ to only confirm
#            that the window appeared. On GitHub's Windows runners native dialogs cannot take
#            focus or keyboard input, so the tests use __close__ and __exists__ only.
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

if ($Button -eq '__exists__') { Write-Output "OK"; exit 0 }

if ($Button -eq '__close__') {
  $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
  Write-Output "OK"; exit 0
}

function Describe($root) {
  $all = $root.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $all) {
    $ct = $e.Current.ControlType.ProgrammaticName
    if ($ct -match 'Button|Edit|ComboBox') { Write-Output ("  {0} name='{1}' id='{2}'" -f $ct, $e.Current.Name, $e.Current.AutomationId) }
  }
}

if ($Path) {
  # File dialogs: put the path in the file-name box (control id 1148 in Open, 1001 in Save)
  # and confirm with Enter, which is what a person does.
  $edit = $null
  foreach ($id in @('1148', '1001')) {
    $edit = $win.FindFirst($TS::Descendants, (And (Cond $AE::AutomationIdProperty $id) (Cond $AE::ControlTypeProperty $CT::Edit)))
    if ($edit) { break }
  }
  if (-not $edit) {
    $edit = $win.FindFirst($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Edit))
  }
  if (-not $edit) { Write-Output "NOEDIT"; Describe $win; exit 4 }
  $edit.SetFocus()
  Start-Sleep -Milliseconds 300
  try { $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Path) } catch {
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait(($Path -replace '([+^%~(){}\[\]])', '{$1}'))
  }
  Start-Sleep -Milliseconds 300
  $edit.SetFocus()
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 500
  Write-Output "OK"; exit 0
}

# Buttons: exact name first, then a match ignoring "&" accelerators and case.
$btn = $null
for ($i = 0; $i -lt 20 -and -not $btn; $i++) {
  $btn = $win.FindFirst($TS::Descendants, (And (Cond $AE::NameProperty $Button) (Cond $AE::ControlTypeProperty $CT::Button)))
  if (-not $btn) {
    foreach ($b in $win.FindAll($TS::Descendants, (Cond $AE::ControlTypeProperty $CT::Button))) {
      if (($b.Current.Name -replace '&', '').Trim() -ieq $Button) { $btn = $b; break }
    }
  }
  if (-not $btn) { Start-Sleep -Milliseconds 200 }
}
if (-not $btn) { Write-Output "NOBUTTON"; Describe $win; exit 3 }
$btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Output "OK"

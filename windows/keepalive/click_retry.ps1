param()
# Click the "Retry" button on the latest error card in the Codex desktop app
# via UI Automation. No window activation or focus stealing needed.
#
# Electron/Chromium only builds the renderer accessibility tree when a screen
# reader is detected, so we briefly flip the SPI_SETSCREENREADER system flag,
# wait for the tree, find the button, invoke it, and restore the flag.
# Outputs "invoked" on success, "not-found" when no Retry button is present.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SRFlag {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SystemParametersInfo(uint action, uint param, IntPtr v, uint ini);
  public const uint SPI_GETSCREENREADER = 0x0046;
  public const uint SPI_SETSCREENREADER = 0x0047;
  public const uint SPIF_UPDATEINIFILE = 0x01;
  public const uint SPIF_SENDCHANGE = 0x02;
}
"@

function Get-CodexHwnd {
    $procs = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like '*OpenAI.Codex*' -and $_.MainWindowHandle -ne 0 }
    if ($procs) { return $procs[0].MainWindowHandle }
    return [IntPtr]::Zero
}

$hwnd = Get-CodexHwnd
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "no-window"; exit 2 }

# Remember and flip the screen reader flag so Chromium materializes the tree.
$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal(4)
[SRFlag]::SystemParametersInfo([SRFlag]::SPI_GETSCREENREADER, 0, $ptr, 0) | Out-Null
$was = [System.Runtime.InteropServices.Marshal]::ReadInt32($ptr)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
if ($was -eq 0) {
    [SRFlag]::SystemParametersInfo([SRFlag]::SPI_SETSCREENREADER, 1, [IntPtr]::Zero, [SRFlag]::SPIF_SENDCHANGE) | Out-Null
}

try {
    $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $button = $null
    foreach ($name in @('Retry', '重试', '重试此 turn', 'Retry this turn')) {
        $cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, $name)
        $button = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $cond)
        if ($button) { break }
    }
    if (-not $button) {
        # First-time a11y activation can take a moment; retry once.
        Start-Sleep -Milliseconds 1500
        foreach ($name in @('Retry', '重试', '重试此 turn', 'Retry this turn')) {
            $cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, $name)
            $button = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $cond)
            if ($button) { break }
        }
    }
    if (-not $button) { Write-Output "not-found"; exit 1 }
    $invoke = $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    Write-Output "invoked"
} finally {
    if ($was -eq 0) {
        [SRFlag]::SystemParametersInfo([SRFlag]::SPI_SETSCREENREADER, 0, [IntPtr]::Zero, [SRFlag]::SPIF_SENDCHANGE) | Out-Null
    }
}

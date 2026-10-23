param(
    [Parameter(Mandatory=$true)][string]$Text,
    [switch]$Enter,
    [switch]$ClearOnly
)

# Bring the Codex desktop window to the foreground, type $Text into it
# (Unicode-safe, works with CJK and any keyboard layout), optionally press
# Enter. With -ClearOnly it just sends Ctrl+A + Del to clear the composer.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class Native {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion u; }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public MOUSEINPUT mi;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError=true)]
    public static extern uint SendInput(uint n, INPUT[] inputs, int size);

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;
    public const ushort VK_RETURN = 0x0D;
    public const ushort VK_CONTROL = 0x11;
    public const ushort VK_MENU = 0x12;
    public const ushort VK_A = 0x41;
    public const ushort VK_DELETE = 0x2E;

    public static void TypeUnicode(string s) {
        var inputs = new System.Collections.Generic.List<INPUT>();
        foreach (char c in s) {
            inputs.Add(new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT {
                wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE, time = 0, dwExtraInfo = IntPtr.Zero } } });
            inputs.Add(new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT {
                wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time = 0, dwExtraInfo = IntPtr.Zero } } });
        }
        SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Key(ushort vk) {
        var down = new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = 0 } } };
        var up   = new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = KEYEVENTF_KEYUP } } };
        SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void CtrlKey(ushort vk) {
        var ctrlDown = new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = VK_CONTROL } } };
        var key = new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = vk } } };
        var ctrlUp = new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = VK_CONTROL, dwFlags = KEYEVENTF_KEYUP } } };
        SendInput(3, new INPUT[] { ctrlDown, key, ctrlUp }, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@

function Find-CodexWindow {
    $procs = Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like '*OpenAI.Codex*' }
    foreach ($p in $procs) {
        if ($p.MainWindowHandle -ne 0) { return $p.MainWindowHandle }
    }
    return [IntPtr]::Zero
}

$hwnd = Find-CodexWindow
if ($hwnd -eq [IntPtr]::Zero) { Write-Error "Codex desktop window not found"; exit 2 }

$prevFg = [Native]::GetForegroundWindow()
if ($prevFg -ne $hwnd) {
    if ([Native]::IsIconic($hwnd)) { [Native]::ShowWindow($hwnd, 9) | Out-Null }  # SW_RESTORE
    # SetForegroundWindow is restricted unless we share input state with the
    # current foreground thread; attach briefly to get permission.
    $fgPid = 0
    $fgThread = [Native]::GetWindowThreadProcessId($prevFg, [ref]$fgPid)
    $ourThread = [Native]::GetCurrentThreadId()
    $attached = $false
    if ($fgThread -ne 0 -and $fgThread -ne $ourThread) {
        $attached = [Native]::AttachThreadInput($ourThread, $fgThread, $true)
    }
    [Native]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 250
    if ($attached) { [Native]::AttachThreadInput($ourThread, $fgThread, $false) | Out-Null }
}

if ($ClearOnly) {
    [Native]::CtrlKey([Native]::VK_A)
    Start-Sleep -Milliseconds 60
    [Native]::Key([Native]::VK_DELETE)
    Write-Output "cleared"
} else {
    [Native]::TypeUnicode($Text)
    if ($Enter) {
        Start-Sleep -Milliseconds 150
        [Native]::Key([Native]::VK_RETURN)
    }
    Write-Output "typed"
}

# Hand focus back to whatever the user had in front.
Start-Sleep -Milliseconds 150
if ($prevFg -ne [IntPtr]::Zero -and $prevFg -ne $hwnd) {
    [Native]::SetForegroundWindow($prevFg) | Out-Null
}

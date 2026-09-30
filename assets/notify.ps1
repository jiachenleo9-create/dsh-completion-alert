# dsh-completion-alert · bottom-right always-on-top card.
#
# ASCII-only on purpose: every localized string arrives in the UTF-8 JSON
# payload written by the host half, so this file never depends on the code page
# Windows PowerShell would otherwise use to read it.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File notify.ps1 -Payload <json>

param(
  [Parameter(Mandatory = $true)][string]$Payload
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Payload)) { exit 1 }
$data = Get-Content -LiteralPath $Payload -Raw -Encoding UTF8 | ConvertFrom-Json

# Optional diagnostic trail (payload.logPath); silent in normal use.
$logPath = if ($data.logPath) { [string]$data.logPath } else { $null }
function Write-Trace([string]$message) {
  if (-not $logPath) { return }
  try { [System.IO.File]::AppendAllText($logPath, ((Get-Date).ToString('HH:mm:ss.fff') + '  ' + $message + [Environment]::NewLine)) } catch { }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- native helpers --------------------------------------------------------
$nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace DshAlert {
  /// <summary>Borderless card that never takes focus from the user's window.</summary>
  public class CardForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
      get {
        CreateParams cp = base.CreateParams;
        cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
        cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW (stay out of Alt+Tab)
        return cp;
      }
    }
  }

  /// <summary>Window lookup and activation for the click action.</summary>
  public static class Win {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr param);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);

    /// <summary>
    /// Find a top-level window by title. Hidden windows are searched too by
    /// default because the desktop application hides its main window to the
    /// tray, and a hidden window is exactly the case this alert must restore.
    /// </summary>
    public static IntPtr FindByTitle(string needle, bool visibleOnly) {
      if (string.IsNullOrEmpty(needle)) return IntPtr.Zero;
      IntPtr found = IntPtr.Zero;
      EnumWindows(delegate(IntPtr hWnd, IntPtr param) {
        if (visibleOnly && !IsWindowVisible(hWnd)) return true;
        if (GetWindow(hWnd, 4 /* GW_OWNER */) != IntPtr.Zero) return true; // skip owned popups
        StringBuilder buffer = new StringBuilder(512);
        GetWindowTextW(hWnd, buffer, buffer.Capacity);
        string title = buffer.ToString();
        if (title.Length > 0 && title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
          found = hWnd;
          return false;
        }
        return true;
      }, IntPtr.Zero);
      return found;
    }

    /// <summary>
    /// Make a window usable again and bring it to the front: unhide a
    /// tray-hidden window, restore a minimized one, then activate it.
    /// A plain cross-process ShowWindow is queued to the owning thread and can
    /// be dropped, so the reveal uses the asynchronous form plus a
    /// SWP_SHOWWINDOW placement, which is honoured across processes.
    /// </summary>
    public static bool Reveal(IntPtr hWnd) {
      if (hWnd == IntPtr.Zero) return false;
      if (!IsWindowVisible(hWnd)) {
        ShowWindowAsync(hWnd, 5);                                          // SW_SHOW
        SetWindowPos(hWnd, IntPtr.Zero, 0, 0, 0, 0, 0x0040 | 0x0001 | 0x0002); // SWP_SHOWWINDOW | NOSIZE | NOMOVE
        System.Threading.Thread.Sleep(140);
      }
      if (IsIconic(hWnd)) ShowWindowAsync(hWnd, 9); // SW_RESTORE
      return Activate(hWnd);
    }

    /// <summary>
    /// Raise a window even though this process never owned the foreground: the
    /// Windows foreground lock rejects a bare SetForegroundWindow from a
    /// background helper, so attach to the current input queues and tap ALT
    /// first, then fall back to the task-switch API.
    /// </summary>
    public static bool Activate(IntPtr hWnd) {
      if (hWnd == IntPtr.Zero) return false;
      if (IsIconic(hWnd)) ShowWindowAsync(hWnd, 9); // SW_RESTORE
      if (GetForegroundWindow() == hWnd) return true;

      IntPtr foreground = GetForegroundWindow();
      uint targetThread = GetWindowThreadProcessId(hWnd, IntPtr.Zero);
      uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
      uint currentThread = GetCurrentThreadId();
      bool attachedTarget = false;
      bool attachedForeground = false;
      try {
        if (targetThread != 0 && targetThread != currentThread) attachedTarget = AttachThreadInput(currentThread, targetThread, true);
        if (foregroundThread != 0 && foregroundThread != currentThread) attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
        bool raised = SetForegroundWindow(hWnd) || BringWindowToTop(hWnd);
        if (GetForegroundWindow() != hWnd) {
          // Foreground lock: a brief ALT tap marks the call as user-initiated.
          // Only used as a fallback so the desktop never sees stray ALT input.
          keybd_event(0x12, 0, 0, UIntPtr.Zero); // ALT down
          raised = SetForegroundWindow(hWnd) || BringWindowToTop(hWnd);
          keybd_event(0x12, 0, 2, UIntPtr.Zero); // ALT up
        }
        if (GetForegroundWindow() != hWnd) {
          SwitchToThisWindow(hWnd, true);
          raised = GetForegroundWindow() == hWnd;
        }
        return raised;
      } finally {
        if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      }
    }
  }
}
'@

$hasNative = $false
$cardFormType = [System.Windows.Forms.Form]
try {
  # The WinForms/Win32 helper needs explicit references: Add-Type does not add
  # System.Windows.Forms on its own, and without it the card would silently fall
  # back to a focus-stealing form with no window-activation support.
  Add-Type -TypeDefinition $nativeSource -Language CSharp -ReferencedAssemblies @('System.Windows.Forms.dll', 'System.Drawing.dll')
  $cardFormType = [DshAlert.CardForm]
  $hasNative = $true
} catch {
  Write-Trace "native helper unavailable: $($_.Exception.Message)"
}
Write-Trace "native=$hasNative mode=$($data.mode) session=$($data.sessionId)"

# --- chime -----------------------------------------------------------------
if ($data.sound -and $data.dingPath -and (Test-Path -LiteralPath $data.dingPath)) {
  try {
    $player = New-Object System.Media.SoundPlayer([string]$data.dingPath)
    if ($data.popup) { $player.Play() } else { $player.PlaySync() }
    $script:player = $player   # keep the object alive while the card is open
  } catch { }
}
if (-not $data.popup) { exit 0 }

# --- card ------------------------------------------------------------------
try { [System.Windows.Forms.Application]::SetHighDpiMode(2) | Out-Null } catch { }

$accentColor = switch ([string]$data.reason) {
  'completed' { [System.Drawing.Color]::FromArgb(52, 199, 123) }
  'error' { [System.Drawing.Color]::FromArgb(232, 90, 90) }
  'blocked' { [System.Drawing.Color]::FromArgb(232, 90, 90) }
  'max-tokens' { [System.Drawing.Color]::FromArgb(232, 168, 74) }
  'approval' { [System.Drawing.Color]::FromArgb(88, 156, 255) }
  'question' { [System.Drawing.Color]::FromArgb(168, 130, 255) }
  default { [System.Drawing.Color]::FromArgb(232, 168, 74) }
}

$cardWidth = 384
$cardHeight = 126
$background = [System.Drawing.Color]::FromArgb(26, 28, 34)
$backgroundHover = [System.Drawing.Color]::FromArgb(36, 39, 48)

$form = [System.Activator]::CreateInstance($cardFormType)
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Text = 'DSH'
$form.BackColor = $background
$form.ClientSize = New-Object System.Drawing.Size($cardWidth, $cardHeight)

# Rounded corners.
try {
  $radius = 14
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $radius, $radius, 180, 90)
  $path.AddArc($cardWidth - $radius, 0, $radius, $radius, 270, 90)
  $path.AddArc($cardWidth - $radius, $cardHeight - $radius, $radius, $radius, 0, 90)
  $path.AddArc(0, $cardHeight - $radius, $radius, $radius, 90, 90)
  $path.CloseAllFigures()
  $form.Region = New-Object System.Drawing.Region($path)
} catch { }

$accent = New-Object System.Windows.Forms.Panel
$accent.BackColor = $accentColor
$accent.SetBounds(0, 0, 5, $cardHeight)
$form.Controls.Add($accent)

$fontFamily = 'Microsoft YaHei UI'
$heading = New-Object System.Windows.Forms.Label
$heading.Text = [string]$data.heading
$heading.ForeColor = [System.Drawing.Color]::FromArgb(245, 247, 250)
$heading.Font = New-Object System.Drawing.Font($fontFamily, 12.5, [System.Drawing.FontStyle]::Bold)
$heading.AutoSize = $false
$heading.AutoEllipsis = $true
$heading.SetBounds(20, 16, 300, 26)
$form.Controls.Add($heading)

$title = New-Object System.Windows.Forms.Label
$title.Text = [string]$data.title
$title.ForeColor = [System.Drawing.Color]::FromArgb(178, 188, 204)
$title.Font = New-Object System.Drawing.Font($fontFamily, 9.5)
$title.AutoSize = $false
$title.AutoEllipsis = $true
$title.SetBounds(20, 46, 344, 22)
$form.Controls.Add($title)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = [string]$data.hint
$hint.ForeColor = [System.Drawing.Color]::FromArgb(126, 138, 156)
$hint.Font = New-Object System.Drawing.Font($fontFamily, 8.5)
$hint.AutoSize = $false
$hint.AutoEllipsis = $true
$hint.SetBounds(20, 82, 344, 20)
$form.Controls.Add($hint)

$close = New-Object System.Windows.Forms.Label
$close.Text = [string][char]0x2715
$close.ForeColor = [System.Drawing.Color]::FromArgb(120, 130, 148)
$close.Font = New-Object System.Drawing.Font($fontFamily, 9)
$close.AutoSize = $false
$close.TextAlign = 'MiddleCenter'
$close.SetBounds(346, 10, 28, 26)
$close.Cursor = [System.Windows.Forms.Cursors]::Hand
$form.Controls.Add($close)

# --- click behavior --------------------------------------------------------
# Titles that identify the application window: the page's own title first (it
# names the finished session), then the product name as a stable fallback.
$windowTitles = @()
if ($data.matchTitle) { $windowTitles += [string]$data.matchTitle }
$windowTitles += 'DeepSeek Harness'
$script:pendingRestore = $false

$activate = {
  Write-Trace 'click received'
  if ($data.claimPath) {
    try {
      $claim = @{ sessionId = [string]$data.sessionId; at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
      [System.IO.File]::WriteAllText([string]$data.claimPath, $claim, (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
  }

  $raised = $false
  # Fast path: the window already exists, so reveal and raise it directly. The
  # click itself grants this process the user-interaction right Windows requires
  # for a foreground switch, which makes the direct route both instant and
  # reliable. Hidden windows are included on purpose: the desktop application
  # parks its main window in the tray, and that is the state we must undo.
  if ($hasNative) {
    foreach ($needle in $windowTitles) {
      $target = [DshAlert.Win]::FindByTitle($needle, $false)
      if ($target -eq [IntPtr]::Zero) { continue }
      $shown = [DshAlert.Win]::Reveal($target)
      Write-Trace "reveal '$needle' handle $target visible=$([DshAlert.Win]::IsWindowVisible($target)) raised=$shown"
      if ($shown) { $raised = $true; break }
    }
    Write-Trace "fast path raised=$raised"
  }
  if (-not $raised -and $data.mode -eq 'browser' -and $data.url) {
    try { Start-Process ([string]$data.url) | Out-Null; $raised = $true } catch { }
  }
  if (-not $raised) {
    # The window is gone or the direct route was refused: hand the job to the
    # post-card phase, which asks the application's own dsh:// entry point to
    # restore it and waits long enough for a cold Electron launch.
    $script:pendingRestore = $true
    Write-Trace 'queued background restore via dsh://open'
  }
  $form.Close()
}

$dismiss = { $form.Close() }

$form.Add_Click($activate)
$accent.Add_Click($activate)
$heading.Add_Click($activate)
$title.Add_Click($activate)
$hint.Add_Click($activate)
$close.Add_Click($dismiss)

# Pointer feedback so the card reads as clickable.
foreach ($control in @($form, $accent, $heading, $title, $hint)) {
  $control.Cursor = [System.Windows.Forms.Cursors]::Hand
  $control.Add_MouseEnter({ $form.BackColor = $backgroundHover })
  $control.Add_MouseLeave({ $form.BackColor = $background })
}

# --- placement -------------------------------------------------------------
try {
  $cursor = [System.Windows.Forms.Cursor]::Position
  $screen = [System.Windows.Forms.Screen]::FromPoint($cursor)
} catch {
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen
}
$area = $screen.WorkingArea
$margin = 18
$x = $area.Right - $cardWidth - $margin
$y = $area.Bottom - $cardHeight - $margin
switch ([string]$data.corner) {
  'bl' { $x = $area.Left + $margin; $y = $area.Bottom - $cardHeight - $margin }
  'tr' { $x = $area.Right - $cardWidth - $margin; $y = $area.Top + $margin }
  'tl' { $x = $area.Left + $margin; $y = $area.Top + $margin }
}
$form.Location = New-Object System.Drawing.Point($x, $y)
Write-Trace "card placed at $x,$y (${cardWidth}x${cardHeight}) corner=$($data.corner) seconds=$($data.seconds)"

# --- lifetime --------------------------------------------------------------
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(3, [int]$data.seconds) * 1000
$timer.Add_Tick({ $timer.Stop(); Write-Trace 'auto-close'; $form.Close() })
$timer.Start()
$script:timer = $timer

[System.Windows.Forms.Application]::Run($form)
$timer.Stop()
$form.Dispose()

# --- background restore ----------------------------------------------------
# The card is gone by now, so a slow restore costs the user nothing: ask the
# application's own dsh:// entry point to bring the window back (this also
# recreates it when it was destroyed) and then force it to the front, waiting
# long enough for a cold Electron launch.
if ($script:pendingRestore -and $hasNative) {
  Write-Trace 'restoring the application window via dsh://open'
  try { Start-Process 'dsh://open' | Out-Null } catch { Write-Trace "dsh://open failed: $($_.Exception.Message)" }
  $deadline = (Get-Date).AddSeconds(12)
  $restored = $false
  while (-not $restored -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    foreach ($needle in $windowTitles) {
      $target = [DshAlert.Win]::FindByTitle($needle, $false)
      if ($target -eq [IntPtr]::Zero) { continue }
      if ([DshAlert.Win]::Reveal($target)) {
        Write-Trace "restored window '$needle' handle $target"
        $restored = $true
        break
      }
    }
  }
  Write-Trace "background restore finished (success=$restored)"
}

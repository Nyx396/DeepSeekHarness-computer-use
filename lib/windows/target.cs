// Plugin-owned preparation and last-moment input guards. No model-supplied
// executable, title matching, background input, or global Show Desktop toggle.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DshDesktopControl {
  public sealed class WindowState {
    public long window, owner;
    public uint process;
    public string title, className;
    public int x, y, width, height, showCommand;
    public uint extendedStyle;
    public bool visible, minimized, enabled, cloaked, transparent, layered, noActivate, shellSurface, shellChrome, canMinimize;
  }
  public sealed class Preparation {
    public long window, foreground;
    public WindowState foregroundWindow;
    public bool ready, changed;
    public int focusAttempts, focusWaitMs;
    public string reason;
    public readonly List<WindowState> minimized = new List<WindowState>();
    public readonly List<WindowState> blockers = new List<WindowState>();
    public readonly List<WindowState> foregroundSamples = new List<WindowState>();
  }
  // This boundary lets regression tests exercise real policy with a simulated
  // window manager; those tests never move the user's pointer or windows.
  public interface IWindows {
    WindowState Read(long window);
    long Foreground { get; }
    long[] ZOrder();
    long RootAt(int x, int y);
    void Cursor(out int x, out int y);
    void Restore(long window);
    void Activate(long window);
    void Minimize(long window);
    void Check();
    void Wait(int milliseconds);
  }
  public static class TargetWorkflow {
    public static bool Matches(IWindows windows, long target, long candidate) {
      if (target == 0 || candidate == 0) return false;
      if (target == candidate) return true;
      WindowState a = windows.Read(target), b = windows.Read(candidate);
      return a != null && b != null && a.shellSurface && b.shellSurface && a.process == b.process;
    }
    static bool Overlaps(WindowState a, WindowState b) {
      return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 &&
        (long)a.x < (long)b.x + b.width && (long)b.x < (long)a.x + a.width &&
        (long)a.y < (long)b.y + b.height && (long)b.y < (long)a.y + a.height;
    }
    static bool ReceivesInputOverTarget(IWindows windows, WindowState target, WindowState candidate) {
      // Bounding rectangles alone also describe per-pixel transparent video,
      // GPU and pet overlays. Require a real hit-test witness in the overlap.
      // The final input point is still checked independently before dispatch.
      long left = Math.Max(target.x, candidate.x), top = Math.Max(target.y, candidate.y);
      long width = Math.Min((long)target.x + target.width, (long)candidate.x + candidate.width) - left;
      long height = Math.Min((long)target.y + target.height, (long)candidate.y + candidate.height) - top;
      if (width <= 0 || height <= 0) return false;
      int[] fractions = { 15, 50, 85 };
      foreach (int fx in fractions) foreach (int fy in fractions) {
        windows.Check();
        int x = (int)(left + (width - 1) * fx / 100), y = (int)(top + (height - 1) * fy / 100);
        if (windows.RootAt(x, y) == candidate.window) return true;
      }
      return false;
    }
    public static List<WindowState> Blockers(IWindows windows, long target) {
      WindowState wanted = windows.Read(target);
      if (wanted == null) throw new InvalidOperationException("DESKTOP_TARGET_UNAVAILABLE: target window no longer exists.");
      var result = new List<WindowState>();
      bool found = false;
      foreach (long handle in windows.ZOrder()) {
        if (target == handle) { found = true; break; }
        WindowState other = windows.Read(handle);
        if (other == null || !other.visible || other.minimized || other.cloaked || other.transparent || other.shellChrome || other.shellSurface) continue;
        if (Overlaps(wanted, other) && ReceivesInputOverTarget(windows, wanted, other)) result.Add(other);
      }
      if (!found) throw new InvalidOperationException("DESKTOP_TARGET_UNAVAILABLE: target is absent from the current desktop Z order.");
      return result;
    }
    static bool Ready(IWindows windows, long target) {
      WindowState state = windows.Read(target);
      return state != null && state.visible && !state.minimized && state.enabled && !state.cloaked &&
        Matches(windows, target, windows.Foreground) && Blockers(windows, target).Count == 0;
    }
    static void Activate(IWindows windows, long target, Preparation result) {
      windows.Check(); windows.Activate(target); result.focusAttempts++; result.changed = true;
    }
    static bool SettleForeground(IWindows windows, long target, Preparation result) {
      // Poll between sparse activation requests. A shell transition or layered
      // overlay can outlive the old 160/240ms retries. This never sends input,
      // alters overlay styles, or treats mouse transparency as keyboard focus.
      const int budget = 1600, interval = 80;
      int nextActivation = 0, elapsed = 0;
      while (elapsed < budget) {
        windows.Check();
        if (Ready(windows, target)) {
          int stableWait = Math.Min(60, budget - elapsed);
          windows.Wait(stableWait); result.focusWaitMs += stableWait; elapsed += stableWait;
          if (Ready(windows, target)) return true;
        }
        if (elapsed >= budget) break;
        if (Blockers(windows, target).Count != 0) return false;
        WindowState foreground = windows.Read(windows.Foreground);
        if (foreground != null) {
          if (result.foregroundSamples.Count < 8 &&
              (result.foregroundSamples.Count == 0 || result.foregroundSamples[result.foregroundSamples.Count - 1].window != foreground.window))
            result.foregroundSamples.Add(foreground);
          // Do not repeatedly steal focus from an ordinary unrelated app.
          if (!foreground.transparent && !foreground.layered && !foreground.noActivate && !foreground.shellChrome) return false;
        }
        if (elapsed >= nextActivation) { Activate(windows, target, result); nextActivation = elapsed + 480; }
        int wait = Math.Min(interval, budget - elapsed);
        windows.Wait(wait); result.focusWaitMs += wait; elapsed += wait;
      }
      return Ready(windows, target);
    }
    public static Preparation Prepare(IWindows windows, long target) {
      windows.Check();
      var result = new Preparation { window = target, foreground = windows.Foreground };
      WindowState state = windows.Read(target);
      if (state == null || !state.visible || !state.enabled || state.cloaked) {
        result.reason = "DESKTOP_TARGET_UNAVAILABLE: target is missing, disabled, hidden or on another desktop.";
        return result;
      }
      if (Ready(windows, target)) { result.ready = true; result.foreground = windows.Foreground; return result; }
      if (state.minimized) { windows.Check(); windows.Restore(target); windows.Wait(120); result.changed = true; }
      Activate(windows, target, result); windows.Wait(120);
      if (Ready(windows, target)) { result.ready = true; result.foreground = windows.Foreground; return result; }
      // Only windows actually above and geometrically intersecting this target
      // can be minimized. Owned dialogs, shell chrome and unknown surfaces stay.
      var attempted = new HashSet<long>();
      while (attempted.Count < 32) {
        windows.Check();
        // Removing one blocker can reveal another. Recompute the hit-tested
        // stack rather than trusting one stale list or minimizing hidden apps.
        WindowState current = Blockers(windows, target).Find(w => !attempted.Contains(w.window) && w.canMinimize && w.owner == 0 && !w.shellSurface);
        if (current == null) break;
        attempted.Add(current.window);
        windows.Check();
        windows.Minimize(current.window); windows.Wait(100);
        WindowState after = windows.Read(current.window);
        if (after != null && after.minimized) result.minimized.Add(current);
      }
      Activate(windows, target, result); windows.Wait(120);
      // Minimize/foreground transitions are asynchronous. A transparent layer
      // or the taskbar may temporarily retain foreground after blockers vanish.
      // Settle focus within this preparation call; never treat transparency as
      // permission to paste into the window which still owns keyboard focus.
      if (!Ready(windows, target)) SettleForeground(windows, target, result);
      result.ready = Ready(windows, target); result.foreground = windows.Foreground;
      if (!result.ready) {
        result.foregroundWindow = windows.Read(result.foreground);
        result.blockers.AddRange(Blockers(windows, target));
        result.reason = result.blockers.Count == 0
          ? "DESKTOP_TARGET_FOCUS_NOT_READY: no input-blocking window was found, but target foreground/focus is not ready after bounded preparation. No input was sent. Inspect foregroundWindow; do not bypass focus checks or loop activation."
          : "DESKTOP_TARGET_BLOCKED: preparation could not expose the target; no input was sent. Inspect blockers, do not repeat unchanged clicks.";
      }
      return result;
    }
    public static void AssertKeyboard(IWindows windows, long target) {
      windows.Check();
      WindowState state = windows.Read(target);
      if (state == null || !state.visible || state.minimized || !state.enabled || state.cloaked || !Matches(windows, target, windows.Foreground))
        throw new InvalidOperationException("DESKTOP_TARGET_CHANGED: target lost foreground/focus; observe it again before input.");
    }
    public static void AssertPoint(IWindows windows, long target, int x, int y, bool checkCursor) {
      AssertKeyboard(windows, target);
      if (!Matches(windows, target, windows.RootAt(x, y)))
        throw new InvalidOperationException("DESKTOP_POINT_OCCLUDED: the input point belongs to another window; observe/prepare the target again. No input was sent.");
      if (checkCursor) {
        int actualX, actualY; windows.Cursor(out actualX, out actualY);
        if (actualX != x || actualY != y)
          throw new InvalidOperationException("DESKTOP_POINTER_MOVED: shared pointer changed before dispatch; no input was sent.");
      }
    }
    public static Preparation Prepare(long target, Action cancellation) { return Prepare(new NativeWindows(cancellation), target); }
    public static void AssertKeyboard(long target, Action cancellation) { AssertKeyboard(new NativeWindows(cancellation), target); }
    public static void AssertPoint(long target, int x, int y, bool checkCursor, Action cancellation) { AssertPoint(new NativeWindows(cancellation), target, x, y, checkCursor); }
  }
  public sealed class NativeWindows : IWindows {
    readonly Action cancellation;
    public NativeWindows(Action cancellation) { this.cancellation = cancellation; }
    public static bool IsClickThrough(uint extendedStyle) { return (extendedStyle & 0x00080020u) == 0x00080020u; }
    public void Check() { if (cancellation != null) cancellation(); }
    public void Wait(int ms) { for (int elapsed = 0; elapsed < ms; elapsed += 20) { Check(); Thread.Sleep(Math.Min(20, ms - elapsed)); } Check(); }
    public long Foreground { get { return GetAncestor(GetForegroundWindow(), 2).ToInt64(); } }
    public long[] ZOrder() {
      var handles = new List<long>(); EnumWindows(delegate(IntPtr h, IntPtr unused) { handles.Add(h.ToInt64()); return true; }, IntPtr.Zero); return handles.ToArray();
    }
    public WindowState Read(long handle) {
      IntPtr h = new IntPtr(handle); if (handle == 0 || !IsWindow(h)) return null;
      RECT rect; if (!GetWindowRect(h, out rect)) return null;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var title = new StringBuilder(512); GetWindowText(h, title, title.Capacity);
      var name = new StringBuilder(256); GetClassName(h, name, name.Capacity);
      uint style = unchecked((uint)GetWindowLong(h, -16)), ex = unchecked((uint)GetWindowLong(h, -20));
      uint shellPid; GetWindowThreadProcessId(GetShellWindow(), out shellPid);
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) != 0) cloaked = 0;
      var placement = new WINDOWPLACEMENT(); placement.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT)); GetWindowPlacement(h, ref placement);
      bool surface = shellPid != 0 && pid == shellPid && (name.ToString() == "Progman" || name.ToString() == "WorkerW");
      return new WindowState { window = handle, process = pid, title = title.ToString(), className = name.ToString(),
        x = rect.left, y = rect.top, width = rect.right - rect.left, height = rect.bottom - rect.top,
        showCommand = placement.showCmd, owner = GetWindow(h, 4).ToInt64(), visible = IsWindowVisible(h),
        enabled = IsWindowEnabled(h), minimized = IsIconic(h), cloaked = cloaked != 0,
        extendedStyle = ex, transparent = IsClickThrough(ex), layered = (ex & 0x00080000u) != 0,
        noActivate = (ex & 0x08000000u) != 0, shellSurface = surface,
        shellChrome = name.ToString() == "Shell_TrayWnd" || name.ToString() == "Shell_SecondaryTrayWnd",
        canMinimize = (style & 0x00020000u) != 0 && !surface };
    }
    public long RootAt(int x, int y) {
      long root = GetAncestor(WindowFromPoint(new POINT { x = x, y = y }), 2).ToInt64();
      WindowState hit = Read(root);
      // Layered transparent windows pass input through (WS_EX_NOACTIVATE is
      // independent). This includes fullscreen desktop-pet/indicator layers.
      // visible input-receiving surface below them is the relevant target.
      if (hit != null && hit.transparent) {
        foreach (long handle in ZOrder()) {
          WindowState w = Read(handle);
          if (w == null || !w.visible || w.minimized || w.cloaked || w.transparent) continue;
          if (x >= w.x && y >= w.y && (long)x < (long)w.x + w.width && (long)y < (long)w.y + w.height) return handle;
        }
        return 0;
      }
      return root;
    }
    public void Cursor(out int x, out int y) { POINT p; if (!GetCursorPos(out p)) throw new InvalidOperationException("DESKTOP_INPUT_UNAVAILABLE: cannot read pointer."); x = p.x; y = p.y; }
    public void Restore(long window) { Check(); ShowWindowAsync(new IntPtr(window), 9); }
    public void Minimize(long window) { Check(); ShowWindowAsync(new IntPtr(window), 6); }
    public void Activate(long window) {
      Check(); var h = new IntPtr(window); WindowState state = Read(window);
      if (state == null) return;
      uint unused; uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out unused), currentThread = GetCurrentThreadId();
      uint targetThread = GetWindowThreadProcessId(h, out unused);
      bool attached = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
      bool targetAttached = false;
      try {
        // The target may belong to a third queue (e.g. Explorer behind a pet).
        // Link it as well; do not SetFocus on the root and lose editor focus.
        if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread)
          targetAttached = AttachThreadInput(currentThread, targetThread, true);
        Check();
        // Shell desktop surfaces have special Z-order semantics. Minimize
        // their real blockers through the same preparation policy instead.
        if (!state.shellSurface) SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x4043);
        Check(); SetForegroundWindow(h);
      } finally {
        if (targetAttached) AttachThreadInput(currentThread, targetThread, false);
        if (attached) AttachThreadInput(currentThread, foregroundThread, false);
      }
    }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT minPosition, maxPosition; public RECT normalPosition; }
    delegate bool EnumCallback(IntPtr window, IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr value);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint command);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint process);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int command);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out int value, int size);
  }
}

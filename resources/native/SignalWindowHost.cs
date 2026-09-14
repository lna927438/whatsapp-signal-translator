// HelloDog local window host. It can operate only on the two process-owned HWNDs
// supplied at launch; it does not enumerate or attach to any installed app.
using System;
using System.Runtime.InteropServices;
public static class SignalWindowHost {
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr child);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr window, int index, int value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flag);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr window);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  static bool Owned(IntPtr window, uint expected) { uint actual; GetWindowThreadProcessId(window, out actual); return IsWindow(window) && actual == expected; }
  public static int Main(string[] args) {
    try {
      if (args.Length != 4) return 2;
      var parent = new IntPtr(long.Parse(args[0])); var child = new IntPtr(long.Parse(args[1]));
      var parentPid = uint.Parse(args[2]); var childPid = uint.Parse(args[3]);
      SetThreadDpiAwarenessContext(new IntPtr(-4));
      if (!Owned(parent,parentPid) || !Owned(child,childPid)) return 3;
      ShowWindow(child,0);
      var style = GetWindowLong(child,-16);
      // SetParent does not clear WS_POPUP. An embedded child must not retain
      // popup/overlapped styles, which interfere with activation and key focus.
      SetWindowLong(child,-16,(style & ~0x00CF0000 & 0x7FFFFFFF) | 0x40000000);
      SetParent(child,parent);
      if (GetParent(child) != parent) return 4;
      Console.WriteLine("attached"); Console.Out.Flush();
      string line;
      while ((line=Console.ReadLine()) != null) {
        if (!Owned(parent,parentPid) || !Owned(child,childPid)) return 5;
        var parts=line.Split(' ');
        if(parts[0]=="hide") ShowWindow(child,0);
        else if(parts[0]=="show") ShowWindow(child,4);
        else if((parts[0]=="focus"||parts[0]=="focus-host") && IsWindowVisible(child) && GetAncestor(GetForegroundWindow(),2)==parent) {
          // Chromium's DOM focus does not move keyboard focus across the native
          // process boundary after SetParent. Transfer it only on an explicit
          // click/activation of this visible account, never from a background one.
          var target=parts[0]=="focus-host"?parent:child;
          uint ignored; var thread=GetWindowThreadProcessId(target,out ignored);var current=GetCurrentThreadId();
          if(AttachThreadInput(current,thread,true)) {try {SetFocus(target);} finally {AttachThreadInput(current,thread,false);}}
        }
        else if(parts[0]=="bounds" && parts.Length==5) {
          int x=int.Parse(parts[1]),y=int.Parse(parts[2]),w=int.Parse(parts[3]),h=int.Parse(parts[4]);
          if(x<0||y<0||w<1||h<1||x>32000||y>32000||w>32000||h>32000) return 6;
          // The outer Chromium surface may reorder its own child HWND on a
          // resize. Keep this account above that surface without activating it.
          if(!SetWindowPos(child,IntPtr.Zero,x,y,w,h,0x0030)) return 7;
        } else if(parts[0]=="quit") { ShowWindow(child,0); return 0; }
      }
      ShowWindow(child,0); return 0;
    } catch(Exception error) { Console.Error.WriteLine(error.GetType().Name); return 9; }
  }
}

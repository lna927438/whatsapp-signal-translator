// Dedicated Google Voice browser window host. It never injects into the browser,
// reads browser storage, or enumerates windows belonging to unverified processes.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class GoogleVoiceWindowHost {
  delegate bool WindowCallback(IntPtr window, IntPtr parameter);
  delegate IntPtr WindowProcedure(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern ushort RegisterClass(ref WindowClass value);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowEx(uint exStyle,string className,string title,uint style,int x,int y,int width,int height,IntPtr owner,IntPtr menu,IntPtr instance,IntPtr parameter);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr DefWindowProc(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool PeekMessage(out Message message,IntPtr window,uint min,uint max,uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref Point point);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Rect rect);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint thread, WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetLong64(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] static extern IntPtr SetLong64(IntPtr window, int index, IntPtr value);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetLong32(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongW", SetLastError=true)] static extern int SetLong32(IntPtr window, int index, int value);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
  [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr window, ref Placement placement);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
  [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flag);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr window);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Placement { public int length,flags,showCommand; public Point min,max; public Rect normal; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct WindowClass { public uint style; public WindowProcedure procedure; public int classExtra,windowExtra; public IntPtr instance,icon,cursor,background; public string menuName,className; }
  [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr window; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public Point point; public uint privateData; }
  static bool paneClose;
  sealed class ControlState {
    public int x,y,width=1,height=1,focus;
    public bool visible,stop,invalid;
    public long revision;
  }
  static void ReadControls(ControlState state) {
    try {
      string line;
      while((line=Console.ReadLine())!=null) {
        lock(state) {
          if(line.Length>128){state.invalid=true;return;}
          var parts=line.Split(' ');
          if(parts[0]=="detach"&&parts.Length==1){state.stop=true;return;}
          if(parts[0]=="hide"&&parts.Length==1){state.visible=false;state.focus=0;}
          else if(parts[0]=="show"&&parts.Length==1)state.visible=true;
          else if(parts[0]=="focus"&&parts.Length==1)state.focus=1;
          else if(parts[0]=="focus-host"&&parts.Length==1)state.focus=2;
          else if(parts[0]=="bounds"&&parts.Length==5) {
            int x,y,width,height;
            if(!Int32.TryParse(parts[1],out x)||!Int32.TryParse(parts[2],out y)||!Int32.TryParse(parts[3],out width)||!Int32.TryParse(parts[4],out height)||x<0||y<0||width<1||height<1||x>64000||y>64000||width>64000||height>64000){state.invalid=true;return;}
            state.x=x;state.y=y;state.width=width;state.height=height;
          } else {state.invalid=true;return;}
          state.revision++;
        }
      }
    } catch { } finally {lock(state){state.stop=true;}}
  }
  static int paneX=Int32.MinValue,paneY=Int32.MinValue,paneWidth=0,paneHeight=0;
  static readonly WindowProcedure paneProcedure=delegate(IntPtr window,uint message,IntPtr wParam,IntPtr lParam) {
    if(message==0x0010){paneClose=true;return IntPtr.Zero;}
    return DefWindowProc(window,message,wParam,lParam);
  };
  static void Pump() { Message message;while(PeekMessage(out message,IntPtr.Zero,0,0,1)){TranslateMessage(ref message);DispatchMessage(ref message);} }
  static IntPtr CreatePane(IntPtr owner,IntPtr childDpi) {
    if(childDpi==IntPtr.Zero||SetThreadDpiAwarenessContext(childDpi)==IntPtr.Zero)throw new InvalidOperationException("dpi");
    var cls=new WindowClass();cls.procedure=paneProcedure;cls.instance=GetModuleHandle(null);cls.className="HelloDogGoogleVoicePane";
    if(RegisterClass(ref cls)==0)throw new InvalidOperationException("pane");
    // No native owner/parent relationship to Electron: browser modal dialogs
    // can walk that chain and disable every account in the HelloDog main window.
    // Position, foreground eligibility and visibility are controlled explicitly.
    var pane=CreateWindowEx(0x00000080U,cls.className,"HelloDog Google Voice",PopupStyle|0x06000000U,0,0,1,1,IntPtr.Zero,IntPtr.Zero,cls.instance,IntPtr.Zero);
    if(pane==IntPtr.Zero)throw new InvalidOperationException("pane");
    if((ReadStyle(pane,-16)&ChildStyle)!=0||GetAncestor(pane,2)!=pane||GetWindow(pane,4)!=IntPtr.Zero||!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(pane),childDpi)) {
      DestroyWindow(pane);throw new InvalidOperationException("dpi");
    }
    return pane;
  }
  static IntPtr EligibleForeground(IntPtr main,IntPtr pane,IntPtr child) {
    var foreground=GetAncestor(GetForegroundWindow(),2);
    if(foreground==main||foreground==pane)return foreground;
    uint childPid,foregroundPid;GetWindowThreadProcessId(child,out childPid);GetWindowThreadProcessId(foreground,out foregroundPid);
    if(childPid==0||foregroundPid!=childPid)return IntPtr.Zero;
    // Follow only the current foreground window's actual official owner chain,
    // never enumerate or hide windows from another browser/profile/process.
    var cursor=foreground;
    for(int depth=0;depth<32&&cursor!=IntPtr.Zero;depth++){cursor=GetWindow(cursor,4);if(cursor==child||cursor==pane)return foreground;}
    return IntPtr.Zero;
  }
  static void LayoutPane(IntPtr owner,IntPtr pane,IntPtr child,int x,int y,int width,int height,bool visible) {
    Rect client;if(!GetClientRect(owner,out client))throw new InvalidOperationException("layout");
    int w=Math.Min(width,Math.Max(0,client.right-x)),h=Math.Min(height,Math.Max(0,client.bottom-y));
    var foreground=EligibleForeground(owner,pane,child);
    if(!visible||w<1||h<1||!IsWindowVisible(owner)||IsIconic(owner)||!IsWindowEnabled(owner)||foreground==IntPtr.Zero){if(IsWindowVisible(pane))ShowWindow(pane,0);return;}
    var point=new Point();point.x=x;point.y=y;if(!ClientToScreen(owner,ref point))throw new InvalidOperationException("layout");
    // Never activate or become topmost. Raise over the main window only while
    // this workspace is foreground; stay behind an official owned modal popup.
    if(point.x!=paneX||point.y!=paneY||w!=paneWidth||h!=paneHeight){
      if(!SetWindowPos(pane,IntPtr.Zero,point.x,point.y,w,h,0x0214)||!SetWindowPos(child,IntPtr.Zero,0,0,w,h,0x0034))throw new InvalidOperationException("layout");
      paneX=point.x;paneY=point.y;paneWidth=w;paneHeight=h;
    }
    if((ReadStyle(child,-16)&0x10000000U)==0)ShowWindow(child,4);
    if(!IsWindowVisible(pane))ShowWindow(pane,4);
    var insertAfter=foreground==owner||foreground==pane?IntPtr.Zero:foreground;
    if(!SetWindowPos(pane,insertAfter,0,0,0,0,0x0013))throw new InvalidOperationException("layout");
    if((ReadStyle(pane,-20)&0x00000008U)!=0&&!SetWindowPos(pane,new IntPtr(-2),0,0,0,0,0x0013))throw new InvalidOperationException("layout");
  }

  const uint ChildStyle=0x40000000, PopupStyle=0x80000000, FrameStyle=0x00CF0000, AppWindowStyle=0x00040000;
  static uint ReadStyle(IntPtr window,int index) { return unchecked((uint)(IntPtr.Size==8?GetLong64(window,index).ToInt64():GetLong32(window,index))); }
  static void WriteStyle(IntPtr window,int index,uint style) {
    if(IntPtr.Size==8) SetLong64(window,index,new IntPtr(unchecked((long)(int)style)));
    else SetLong32(window,index,unchecked((int)style));
    if(ReadStyle(window,index)!=style) throw new InvalidOperationException("style");
  }
  static string CanonicalPath(string value) {
    if(String.IsNullOrWhiteSpace(value)||value.Length>1024||value.Length<3||!Char.IsLetter(value[0])||value[1]!=':'||(value[2]!='\\'&&value[2]!='/')||value.IndexOfAny(new char[]{'\0','\r','\n','"'})>=0) throw new ArgumentException("path");
    return Path.GetFullPath(value).TrimEnd('\\');
  }
  static bool SamePath(string first,string second) { try { return String.Equals(CanonicalPath(first),CanonicalPath(second),StringComparison.OrdinalIgnoreCase); } catch { return false; } }
  static string BrowserPath(string value) {
    var path=CanonicalPath(value); var name=Path.GetFileName(path);
    if(!String.Equals(name,"chrome.exe",StringComparison.OrdinalIgnoreCase)&&!String.Equals(name,"msedge.exe",StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("browser");
    return path;
  }
  static bool MatchingCommand(string command,string executable,string profile) {
    if(String.IsNullOrEmpty(command)) return false;
    int count; var arguments=CommandLineToArgvW(command,out count);
    if(arguments==IntPtr.Zero) return false;
    try {
      int profiles=0,apps=0; bool valid=true;
      for(int index=0;index<count;index++) {
        string value=Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments,index*IntPtr.Size));
        if(index==0) { if(!SamePath(value,executable)) valid=false; continue; }
        if(value.StartsWith("--type=",StringComparison.Ordinal)||value=="--type"||value.StartsWith("--remote-debugging",StringComparison.Ordinal)||value=="--no-sandbox"||value=="--disable-web-security") valid=false;
        if(value.StartsWith("--user-data-dir=",StringComparison.Ordinal)) {profiles++;if(!SamePath(value.Substring(16),profile))valid=false;}
        if(value.StartsWith("--app=",StringComparison.Ordinal)) {apps++;if(value!="--app=https://voice.google.com/")valid=false;}
      }
      return valid&&profiles==1&&apps==1;
    } finally { LocalFree(arguments); }
  }
  static string QuoteWql(string value) { return value.Replace("\\","\\\\").Replace("'","\\'"); }
  static long ProcessStamp(uint pid) { using(var process=Process.GetProcessById(checked((int)pid))) { return process.StartTime.ToUniversalTime().Ticks; } }
  static bool VerifyProcess(uint pid,long stamp,string executable,string profile) {
    try {
      if(ProcessStamp(pid)!=stamp)return false;
      using(var search=new ManagementObjectSearcher("SELECT ExecutablePath, CommandLine FROM Win32_Process WHERE ProcessId="+pid))
      using(var rows=search.Get()) foreach(ManagementObject row in rows) using(row) {
        return SamePath(Convert.ToString(row["ExecutablePath"]),executable)&&MatchingCommand(Convert.ToString(row["CommandLine"]),executable,profile);
      }
    } catch { }
    return false;
  }
  static bool Owned(IntPtr window,uint expected,long stamp) {
    try { uint actual; return IsWindow(window)&&GetWindowThreadProcessId(window,out actual)!=0&&actual==expected&&ProcessStamp(expected)==stamp; } catch { return false; }
  }
  static bool BrowserWindow(IntPtr window,uint pid,long stamp) {
    if(!Owned(window,pid,stamp)||!IsWindowVisible(window)||GetParent(window)!=IntPtr.Zero||GetWindow(window,4)!=IntPtr.Zero||(ReadStyle(window,-16)&ChildStyle)!=0)return false;
    var name=new StringBuilder(128);GetClassName(window,name,name.Capacity);return name.ToString()=="Chrome_WidgetWin_1";
  }
  static void Output(string value) { try { Console.WriteLine(value); Console.Out.Flush(); } catch { } }
  static int Discover(string executable,string profile) {
    var windows=new List<string>();var seen=new HashSet<long>();
    // WMI only returns the requested executable. Windows are enumerated only
    // after its exact dedicated profile and fixed app URL have been verified.
    using(var search=new ManagementObjectSearcher("SELECT ProcessId, ExecutablePath, CommandLine FROM Win32_Process WHERE ExecutablePath='"+QuoteWql(executable)+"'"))
    using(var rows=search.Get()) foreach(ManagementObject row in rows) using(row) {
      if(!SamePath(Convert.ToString(row["ExecutablePath"]),executable)||!MatchingCommand(Convert.ToString(row["CommandLine"]),executable,profile))continue;
      var pid=Convert.ToUInt32(row["ProcessId"]);
      try {
        var stamp=ProcessStamp(pid);
        using(var process=Process.GetProcessById(checked((int)pid))) foreach(ProcessThread thread in process.Threads) using(thread) {
          EnumThreadWindows((uint)thread.Id,delegate(IntPtr window,IntPtr ignored){
            if(BrowserWindow(window,pid,stamp)&&seen.Add(window.ToInt64()))windows.Add("{\"hwnd\":\""+window.ToInt64()+"\",\"pid\":"+pid+",\"startTicks\":\""+stamp+"\"}");
            return true;
          },IntPtr.Zero);
        }
      } catch { /* A process can exit while discovery is in progress. */ }
    }
    Output("{\"windows\":["+String.Join(",",windows.ToArray())+"]}");return 0;
  }

  static int Attach(IntPtr parent,uint parentPid,IntPtr child,uint childPid,long childStamp,string executable,string profile) {
    if(!VerifyProcess(childPid,childStamp,executable,profile)||!BrowserWindow(child,childPid,childStamp))throw new InvalidOperationException("identity");
    long parentStamp=ProcessStamp(parentPid);
    if(parentPid==childPid||!Owned(parent,parentPid,parentStamp)||GetAncestor(parent,2)!=parent)throw new InvalidOperationException("parent");
    var childDpi=GetWindowDpiAwarenessContext(child);
    var originalParent=GetParent(child);var originalStyle=ReadStyle(child,-16);var originalExStyle=ReadStyle(child,-20);
    var placement=new Placement();placement.length=Marshal.SizeOf(typeof(Placement));
    if(!GetWindowPlacement(child,ref placement))throw new InvalidOperationException("placement");
    var pane=CreatePane(parent,childDpi);
    bool changed=false,restored=false;int result=0;
    try {
      changed=true;ShowWindow(child,0);
      WriteStyle(child,-16,(originalStyle&~PopupStyle&~FrameStyle&~0x10000000U)|ChildStyle);
      // Top-level window/client edges are invalid for the frameless child and
      // Chromium clears them itself. Restore them only when detached again.
      WriteStyle(child,-20,originalExStyle&~AppWindowStyle&~0x00000300U);
      // Re-check immediately before the only cross-process SetParent mutation.
      if(!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(pane),GetWindowDpiAwarenessContext(child)))throw new InvalidOperationException("dpi");
      SetParent(child,pane);
      if(GetParent(child)!=pane)throw new InvalidOperationException("attach");
      if(!SetWindowPos(child,IntPtr.Zero,0,0,1,1,0x0034))throw new InvalidOperationException("layout");
      Output("{\"event\":\"attached\",\"paneHwnd\":\""+pane.ToInt64()+"\"}");
      // A resize burst needs only its final layout, not a queue of hundreds of
      // obsolete HWND mutations. Visibility/focus preserve input ordering;
      // hide clears pending focus, and detach/EOF always wins permanently.
      var controls=new ControlState();
      var reader=new Thread(delegate(){ReadControls(controls);});
      reader.IsBackground=true;reader.Start();
      long lastRevision=-1;
      var ownershipCheck=Stopwatch.StartNew();
      while(true) {
        Pump();if(paneClose)break;
        int x,y,width,height,focus;bool visible,stop,invalid;long revision;
        lock(controls){x=controls.x;y=controls.y;width=controls.width;height=controls.height;visible=controls.visible;focus=controls.focus;controls.focus=0;stop=controls.stop;invalid=controls.invalid;revision=controls.revision;}
        if(invalid)throw new InvalidOperationException("command");
        if(stop)break;
        // Do not query process timestamps on every animation/layout iteration.
        // HWND/PID reuse is checked periodically and before processing commands.
        if(ownershipCheck.ElapsedMilliseconds>=200||revision!=lastRevision) {
        if(!Owned(child,childPid,childStamp)){Output("{\"event\":\"detached\",\"verified\":true,\"closed\":true}");changed=false;return 0;}
        if(!Owned(parent,parentPid,parentStamp))break;
        ownershipCheck.Restart();
        lastRevision=revision;
        }
        LayoutPane(parent,pane,child,x,y,width,height,visible);
        if(focus!=0) {
          var foreground=GetAncestor(GetForegroundWindow(),2);
          if(IsWindowVisible(child)&&(foreground==parent||foreground==pane)) {
            var target=focus==2?parent:child;uint ignored;var thread=GetWindowThreadProcessId(target,out ignored);var current=GetCurrentThreadId();
            if(AttachThreadInput(current,thread,true)){try{SetFocus(target);}finally{AttachThreadInput(current,thread,false);}}
          }
        }
        Thread.Sleep(16);
      }
    } catch(InvalidOperationException error) { Output("{\"event\":\"error\",\"reason\":\""+SafeReason(error.Message)+"\"}");result=4; }
    catch {Output("{\"event\":\"error\",\"reason\":\"host\"}");result=4;}
    finally {
      if(changed) {
        bool failedReported=false;
        // Destroying this process's pane while it still parents the official
        // browser can destroy that window. Keep the helper alive and retry if
        // recovery is unconfirmed; only a verified detach permits pane cleanup.
        do {
        try {
          if(Owned(child,childPid,childStamp)) {
            // Official modal dialogs can change WS_DISABLED while embedded. The
            // host does not own that state and must not dismiss their modality.
            var restoredStyle=(originalStyle&~0x08000000U)|(ReadStyle(child,-16)&0x08000000U);
            SetParent(child,originalParent);
            WriteStyle(child,-16,restoredStyle);WriteStyle(child,-20,originalExStyle);
            if(!SetWindowPlacement(child,ref placement))throw new InvalidOperationException("restore");
            SetWindowPos(child,IntPtr.Zero,0,0,0,0,0x0037);ShowWindow(child,4);
            restored=GetParent(child)==originalParent&&ReadStyle(child,-16)==restoredStyle&&ReadStyle(child,-20)==originalExStyle&&IsWindowVisible(child);
          } else restored=true;
        } catch { restored=false; }
        if(restored)Output("{\"event\":\"detached\",\"verified\":true}");
        else {if(!failedReported){Output("{\"event\":\"detached\",\"verified\":false}");failedReported=true;result=5;}Pump();Thread.Sleep(200);}
        } while(!restored);
      }
      DestroyWindow(pane);
    }
    return result;
  }
  static string SafeReason(string value) {
    foreach(var allowed in new string[]{"identity","parent","dpi","pane","placement","style","attach","layout","bounds","command"})if(value==allowed)return value;
    return "host";
  }
  public static int Main(string[] args) {
    try {
      if(args.Length==3&&args[0]=="discover")return Discover(BrowserPath(args[1]),CanonicalPath(args[2]));
      if(args.Length==8&&args[0]=="attach")return Attach(new IntPtr(Int64.Parse(args[1])),UInt32.Parse(args[2]),new IntPtr(Int64.Parse(args[3])),UInt32.Parse(args[4]),Int64.Parse(args[5]),BrowserPath(args[6]),CanonicalPath(args[7]));
      Output("{\"event\":\"error\",\"reason\":\"arguments\"}");return 2;
    } catch(InvalidOperationException error){Output("{\"event\":\"error\",\"reason\":\""+SafeReason(error.Message)+"\"}");if(args.Length>0&&args[0]=="attach")Output("{\"event\":\"detached\",\"verified\":true,\"untouched\":true}");return 3;}
    catch {Output("{\"event\":\"error\",\"reason\":\"validation\"}");if(args.Length>0&&args[0]=="attach")Output("{\"event\":\"detached\",\"verified\":true,\"untouched\":true}");return 3;}
  }
}

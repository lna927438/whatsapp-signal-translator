using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using Microsoft.Win32;

// Chrome/Edge native messaging transport. It cannot read cookies, automate the
// browser, or access cloud credentials. Pairing is validated by HelloDog.
internal static class GoogleVoiceMessagingHost {
  const int Limit = 262144;
  static byte[] ReadExact(Stream stream, int length) {
    byte[] bytes = new byte[length]; int offset = 0;
    while (offset < length) { int read = stream.Read(bytes, offset, length-offset); if (read == 0) throw new EndOfStreamException(); offset += read; }
    return bytes;
  }
  static byte[] ReadFrame(Stream stream) {
    byte[] header = ReadExact(stream,4); int length = BitConverter.ToInt32(header,0);
    if(length < 1 || length > Limit) throw new InvalidDataException();
    return ReadExact(stream,length);
  }
  static void WriteFrame(Stream stream, byte[] value) {
    stream.Write(BitConverter.GetBytes(value.Length),0,4); stream.Write(value,0,value.Length); stream.Flush();
  }
  static int Main(string[] args) {
    if(args.Length < 1 || args[0] != "chrome-extension://kigfaejcipjibnmnpinplphfldjahknn/") return 2;
    try {
      Stream input=Console.OpenStandardInput(),output=Console.OpenStandardOutput();
      while(true) {
        byte[] request=ReadFrame(input);
        // Open a fresh connection per operation, including after HelloDog has
        // restarted. Idle browser extension ports never hold a stale pipe.
        string pipe;
        using(var key=Registry.CurrentUser.OpenSubKey(@"Software\HelloDog\GoogleVoice")) pipe=key == null ? null : key.GetValue("PipeName") as string;
        if(pipe == null || !System.Text.RegularExpressions.Regex.IsMatch(pipe,@"^hellodog-google-voice-[a-f0-9]{48}$")) return 3;
        using(var client=new NamedPipeClientStream(".",pipe,PipeDirection.InOut,PipeOptions.None)) {
          client.Connect(5000); WriteFrame(client,request); WriteFrame(output,ReadFrame(client));
        }
      }
    } catch(EndOfStreamException) { return 0; } catch { return 1; }
  }
}

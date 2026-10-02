using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace SecondScreen;

/// <summary>
/// The named pipe between the CLI and the tray app. <see cref="PipeOptions.CurrentUserOnly"/>
/// on both ends keeps other users' processes out.
/// </summary>
public static class ControlPipe
{
    public static string Name => $"2ndscreen-control-{Environment.UserName}";

    public sealed class NotRunningException : Exception
    {
        public NotRunningException() : base("2ndscreen is not running; start SecondScreen.exe first") { }
    }

    /// <summary>Send one request to the running app and wait for its response.</summary>
    public static ControlResponse Send(ControlRequest request, int connectTimeoutMs = 3000)
    {
        using var pipe = new NamedPipeClientStream(".", Name, PipeDirection.InOut, PipeOptions.CurrentUserOnly);
        try
        {
            pipe.Connect(connectTimeoutMs);
        }
        catch (TimeoutException)
        {
            throw new NotRunningException();
        }
        WriteLine(pipe, JsonSerializer.Serialize(request, ProtocolJson.Wire));
        var line = ReadLine(pipe) ?? throw new IOException("the app closed the connection without a response");
        return JsonSerializer.Deserialize<ControlResponse>(line) ?? ControlResponse.Failure("empty response");
    }

    public static void WriteLine(Stream stream, string line)
    {
        var bytes = Encoding.UTF8.GetBytes(line + "\n");
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    /// <summary>Read up to the first newline. Requests and responses are single lines.</summary>
    public static string? ReadLine(Stream stream, int limit = 1 << 20)
    {
        var buffer = new MemoryStream();
        var one = new byte[1];
        while (buffer.Length < limit)
        {
            int read = stream.Read(one, 0, 1);
            if (read == 0) break;
            if (one[0] == (byte)'\n') return Encoding.UTF8.GetString(buffer.ToArray());
            buffer.WriteByte(one[0]);
        }
        return buffer.Length > 0 ? Encoding.UTF8.GetString(buffer.ToArray()) : null;
    }
}

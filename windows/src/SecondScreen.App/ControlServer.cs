using System.IO.Pipes;
using System.Text.Json;

namespace SecondScreen.App;

/// <summary>
/// Serves <see cref="ControlRequest"/>s on the control pipe. Connections are read on
/// background threads; the handler runs on the UI thread, where screen state lives.
/// </summary>
internal sealed class ControlServer
{
    private readonly Func<ControlRequest, Task<ControlResponse>> handler;
    private readonly SynchronizationContext ui;
    private readonly CancellationTokenSource stopping = new();

    public ControlServer(Func<ControlRequest, Task<ControlResponse>> handler, SynchronizationContext ui)
    {
        this.handler = handler;
        this.ui = ui;
    }

    public void Start() => _ = Task.Run(AcceptLoop);

    public void Stop() => stopping.Cancel();

    private async Task AcceptLoop()
    {
        while (!stopping.IsCancellationRequested)
        {
            var pipe = new NamedPipeServerStream(ControlPipe.Name, PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await pipe.WaitForConnectionAsync(stopping.Token);
            }
            catch (OperationCanceledException)
            {
                pipe.Dispose();
                return;
            }
            _ = Task.Run(() => Serve(pipe));
        }
    }

    private async Task Serve(NamedPipeServerStream pipe)
    {
        await using var _ = pipe;
        ControlResponse response;
        try
        {
            var line = ControlPipe.ReadLine(pipe) ?? throw new IOException("empty request");
            var request = JsonSerializer.Deserialize<ControlRequest>(line) ?? throw new IOException("empty request");
            response = await OnUiThread(request);
        }
        catch (Exception error)
        {
            response = ControlResponse.Failure($"bad request: {error.Message}");
        }
        try
        {
            ControlPipe.WriteLine(pipe, JsonSerializer.Serialize(response, ProtocolJson.Wire));
        }
        catch (IOException)
        {
            // The client went away.
        }
    }

    private Task<ControlResponse> OnUiThread(ControlRequest request)
    {
        var done = new TaskCompletionSource<ControlResponse>();
        ui.Post(async _ =>
        {
            try
            {
                done.SetResult(await handler(request));
            }
            catch (Exception error)
            {
                done.SetResult(ControlResponse.Failure(error.Message));
            }
        }, null);
        return done.Task;
    }
}

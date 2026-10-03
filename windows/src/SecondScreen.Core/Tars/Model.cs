using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SecondScreen.Tars;

/// <summary>A chat message: text, or one PNG screenshot from the user.</summary>
public abstract record Message
{
    public sealed record User(string Text) : Message;
    public sealed record Assistant(string Text) : Message;
    public sealed record Screenshot(byte[] Png) : Message;

    public JsonObject ToJson() => this switch
    {
        User u => new JsonObject { ["role"] = "user", ["content"] = u.Text },
        Assistant a => new JsonObject { ["role"] = "assistant", ["content"] = a.Text },
        Screenshot s => new JsonObject
        {
            ["role"] = "user",
            ["content"] = new JsonArray(new JsonObject
            {
                ["type"] = "image_url",
                ["image_url"] = new JsonObject { ["url"] = "data:image/png;base64," + Convert.ToBase64String(s.Png) },
            }),
        },
        _ => throw new InvalidOperationException(),
    };
}

public interface IVisionModel
{
    string Complete(IReadOnlyList<Message> messages);
}

/// <summary>
/// A vision model behind an OpenAI-compatible chat completions API, such as Doubao on
/// Volcengine Ark or UI-TARS-1.5 under vLLM.
/// </summary>
public sealed class ChatCompletionsModel : IVisionModel
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(120) };
    public Uri BaseUrl { get; }
    public string ApiKey { get; }
    public string Name { get; }

    public ChatCompletionsModel(Uri baseUrl, string apiKey, string name)
    {
        BaseUrl = baseUrl;
        ApiKey = apiKey;
        Name = name;
    }

    /// <summary>
    /// From the environment, falling back to <c>%USERPROFILE%\.config\2ndscreen\model.env</c>,
    /// then the older ark.env, for any value unset. AGENT_MODEL_BASE_URL, AGENT_MODEL_API_KEY
    /// and AGENT_MODEL name any OpenAI-compatible server, such as Nebula's GUI agent endpoint;
    /// the ARK_ names are read too, for Volcengine Ark.
    /// </summary>
    public static ChatCompletionsModel FromEnvironment()
    {
        var names = new[] { "AGENT_MODEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENT_MODEL", "ARK_API_KEY", "ARK_MODEL", "ARK_BASE_URL" };
        var values = new Dictionary<string, string>();
        foreach (var name in names)
        {
            if (Environment.GetEnvironmentVariable(name) is { Length: > 0 } value) values[name] = value;
        }
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "2ndscreen");
        foreach (var file in new[] { "model.env", "ark.env" }.Select(f => Path.Combine(directory, f)).Where(File.Exists))
        {
            foreach (var line in File.ReadAllLines(file))
            {
                if (line.TrimStart().StartsWith('#')) continue;
                int equals = line.IndexOf('=');
                if (equals <= 0) continue;
                var key = line[..equals].Trim();
                var value = line[(equals + 1)..].Trim().Trim('"', '\'');
                if (value.Length > 0) values.TryAdd(key, value);
            }
        }
        string? Value(params string[] keys) => keys.Select(values.GetValueOrDefault).FirstOrDefault(v => !string.IsNullOrEmpty(v));
        var apiKey = Value("AGENT_MODEL_API_KEY", "ARK_API_KEY")
            ?? throw new InvalidOperationException($"set AGENT_MODEL_API_KEY (or ARK_API_KEY), or put it in {Path.Combine(directory, "model.env")}");
        var baseUrl = Value("AGENT_MODEL_BASE_URL", "ARK_BASE_URL") ?? "https://ark.cn-beijing.volces.com/api/v3";
        return new ChatCompletionsModel(new Uri(baseUrl.TrimEnd('/') + "/"), apiKey, Value("AGENT_MODEL", "ARK_MODEL") ?? "doubao-seed-2-1-lite-260915");
    }

    /// <summary>
    /// Ask once more after a timeout or a server error: a far-away endpoint now and then
    /// takes longer than the timeout, and a retry usually answers.
    /// </summary>
    public string Complete(IReadOnlyList<Message> messages)
    {
        try
        {
            return CompleteOnce(messages);
        }
        catch (Exception error) when (error is TaskCanceledException or HttpRequestException or ServerError)
        {
            return CompleteOnce(messages);
        }
    }

    private sealed class ServerError : Exception
    {
        public ServerError(string message) : base(message) { }
    }

    private string CompleteOnce(IReadOnlyList<Message> messages)
    {
        // The settings UI-TARS's SDK uses; Doubao's thinking would only add delay.
        var body = new JsonObject
        {
            ["model"] = Name,
            ["messages"] = new JsonArray(messages.Select(m => (JsonNode)m.ToJson()).ToArray()),
            ["max_tokens"] = 1000, ["temperature"] = 0, ["top_p"] = 0.7, ["stream"] = false,
            ["thinking"] = new JsonObject { ["type"] = "disabled" },
        };
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(BaseUrl, "chat/completions"))
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", ApiKey);
        using var response = Http.Send(request);
        var text = new StreamReader(response.Content.ReadAsStream()).ReadToEnd();
        JsonNode? json = null;
        try { json = JsonNode.Parse(text); } catch (JsonException) { }
        if (!response.IsSuccessStatusCode)
        {
            var message = $"model request failed ({(int)response.StatusCode}): {json?["error"]?["message"]?.ToString() ?? text}";
            throw (int)response.StatusCode >= 500 ? new ServerError(message) : new InvalidOperationException(message);
        }
        var content = json?["choices"]?[0]?["message"]?["content"]?.ToString();
        return string.IsNullOrEmpty(content) ? throw new InvalidOperationException("the model returned no text") : content;
    }
}

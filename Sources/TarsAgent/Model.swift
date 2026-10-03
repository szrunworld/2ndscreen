import Foundation

/// A vision model behind an OpenAI-compatible chat completions API, such as
/// Doubao on Volcengine Ark or UI-TARS-1.5 under vLLM.
public struct ModelConfig {
    public var baseURL: URL
    public var apiKey: String
    public var model: String
    public var maxTokens = 1000
    public var timeout: TimeInterval = 60

    public init(baseURL: URL, apiKey: String, model: String) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.model = model
    }

    /// From the environment, falling back to ~/.config/2ndscreen/model.env, then the
    /// older ark.env, for any value unset. `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_API_KEY`
    /// and `AGENT_MODEL` name any OpenAI-compatible server, such as Nebula's GUI agent
    /// endpoint; the `ARK_` names are read too, for Volcengine Ark.
    public static func fromEnvironment() throws -> ModelConfig {
        var values = ProcessInfo.processInfo.environment
        let directory = NSHomeDirectory() + "/.config/2ndscreen/"
        for name in ["model.env", "ark.env"] {
            guard let text = try? String(contentsOfFile: directory + name, encoding: .utf8) else { continue }
            for line in text.split(separator: "\n") where !line.hasPrefix("#") {
                let parts = line.split(separator: "=", maxSplits: 1).map {
                    $0.trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: "\"'")))
                }
                if parts.count == 2, !parts[1].isEmpty, (values[parts[0]] ?? "").isEmpty {
                    values[parts[0]] = parts[1]
                }
            }
        }
        func value(_ names: String...) -> String? {
            names.lazy.compactMap { values[$0] }.first { !$0.isEmpty }
        }
        guard let key = value("AGENT_MODEL_API_KEY", "ARK_API_KEY") else {
            throw AgentError("set AGENT_MODEL_API_KEY (or ARK_API_KEY), or put it in \(directory)model.env")
        }
        let base = value("AGENT_MODEL_BASE_URL", "ARK_BASE_URL") ?? "https://ark.cn-beijing.volces.com/api/v3"
        guard let url = URL(string: base) else { throw AgentError("the model's base URL is not a URL: \(base)") }
        let model = value("AGENT_MODEL", "ARK_MODEL") ?? "doubao-seed-2-1-lite-260915"
        return ModelConfig(baseURL: url, apiKey: key, model: model)
    }
}

/// A chat message: text, or one PNG screenshot from the user.
public enum Message {
    case user(String)
    case assistant(String)
    case screenshot(Data)

    var json: [String: Any] {
        switch self {
        case .user(let text): return ["role": "user", "content": text]
        case .assistant(let text): return ["role": "assistant", "content": text]
        case .screenshot(let png):
            let url = "data:image/png;base64," + png.base64EncodedString()
            return ["role": "user", "content": [["type": "image_url", "image_url": ["url": url]]]]
        }
    }
}

public protocol VisionModel {
    func complete(_ messages: [Message]) throws -> String
}

public struct ChatCompletionsModel: VisionModel {
    public let config: ModelConfig

    public init(_ config: ModelConfig) {
        self.config = config
    }

    public func complete(_ messages: [Message]) throws -> String {
        var request = URLRequest(url: config.baseURL.appendingPathComponent("chat/completions"))
        request.httpMethod = "POST"
        request.timeoutInterval = config.timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(config.apiKey)", forHTTPHeaderField: "Authorization")
        // The settings UI-TARS's SDK uses; Doubao's thinking would only add delay.
        let body: [String: Any] = [
            "model": config.model,
            "messages": messages.map(\.json),
            "max_tokens": config.maxTokens,
            "temperature": 0,
            "top_p": 0.7,
            "stream": false,
            "thinking": ["type": "disabled"],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try Self.send(request)
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let status = (response as? HTTPURLResponse)?.statusCode, status == 200 else {
            let error = (object?["error"] as? [String: Any])?["message"] as? String
                ?? String(data: data, encoding: .utf8) ?? "no body"
            throw AgentError("model request failed (\((response as? HTTPURLResponse)?.statusCode ?? 0)): \(error)")
        }
        guard let choices = object?["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any],
              let content = message["content"] as? String, !content.isEmpty
        else { throw AgentError("the model returned no text") }
        return content
    }

    /// URLSession, waited for synchronously: the agent runs one step at a time.
    private static func send(_ request: URLRequest) throws -> (Data, URLResponse) {
        let done = DispatchSemaphore(value: 0)
        var result: Result<(Data, URLResponse), Error> = .failure(AgentError("no response"))
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let data, let response {
                result = .success((data, response))
            } else {
                result = .failure(error ?? AgentError("no response"))
            }
            done.signal()
        }.resume()
        done.wait()
        return try result.get()
    }
}

public struct AgentError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

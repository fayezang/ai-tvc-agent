import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall
} from "@mariozechner/pi-ai";

interface OrzChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null | Array<{ type?: string; text?: string }>;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
  message?: string;
}

const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
});

const textFromParts = (message: Extract<Message, { role: "user" | "toolResult" }>): string => {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
};

const toOpenAiMessages = (context: Context): Array<Record<string, unknown>> => {
  const messages: Array<Record<string, unknown>> = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: textFromParts(message) });
      continue;
    }
    if (message.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.toolName,
        content: textFromParts(message)
      });
      continue;
    }
    const content = message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");
    const toolCalls = message.content
      .filter((part): part is ToolCall => part.type === "toolCall")
      .map((part) => ({
        id: part.id,
        type: "function",
        function: { name: part.name, arguments: JSON.stringify(part.arguments) }
      }));
    messages.push({
      role: "assistant",
      content: content || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    });
  }
  return messages;
};

const responseText = (
  content: string | null | Array<{ type?: string; text?: string }> | undefined
): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
};

const errorDetail = (raw: string, parsed: OrzChatResponse | null): string =>
  parsed?.error?.message ?? parsed?.message ?? (raw.trim().slice(0, 320) || "ORZ 文本请求失败");

export const streamOrzRest = (
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions = {}
) => {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now()
  };

  void (async () => {
    try {
      if (!options.apiKey) throw new Error("缺少 ORZ API Key");
      const payload = {
        model: model.id,
        messages: toOpenAiMessages(context),
        stream: false,
        max_tokens: Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens),
        ...(context.tools && context.tools.length > 0
          ? {
              tools: context.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters
                }
              }))
            }
          : {})
      };
      const customizedPayload = (await options.onPayload?.(payload, model)) ?? payload;
      const response = await fetch(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          ...model.headers,
          ...options.headers
        },
        body: JSON.stringify(customizedPayload),
        ...(options.signal ? { signal: options.signal } : {})
      });
      await options.onResponse?.(
        { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
        model
      );
      const raw = await response.text();
      let parsed: OrzChatResponse | null = null;
      try {
        parsed = JSON.parse(raw) as OrzChatResponse;
      } catch {
        parsed = null;
      }
      if (!response.ok) throw new Error(`ORZ HTTP ${response.status}：${errorDetail(raw, parsed)}`);
      if (!parsed) throw new Error("ORZ 返回了无法解析的文本响应");

      const choice = parsed.choices?.[0];
      const content = responseText(choice?.message?.content);
      const reasoning = choice?.message?.reasoning_content?.trim() ?? "";
      const toolCalls = choice?.message?.tool_calls ?? [];
      if (parsed.id) output.responseId = parsed.id;
      if (parsed.model && parsed.model !== model.id) output.responseModel = parsed.model;
      output.usage = {
        input: Math.max(0, (parsed.usage?.prompt_tokens ?? 0) - (parsed.usage?.prompt_tokens_details?.cached_tokens ?? 0)),
        output: parsed.usage?.completion_tokens ?? 0,
        cacheRead: parsed.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWrite: 0,
        totalTokens: parsed.usage?.total_tokens ?? 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      };

      stream.push({ type: "start", partial: output });
      if (reasoning) {
        const block: ThinkingContent = { type: "thinking", thinking: reasoning };
        output.content.push(block);
        const index = output.content.length - 1;
        stream.push({ type: "thinking_start", contentIndex: index, partial: output });
        stream.push({ type: "thinking_delta", contentIndex: index, delta: reasoning, partial: output });
        stream.push({ type: "thinking_end", contentIndex: index, content: reasoning, partial: output });
      }
      if (content) {
        const block: TextContent = { type: "text", text: content };
        output.content.push(block);
        const index = output.content.length - 1;
        stream.push({ type: "text_start", contentIndex: index, partial: output });
        stream.push({ type: "text_delta", contentIndex: index, delta: content, partial: output });
        stream.push({ type: "text_end", contentIndex: index, content, partial: output });
      }
      for (const [index, call] of toolCalls.entries()) {
        const rawArguments = call.function?.arguments ?? "{}";
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(rawArguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        const block: ToolCall = {
          type: "toolCall",
          id: call.id || `orz_tool_${Date.now()}_${index}`,
          name: call.function?.name ?? "",
          arguments: args
        };
        output.content.push(block);
        const contentIndex = output.content.length - 1;
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex, delta: rawArguments, partial: output });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
      }

      output.stopReason = toolCalls.length > 0 ? "toolUse" : choice?.finish_reason === "length" ? "length" : "stop";
      if (output.content.length === 0) throw new Error("ORZ 文本模型返回了空内容");
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : "ORZ 文本请求失败";
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

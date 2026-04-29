import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentTimingRecorder,
  AgentTimingMetadata,
} from "./timing-spans.js";

export interface AnthropicStreamResult {
  message: Anthropic.Message;
  streamedText: string;
}

interface TextStreamingMessage {
  on(event: "text", listener: (delta: string) => void): TextStreamingMessage;
  finalMessage(): Promise<unknown>;
}

export async function createStreamingAnthropicMessage({
  anthropic,
  params,
  recorder,
  model,
  loopIndex,
  promptCaching,
  onText,
}: {
  anthropic: Anthropic;
  params: Anthropic.MessageStreamParams;
  recorder: AgentTimingRecorder;
  model: string;
  loopIndex: number;
  promptCaching: boolean;
  onText: (delta: string) => void;
}): Promise<AnthropicStreamResult> {
  const firstTokenSpan = recorder.start("llm_first_token", {
    model_used: model,
    loop_index: loopIndex,
    provider: "anthropic",
    prompt_caching: promptCaching,
    streaming: true,
  });
  const totalSpan = recorder.start("llm_total", {
    model_used: model,
    loop_index: loopIndex,
    provider: "anthropic",
    prompt_caching: promptCaching,
    streaming: true,
  });

  let firstTokenRecorded = false;
  let streamedText = "";

  const stream: TextStreamingMessage = promptCaching
    ? (anthropic.beta.promptCaching.messages.stream(params as never) as TextStreamingMessage)
    : (anthropic.messages.stream(params) as TextStreamingMessage);

  stream.on("text", (delta) => {
    if (!firstTokenRecorded) {
      firstTokenRecorded = true;
      void firstTokenSpan.end({ status: "ok" });
    }
    streamedText += delta;
    onText(delta);
  });

  try {
    const message = (await stream.finalMessage()) as Anthropic.Message;
    if (!firstTokenRecorded) {
      await firstTokenSpan.end({ status: "ok", no_text_delta: true });
    }
    await totalSpan.end({
      status: "ok",
      ...usageMetadata(message.usage),
    });
    return { message, streamedText };
  } catch (error) {
    if (!firstTokenRecorded) {
      await firstTokenSpan.end({
        status: "error",
        error_code: error instanceof Error ? error.name : "unknown_error",
      });
    }
    await totalSpan.end({
      status: "error",
      error_code: error instanceof Error ? error.name : "unknown_error",
    });
    throw error;
  }
}

function usageMetadata(usage: Anthropic.Usage | undefined): AgentTimingMetadata {
  if (!usage) return {};
  const extended = usage as Anthropic.Usage & {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: extended.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: extended.cache_read_input_tokens ?? 0,
  };
}

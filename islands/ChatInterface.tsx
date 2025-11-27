import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  images?: Array<{ id: string; filename: string; mime_type: string }>;
}

const messages = signal<Message[]>([]);
const input = signal("");
const loading = signal(false);
const streamMode = signal(true);

export default function ChatInterface() {
  useEffect(() => {
    // 加载历史消息
    const saved = localStorage.getItem("chat_history");
    if (saved) {
      try {
        messages.value = JSON.parse(saved);
      } catch (e) {
        console.error("Failed to load history:", e);
      }
    }

    // 如果没有消息，添加欢迎消息
    if (messages.value.length === 0) {
      messages.value = [
        {
          role: "assistant",
          content: "你好！有什么我可以帮你的吗？",
          timestamp: new Date().toISOString(),
        },
      ];
    }
  }, []);

  async function sendMessage() {
    if (!input.value.trim() || loading.value) return;

    const userMessage: Message = {
      role: "user",
      content: input.value.trim(),
      timestamp: new Date().toISOString(),
    };

    messages.value = [...messages.value, userMessage];
    input.value = "";
    loading.value = true;

    try {
      const requestMessages = messages.value.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      if (streamMode.value) {
        await handleStreamResponse(requestMessages);
      } else {
        await handleNonStreamResponse(requestMessages);
      }

      // 保存历史
      localStorage.setItem("chat_history", JSON.stringify(messages.value));
    } catch (error) {
      console.error("Send message failed:", error);
      const errorMessage: Message = {
        role: "assistant",
        content: `错误: ${error instanceof Error ? error.message : "未知错误"}`,
        timestamp: new Date().toISOString(),
      };
      messages.value = [...messages.value, errorMessage];
    } finally {
      loading.value = false;
    }
  }

  async function handleStreamResponse(requestMessages: any[]) {
    const res = await fetch("/v1/chat/completions", {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-enterprise",
        messages: requestMessages,
        stream: true,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let aiContent = "";

    // 添加空的 AI 消息
    const aiMessage: Message = {
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
    };
    messages.value = [...messages.value, aiMessage];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));

      for (const line of lines) {
        const data = line.slice(6);
        if (data === "[DONE]") break;

        try {
          const json = JSON.parse(data);
          const content = json.choices[0]?.delta?.content;
          if (content) {
            aiContent += content;
            // 更新最后一条消息
            messages.value = [
              ...messages.value.slice(0, -1),
              { ...aiMessage, content: aiContent },
            ];
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }
  }

  async function handleNonStreamResponse(requestMessages: any[]) {
    const res = await fetch("/v1/chat/completions", {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-enterprise",
        messages: requestMessages,
        stream: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const aiMessage: Message = {
      role: "assistant",
      content: data.choices[0]?.message?.content || "无响应",
      timestamp: new Date().toISOString(),
      images: data.images, // 提取图片
    };

    messages.value = [...messages.value, aiMessage];
  }

  function clearChat() {
    if (confirm("确定要清空所有对话记录吗？")) {
      messages.value = [
        {
          role: "assistant",
          content: "对话已清空。有什么我可以帮你的吗？",
          timestamp: new Date().toISOString(),
        },
      ];
      localStorage.removeItem("chat_history");
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div class="flex flex-col h-full bg-white">
      {/* 工具栏 */}
      <div class="border-b border-gray-200 px-4 py-2 flex items-center justify-between">
        <div class="flex items-center space-x-4">
          <label class="flex items-center space-x-2">
            <input
              type="checkbox"
              checked={streamMode.value}
              onChange={(e) => (streamMode.value = (e.target as HTMLInputElement).checked)}
              class="rounded"
            />
            <span class="text-sm text-gray-700">流式响应</span>
          </label>
        </div>
        <button
          onClick={clearChat}
          class="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
        >
          清空对话
        </button>
      </div>

      {/* 消息列表 */}
      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.value.map((msg, idx) => (
          <div
            key={idx}
            class={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              class={`max-w-3xl px-4 py-2 rounded-lg ${
                msg.role === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-900"
              }`}
            >
              <div class="whitespace-pre-wrap">{msg.content}</div>

              {/* 显示生成的图片 */}
              {msg.images && msg.images.length > 0 && (
                <div class="mt-3 space-y-2">
                  {msg.images.map((img, imgIdx) => (
                    <div key={imgIdx} class="border rounded overflow-hidden bg-white">
                      <img
                        src={`/api/images/${img.id}`}
                        alt={img.filename}
                        class="max-w-full h-auto"
                        loading="lazy"
                      />
                      <div class="text-xs p-2 bg-gray-50 text-gray-700">
                        {img.filename}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div
                class={`text-xs mt-1 ${
                  msg.role === "user" ? "text-blue-100" : "text-gray-500"
                }`}
              >
                {new Date(msg.timestamp).toLocaleTimeString()}
              </div>
            </div>
          </div>
        ))}

        {loading.value && (
          <div class="flex justify-start">
            <div class="bg-gray-100 px-4 py-2 rounded-lg">
              <div class="flex space-x-2">
                <div class="w-2 h-2 bg-gray-500 rounded-full animate-bounce"></div>
                <div class="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
                <div class="w-2 h-2 bg-gray-500 rounded-full animate-bounce" style="animation-delay: 0.4s"></div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 输入区域 */}
      <div class="border-t border-gray-200 p-4">
        <div class="flex space-x-2">
          <textarea
            value={input.value}
            onInput={(e) => (input.value = (e.target as HTMLTextAreaElement).value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息与 Business Gemini 对话..."
            disabled={loading.value}
            class="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            rows={3}
          />
          <button
            onClick={sendMessage}
            disabled={loading.value || !input.value.trim()}
            class="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {loading.value ? "发送中..." : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  images?: Array<{ id: string; filename: string; mime_type: string; url?: string }>;
}

interface Model {
  id: string;
  name: string;
  enabled: boolean;
}

const messages = signal<Message[]>([]);
const input = signal("");
const loading = signal(false);
const streamMode = signal(true);
const availableModels = signal<Model[]>([]);
const selectedModel = signal<string>("gemini-2.5-flash");

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

    // 加载可用模型列表
    loadModels();
  }, []);

  async function loadModels() {
    try {
      const res = await fetch("/api/models", { credentials: "include" });
      const data = await res.json();
      const models = data.models || [];
      availableModels.value = models.filter((m: Model) => m.enabled);

      // 如果当前选择的模型不可用，选择第一个可用模型
      if (availableModels.value.length > 0) {
        const isCurrentModelAvailable = availableModels.value.some(
          (m) => m.id === selectedModel.value
        );
        if (!isCurrentModelAvailable) {
          selectedModel.value = availableModels.value[0].id;
        }
      }
    } catch (error) {
      console.error("Failed to load models:", error);
    }
  }

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
        model: selectedModel.value,
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
    const aiImages: any[] = [];

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
            // content可能是字符串或对象
            if (typeof content === "string") {
              // 纯文本
              aiContent += content;
            } else if (content.type === "image_url") {
              // 图片/视频对象
              const url = content.image_url.url;
              // 根据 URL 扩展名判断文件类型
              const isVideo = /\.(mp4|webm|ogg|mov|avi|mkv)$/i.test(url);
              const filename = url.split('/').pop() || "generated_file";

              aiImages.push({
                id: url,
                url: url,
                filename: filename,
                mime_type: isVideo ? "video/mp4" : "image/png",
              });
            }

            // 更新最后一条消息
            messages.value = [
              ...messages.value.slice(0, -1),
              {
                ...aiMessage,
                content: aiContent,
                images: aiImages.length > 0 ? aiImages : undefined
              },
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
        model: selectedModel.value,
        messages: requestMessages,
        stream: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const messageContent = data.choices[0]?.message?.content;

    // 解析OpenAI标准格式的content
    let textContent = "";
    let images: any[] | undefined;

    if (typeof messageContent === "string") {
      // 纯文本格式
      textContent = messageContent;
    } else if (Array.isArray(messageContent)) {
      // 数组格式（包含文本和图片/视频）
      const imageItems: any[] = [];
      for (const item of messageContent) {
        if (item.type === "text") {
          textContent += item.text;
        } else if (item.type === "image_url") {
          const url = item.image_url.url;
          // 根据 URL 扩展名判断文件类型
          const isVideo = /\.(mp4|webm|ogg|mov|avi|mkv)$/i.test(url);
          const filename = url.split('/').pop() || "generated_file";

          imageItems.push({
            id: url,
            url: url,
            filename: filename,
            mime_type: isVideo ? "video/mp4" : "image/png",
          });
        }
      }
      if (imageItems.length > 0) {
        images = imageItems;
      }
    }

    const aiMessage: Message = {
      role: "assistant",
      content: textContent || "无响应",
      timestamp: new Date().toISOString(),
      images: images,
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

          {/* 模型选择器 */}
          <label class="flex items-center space-x-2">
            <span class="text-sm text-gray-700">模型:</span>
            <select
              value={selectedModel.value}
              onChange={(e) => (selectedModel.value = (e.target as HTMLSelectElement).value)}
              class="px-2 py-1 text-sm border border-gray-300 rounded"
            >
              {availableModels.value.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
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

              {/* 显示生成的图片/视频 */}
              {msg.images && msg.images.length > 0 && (
                <div class="mt-3 space-y-2">
                  {msg.images.map((img, imgIdx) => {
                    const mediaUrl = img.url || `/api/images/${img.id}`;
                    const isVideo = img.mime_type?.startsWith('video/');

                    return (
                      <div key={imgIdx} class="border rounded overflow-hidden bg-white">
                        {isVideo ? (
                          <video
                            src={mediaUrl}
                            controls
                            class="max-w-full h-auto"
                            preload="metadata"
                          >
                            您的浏览器不支持视频播放。
                          </video>
                        ) : (
                          <img
                            src={mediaUrl}
                            alt={img.filename}
                            class="max-w-full h-auto"
                            loading="lazy"
                          />
                        )}
                        <div class="text-xs p-2 bg-gray-50 text-gray-700">
                          {img.filename}
                        </div>
                      </div>
                    );
                  })}
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

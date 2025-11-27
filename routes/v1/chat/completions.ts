import { Handlers } from "$fresh/server.ts";
import { AccountManager } from "../../../lib/account-manager.ts";
import { ensureJWT } from "../../../lib/jwt-manager.ts";
import { ensureSession } from "../../../lib/session-manager.ts";
import { streamChat } from "../../../lib/gemini-api.ts";
import type { ChatCompletionRequest, ChatMessage } from "../../../lib/types.ts";
import { requireAuth } from "../../../lib/auth.ts";
import { ImageCacheManager } from "../../../lib/image-cache.ts";
import { ConfigStore } from "../../../lib/config-store.ts";
import { uploadBase64ToCfbed } from "../../../lib/upload-service.ts";

/**
 * OpenAI 兼容的聊天完成接口
 * POST /v1/chat/completions
 */
export const handler: Handlers = {
  async POST(req, _ctx) {
    const kv = await Deno.openKv();
    const manager = new AccountManager(kv);

    try {
      // API Key 或 Cookie 认证
      const authError = await requireAuth(kv, req);
      if (authError) return authError;
      const body: ChatCompletionRequest = await req.json();
      const { messages, stream = false, model = "gemini-enterprise" } = body;

      if (!messages || messages.length === 0) {
        return Response.json({ error: "No messages provided" }, { status: 400 });
      }

      // 获取代理配置
      const proxyRes = await kv.get<string>(["config", "proxy"]);
      const proxy = proxyRes.value || undefined;

      // 多账号重试逻辑
      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let i = 0; i < maxRetries; i++) {
        try {
          // 轮训获取账号
          const account = await manager.getNextAccountAtomic();
          console.log(`[Attempt ${i + 1}] Using account:`, account.id);

          // 确保 JWT 和会话
          const jwt = await ensureJWT(kv, account);
          const session = await ensureSession(kv, account, jwt);

          // 调用 Gemini API
          const result = await streamChat({
            jwt,
            session,
            messages,
            teamId: account.team_id,
            model, // 传递模型名，用于动态构建 toolsSpec
            proxy,
          });

          // 获取上传配置
          const configStore = new ConfigStore(kv);
          const config = await configStore.getConfig();
          const useUploadService = config.upload_endpoint && config.upload_api_token;

          // 处理图片并准备响应
          const imageCacheManager = new ImageCacheManager(kv);
          const imageMetadata: Array<{
            id: string;
            filename: string;
            mime_type: string;
            url?: string;
          }> = [];

          if (result.images && result.images.length > 0) {
            console.log(`Processing ${result.images.length} images`);

            for (const img of result.images) {
              try {
                const fileName = img.file_name || "image.png";

                // 处理 fileId 引用（下载后上传）
                if (img.file_id && img.url) {
                  console.log(`Processing fileId: ${img.file_id}, type: ${img.mime_type}`);

                  // 判断是否为视频
                  const isVideo = img.mime_type.startsWith('video/');

                  if (useUploadService) {
                    // 下载文件到内存
                    const { downloadFileWithJWT } = await import("../../../lib/gemini-api.ts");
                    const { uploadToCfbed } = await import("../../../lib/upload-service.ts");

                    const stream = await downloadFileWithJWT({
                      jwt,
                      session: img.url, // url 字段存储的是 session 路径
                      fileId: img.file_id,
                      proxy,
                    });

                    if (stream) {
                      console.log(`Downloading ${isVideo ? 'video' : 'image'}: ${fileName}...`);

                      // 读取流到内存
                      const reader = stream.getReader();
                      const chunks: Uint8Array[] = [];
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                      }

                      // 合并所有块
                      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                      const bytes = new Uint8Array(totalLength);
                      let offset = 0;
                      for (const chunk of chunks) {
                        bytes.set(chunk, offset);
                        offset += chunk.length;
                      }

                      console.log(`Downloaded ${totalLength} bytes, uploading to cfbed...`);

                      // 上传到 cfbed
                      const uploadResult = await uploadToCfbed({
                        endpoint: config.upload_endpoint!,
                        apiToken: config.upload_api_token!,
                        file: bytes,
                        fileName,
                        mimeType: img.mime_type,
                      });

                      const baseUrl = config.image_base_url || config.upload_endpoint!.replace(/\/upload$/, "");
                      const fullUrl = `${baseUrl}${uploadResult.src}`;

                      imageMetadata.push({
                        id: uploadResult.src,
                        filename: fileName,
                        mime_type: img.mime_type,
                        url: fullUrl,
                      });

                      console.log(`Uploaded to cfbed: ${fullUrl} (${totalLength} bytes)`);
                    }
                  } else {
                    // 下载并缓存到 Deno KV
                    const { downloadFileWithJWT } = await import("../../../lib/gemini-api.ts");

                    const stream = await downloadFileWithJWT({
                      jwt,
                      session: img.url,
                      fileId: img.file_id,
                      proxy,
                    });

                    if (stream) {
                      // 读取流到内存（KV 需要完整数据）
                      const reader = stream.getReader();
                      const chunks: Uint8Array[] = [];
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                      }

                      // 合并所有块
                      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
                      const bytes = new Uint8Array(totalLength);
                      let offset = 0;
                      for (const chunk of chunks) {
                        bytes.set(chunk, offset);
                        offset += chunk.length;
                      }

                      const cacheId = await imageCacheManager.saveDownloadedImage(
                        bytes,
                        img.mime_type,
                        fileName
                      );

                      imageMetadata.push({
                        id: cacheId,
                        filename: fileName,
                        mime_type: img.mime_type,
                      });

                      console.log(`Cached to KV: ${cacheId} (${fileName})`);
                    }
                  }
                }
                // 处理 base64 数据
                else if (img.base64_data) {
                  if (useUploadService) {
                    // 上传到 cfbed
                    console.log(`Uploading ${fileName} to cfbed...`);
                    const uploadResult = await uploadBase64ToCfbed(
                      config.upload_endpoint!,
                      config.upload_api_token!,
                      img.base64_data,
                      fileName,
                      img.mime_type
                    );

                    // 构建完整 URL
                    const baseUrl = config.image_base_url || config.upload_endpoint!.replace(/\/upload$/, "");
                    const fullUrl = `${baseUrl}${uploadResult.src}`;

                    imageMetadata.push({
                      id: uploadResult.src,
                      filename: fileName,
                      mime_type: img.mime_type,
                      url: fullUrl,
                    });

                    console.log(`Uploaded to cfbed: ${fullUrl}`);
                  } else {
                    // 缓存到 Deno KV
                    const binaryString = atob(img.base64_data);
                    const bytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                      bytes[i] = binaryString.charCodeAt(i);
                    }

                    const cacheId = await imageCacheManager.saveDownloadedImage(
                      bytes,
                      img.mime_type,
                      fileName
                    );

                    imageMetadata.push({
                      id: cacheId,
                      filename: fileName,
                      mime_type: img.mime_type,
                    });

                    console.log(`Cached to KV: ${cacheId} (${fileName})`);
                  }
                }
              } catch (err) {
                console.error("Failed to process image:", err);
              }
            }
          }

          // 成功获取响应
          if (stream) {
            return createStreamResponse(result.text, model, messages, imageMetadata);
          } else {
            return createNonStreamResponse(result.text, model, messages, imageMetadata);
          }
        } catch (error) {
          lastError = error as Error;
          console.error(`[Attempt ${i + 1}] Failed:`, error);

          // 如果是 429 错误，立即返回，不重试
          if (error.message === "RATE_LIMIT_EXCEEDED") {
            return Response.json(
              { error: "负载过高，请稍后再试" },
              { status: 429 }
            );
          }

          // 如果是 401/404 错误，标记账号不可用
          if (error.message.includes("401") || error.message.includes("404")) {
            const account = await manager.getNextAccountAtomic();
            await manager.markUnavailable(account.id, error.message);
          }

          // 继续重试下一个账号
          continue;
        }
      }

      // 所有账号都失败
      return Response.json(
        { error: `All accounts failed: ${lastError?.message}` },
        { status: 500 }
      );
    } catch (error) {
      console.error("Request processing error:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
      );
    } finally {
      kv.close();
    }
  },
};

/**
 * 创建流式响应
 */
function createStreamResponse(
  text: string,
  model: string,
  messages: ChatMessage[],
  images?: Array<{ id: string; filename: string; mime_type: string; url?: string }>
): Response {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const stream = new ReadableStream({
    start(controller) {
      try {
        // 如果有文本，分块发送
        if (text && text.trim()) {
          const words = text.split(" ");
          for (let i = 0; i < words.length; i++) {
            const currentChunk = words[i] + (i < words.length - 1 ? " " : "");

            const chunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: currentChunk,
                  },
                  finish_reason: null,
                },
              ],
            };

            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        }

        // 如果有图片/视频，逐个发送
        if (images && images.length > 0) {
          for (const img of images) {
            const mediaUrl = img.url || `/api/images/${img.id}`;
            const imageChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: {
                      type: "image_url",
                      image_url: {
                        url: mediaUrl,
                      },
                    },
                  },
                  finish_reason: null,
                },
              ],
            };

            controller.enqueue(encoder.encode(`data: ${JSON.stringify(imageChunk)}\n\n`));
          }
        }

        // 发送结束标记
        const finalChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };

        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/**
 * 创建非流式响应
 */
function createNonStreamResponse(
  text: string,
  model: string,
  messages: ChatMessage[],
  images?: Array<{ id: string; filename: string; mime_type: string; url?: string }>
): Response {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // 估算 token 数量（简单估计：每4个字符约1个token）
  const estimateTokens = (str: string) => Math.ceil(str.length / 4);

  const promptTokens = messages.reduce((sum, msg) => {
    const content = typeof msg.content === "string"
      ? msg.content
      : JSON.stringify(msg.content);
    return sum + estimateTokens(content);
  }, 0);

  const completionTokens = estimateTokens(text);

  // 构建符合OpenAI标准的content
  let messageContent: string | Array<any>;

  if (images && images.length > 0) {
    // 如果有图片，使用数组格式
    messageContent = [];

    // 添加文本部分（如果有）
    if (text && text.trim()) {
      messageContent.push({
        type: "text",
        text: text,
      });
    }

    // 添加图片部分
    for (const img of images) {
      const imageUrl = img.url || `/api/images/${img.id}`;
      messageContent.push({
        type: "image_url",
        image_url: {
          url: imageUrl,
        },
      });
    }
  } else {
    // 如果没有图片，使用纯文本格式
    messageContent = text;
  }

  return Response.json({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: messageContent,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

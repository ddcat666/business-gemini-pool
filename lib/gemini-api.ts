import type {
  Account,
  GeminiResponse,
  GeminiImageResponse,
  ChatImage,
  GeminiQueryPart,
  ChatMessage,
} from "./types.ts";

const BASE_URL = "https://biz-discoveryengine.googleapis.com/v1alpha/locations/global";
const STREAM_ASSIST_URL = `${BASE_URL}/widgetStreamAssist`;
const DOWNLOAD_FILE_BASE = "https://biz-discoveryengine.googleapis.com/v1alpha";
const LIST_FILE_METADATA_URL = `${BASE_URL}/widgetListSessionFileMetadata`;

/**
 * 获取请求头
 */
function getHeaders(jwt: string): HeadersInit {
  return {
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    authorization: `Bearer ${jwt}`,
    "content-type": "application/json",
    origin: "https://business.gemini.google",
    referer: "https://business.gemini.google/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Microsoft Edge";v="140"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "x-server-timeout": "1800",
  };
}

/**
 * 提取消息中的文本内容
 */
function extractTextFromMessage(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  // 处理包含图片的消息
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("\n");
  }

  return "";
}

/**
 * 处理图片 URL（下载并转为 base64）
 */
async function processImageUrl(
  url: string | undefined,
  proxy?: string
): Promise<{ mimeType: string; base64Data: string } | null> {
  if (!url) return null;

  try {
    const fetchOptions: RequestInit = {};
    if (proxy) {
      try {
        const proxyClient = Deno.createHttpClient({ proxy: { url: proxy } });
        (fetchOptions as any).client = proxyClient;
      } catch (e) {
        console.warn("Failed to create proxy client:", e);
      }
    }

    const response = await fetch(url, fetchOptions);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "image/png";
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const base64 = btoa(String.fromCharCode(...bytes));

    return { mimeType: contentType, base64Data: base64 };
  } catch (e) {
    console.error("Failed to process image URL:", url, e);
    return null;
  }
}

/**
 * 解析 generatedImages 中的图片
 */
function parseGeneratedImage(genImg: any, images: ChatImage[]): void {
  const b64Data =
    genImg.image?.bytesBase64Encoded ??
    genImg.bytesBase64Encoded;

  if (b64Data) {
    const mimeType = genImg.image?.mimeType ?? genImg.mimeType ?? "image/png";
    const filename = `${crypto.randomUUID()}.${mimeType.split("/")[1] || "png"}`;
    images.push({
      base64_data: b64Data,
      mime_type: mimeType,
      file_name: filename,
    });
  }
}

/**
 * 从 content 对象中解析图片（inlineData 和 imageBytes）
 */
function parseImageFromContent(content: any, images: ChatImage[]): void {
  if (!content) return;

  // 检查 inlineData
  if (content.inlineData?.data) {
    const mimeType = content.inlineData.mimeType || "image/png";
    const filename = `${crypto.randomUUID()}.${mimeType.split("/")[1] || "png"}`;
    images.push({
      base64_data: content.inlineData.data,
      mime_type: mimeType,
      file_name: filename,
    });
  }

  // 检查 imageBytes
  if (content.imageBytes) {
    const mimeType = content.mimeType || "image/png";
    const filename = `${crypto.randomUUID()}.${mimeType.split("/")[1] || "png"}`;
    images.push({
      base64_data: content.imageBytes,
      mime_type: mimeType,
      file_name: filename,
    });
  }
}

/**
 * 解析 attachment 中的图片
 */
function parseAttachment(att: any, images: ChatImage[]): void {
  if (!att || !att.mimeType?.startsWith("image/")) return;

  const b64Data = att.data || att.bytesBase64Encoded;
  if (b64Data) {
    const filename = att.name || `${crypto.randomUUID()}.${att.mimeType.split("/")[1] || "png"}`;
    images.push({
      base64_data: b64Data,
      mime_type: att.mimeType,
      file_name: filename,
    });
  }
}

/**
 * 流式聊天请求（完全对齐 Python 版本）
 */
export async function streamChat(params: {
  jwt: string;
  session: string;
  messages: ChatMessage[];
  teamId: string;
  proxy?: string;
}): Promise<GeminiImageResponse> {
  const { jwt, session, messages, teamId, proxy } = params;

  // 构建完整的 query parts（包含所有消息，支持文本 + 图片）
  const queryParts: GeminiQueryPart[] = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.content.trim()) {
        queryParts.push({ text: message.content });
      }
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text" && part.text) {
          queryParts.push({ text: part.text });
        } else if (part.type === "image_url") {
          // 处理图片 URL（下载并转 base64）
          const imageData = await processImageUrl(part.image_url?.url, proxy);
          if (imageData) {
            queryParts.push({
              inlineData: {
                mimeType: imageData.mimeType,
                data: imageData.base64Data,
              },
            });
          }
        }
      }
    }
  }

  if (queryParts.length === 0) {
    throw new Error("No valid message content found");
  }

  // 完整的 API 请求结构（对齐 Python）
  const body = {
    configId: teamId,
    additionalParams: { token: "-" },
    streamAssistRequest: {
      session: session,
      query: { parts: queryParts },
      filter: "",
      fileIds: [],
      answerGenerationMode: "NORMAL",
      toolsSpec: {
        webGroundingSpec: {},
        toolRegistry: "default_tool_registry",
        imageGenerationSpec: {},
        videoGenerationSpec: {},
      },
      languageCode: "zh-CN",
      userMetadata: { timeZone: "Etc/GMT-8" },
      assistSkippingMode: "REQUEST_ASSIST",
    },
  };

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: getHeaders(jwt),
    body: JSON.stringify(body),
  };

  // 如果有代理配置，使用代理
  if (proxy) {
    try {
      const proxyClient = Deno.createHttpClient({ proxy: { url: proxy } });
      (fetchOptions as any).client = proxyClient;
    } catch (e) {
      console.warn("Failed to create proxy client:", e);
    }
  }

  const res = await fetch(STREAM_ASSIST_URL, fetchOptions);
  const text = await res.text();

  if (!res.ok) {
    console.error(
      "Stream request failed",
      res.status,
      res.statusText,
      text.slice(0, 200)
    );
    throw new Error(`Stream request failed: ${res.status}`);
  }

  // 解析响应 - 多层级图片检查
  const replies: string[] = [];
  const images: ChatImage[] = [];
  const fileIdsToDownload: Array<{
    fileId: string;
    mimeType: string;
    fileName?: string;
  }> = [];
  let currentSession: string | undefined;

  try {
    const dataList = JSON.parse(text);

    for (const item of dataList) {
      const sar = item.streamAssistResponse;
      if (!sar) continue;

      // 保存会话ID（用于下载 fileId 图片）
      if (sar.sessionInfo?.session) {
        currentSession = sar.sessionInfo.session;
      }

      // 1. 检查顶层 generatedImages
      for (const genImg of sar.generatedImages || []) {
        parseGeneratedImage(genImg, images);
      }

      const answer = sar.answer || {};

      // 2. 检查 answer 级别 generatedImages
      for (const genImg of answer.generatedImages || []) {
        parseGeneratedImage(genImg, images);
      }

      // 3. 检查每个 reply
      for (const reply of answer.replies || []) {
        // 3a. reply 级别 generatedImages
        for (const genImg of reply.generatedImages || []) {
          parseGeneratedImage(genImg, images);
        }

        const gc = reply.groundedContent || {};
        const content = gc.content || {};

        // 3b. 提取 fileId 引用（关键！）
        if (content.file?.fileId) {
          fileIdsToDownload.push({
            fileId: content.file.fileId,
            mimeType: content.file.mimeType || "image/png",
            fileName: content.file.name,
          });
        }

        // 3c. 检查 inlineData 和 imageBytes
        parseImageFromContent(content, images);
        parseImageFromContent(gc, images);

        // 3d. 检查所有层级的 attachments
        const attachments = [
          ...(reply.attachments || []),
          ...(gc.attachments || []),
          ...(content.attachments || []),
        ];
        for (const att of attachments) {
          parseAttachment(att, images);
        }

        // 收集文本回复
        const parts = content.parts || [];
        for (const part of parts) {
          if (part.text) {
            replies.push(part.text);
          }
        }
      }
    }

    // 4. 下载 fileId 引用的图片
    if (fileIdsToDownload.length > 0 && currentSession) {
      console.log(
        `Found ${fileIdsToDownload.length} fileId references to download`
      );

      for (const finfo of fileIdsToDownload) {
        try {
          const imageData = await downloadFileWithJWT({
            jwt,
            session: currentSession,
            fileId: finfo.fileId,
            proxy,
          });

          if (imageData) {
            const filename =
              finfo.fileName ||
              `${crypto.randomUUID()}.${finfo.mimeType.split("/")[1] || "png"}`;
            const base64Data = btoa(String.fromCharCode(...imageData));

            images.push({
              file_id: finfo.fileId,
              file_name: filename,
              mime_type: finfo.mimeType,
              base64_data: base64Data,
            });

            console.log(`Successfully downloaded image: ${filename}`);
          }
        } catch (err) {
          console.error(`Failed to download fileId ${finfo.fileId}:`, err);
          // 单个图片失败不影响其他图片
        }
      }
    }
  } catch (err) {
    console.error("Parse response error:", text.slice(0, 200), err);
    throw err;
  }

  console.log(`Parsed ${replies.length} text replies, ${images.length} images`);

  return {
    text: replies.join("\n"),
    images,
    session: currentSession,
  };
}

/**
 * 下载文件（使用 JWT）
 */
export async function downloadFileWithJWT(params: {
  jwt: string;
  session: string;
  fileId: string;
  proxy?: string;
}): Promise<Uint8Array | undefined> {
  const { jwt, session, fileId, proxy } = params;
  const url = `${DOWNLOAD_FILE_BASE}/${session}:downloadFile?fileId=${fileId}&alt=media`;

  const fetchOptions: RequestInit = {
    headers: getHeaders(jwt),
    redirect: "follow",
  };

  if (proxy) {
    try {
      const proxyClient = Deno.createHttpClient({ proxy: { url: proxy } });
      (fetchOptions as any).client = proxyClient;
    } catch (e) {
      console.warn("Failed to create proxy client:", e);
    }
  }

  const res = await fetch(url, fetchOptions);
  if (!res.ok) {
    console.error("Download file failed", res.status, res.statusText);
    return undefined;
  }

  return new Uint8Array(await res.arrayBuffer());
}

/**
 * 列出会话文件元数据
 */
export async function listSessionFileMetadata(params: {
  jwt: string;
  session: string;
  teamId: string;
  proxy?: string;
}): Promise<Record<string, any>> {
  const { jwt, session, teamId, proxy } = params;

  const body = {
    configId: teamId,
    additionalParams: { token: "-" },
    listSessionFileMetadataRequest: {
      name: session,
      filter: "file_origin_type = AI_GENERATED",
    },
  };

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: getHeaders(jwt),
    body: JSON.stringify(body),
  };

  if (proxy) {
    try {
      const proxyClient = Deno.createHttpClient({ proxy: { url: proxy } });
      (fetchOptions as any).client = proxyClient;
    } catch (e) {
      console.warn("Failed to create proxy client:", e);
    }
  }

  const res = await fetch(LIST_FILE_METADATA_URL, fetchOptions);
  const text = await res.text();

  if (!res.ok) {
    console.error("List file metadata failed", res.status, res.statusText, text.slice(0, 200));
    return {};
  }

  try {
    const data = JSON.parse(text);
    const list = data.listSessionFileMetadataResponse?.fileMetadata ?? [];
    const result: Record<string, any> = {};
    list.forEach((fm: any) => {
      if (fm.fileId) result[fm.fileId] = fm;
    });
    return result;
  } catch (err) {
    console.error("Parse file metadata failed", err);
    return {};
  }
}

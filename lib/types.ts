// Business Gemini Pool - TypeScript 类型定义

export interface Account {
  id: string;
  team_id: string;
  secure_c_ses: string;
  host_c_oses: string;
  csesidx: string;
  user_agent: string;
  available: boolean;
  unavailable_reason?: string;
  unavailable_time?: string;
  created_at: number;
}

export interface Model {
  id: string;
  name: string;
  description: string;
  context_length: number;
  max_tokens: number;
  is_public: boolean;
  enabled?: boolean;
}

export interface JWTCache {
  jwt: string;
  expires_at: number;
}

export interface SessionCache {
  session_id: string;
  created_at: number;
}

export interface ImageCache {
  data: Uint8Array;
  mime_type: string;
  file_name: string;
  created_at: number;
}

export interface Config {
  proxy?: string;
  image_base_url?: string;
}

// OpenAI 兼容类型
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatMessageContent[];
}

export interface ChatMessageContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: string | null;
  }[];
}

// Gemini API 类型
export interface GeminiResponse {
  text: string;
  images?: Array<{
    url?: string;
    base64?: string;
    file_name?: string;
  }>;
}

// 图片数据结构（对应 Python ChatImage）
export interface ChatImage {
  file_id?: string; // Gemini fileId
  file_name?: string; // 文件名
  mime_type: string; // MIME 类型
  local_path?: string; // 本地缓存路径（可选）
  base64_data?: string; // Base64 编码数据
  url?: string; // 图片 URL（可选）
}

// Gemini 响应结构（包含文本和图片）
export interface GeminiImageResponse {
  text: string;
  images: ChatImage[];
  session?: string; // 会话ID（用于下载 fileId 图片）
}

// Gemini 查询 Part 结构
export interface GeminiQueryPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string; // Base64
  };
}

// Gemini 完整请求结构（对应 Python body）
export interface GeminiStreamAssistRequest {
  session: string;
  query: { parts: GeminiQueryPart[] };
  filter: string;
  fileIds: string[];
  answerGenerationMode: string;
  toolsSpec: {
    webGroundingSpec: Record<string, unknown>;
    toolRegistry: string;
    imageGenerationSpec: Record<string, unknown>;
    videoGenerationSpec: Record<string, unknown>;
  };
  languageCode: string;
  userMetadata: { timeZone: string };
  assistSkippingMode: string;
}

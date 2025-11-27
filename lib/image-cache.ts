import type { ImageCache } from "./types.ts";

/**
 * 图片缓存管理器（基于 Deno KV）
 * 注意：Deno KV 单个值限制为 64KB
 */
export class ImageCacheManager {
  private kv: Deno.Kv;
  private maxSize: number;

  constructor(kv: Deno.Kv, maxSize = 60000) {
    // 默认 60KB，留一些余量
    this.kv = kv;
    this.maxSize = maxSize;
  }

  /**
   * 缓存图片（如果小于限制）
   * 返回 true 表示成功缓存，false 表示图片太大
   */
  async cacheImage(fileId: string, data: Uint8Array, mimeType: string, fileName: string): Promise<boolean> {
    if (data.byteLength > this.maxSize) {
      console.warn(`Image ${fileId} too large for KV (${data.byteLength} bytes), skipping cache`);
      return false;
    }

    const imageCache: ImageCache = {
      data,
      mime_type: mimeType,
      file_name: fileName,
      created_at: Date.now(),
    };

    await this.kv.set(["images", fileId], imageCache, {
      expireIn: 3600000, // 1 小时后自动过期
    });

    return true;
  }

  /**
   * 从缓存获取图片
   */
  async getImage(fileId: string): Promise<ImageCache | null> {
    const res = await this.kv.get<ImageCache>(["images", fileId]);
    return res.value;
  }

  /**
   * 删除缓存的图片
   */
  async deleteImage(fileId: string): Promise<void> {
    await this.kv.delete(["images", fileId]);
  }

  /**
   * 清理所有过期图片（手动触发）
   */
  async cleanupExpiredImages(): Promise<number> {
    const entries = this.kv.list<ImageCache>({ prefix: ["images"] });
    const now = Date.now();
    let count = 0;

    for await (const entry of entries) {
      if (entry.value && now - entry.value.created_at > 3600000) {
        await this.kv.delete(entry.key);
        count++;
      }
    }

    return count;
  }

  /**
   * 将 Uint8Array 转换为 Base64
   */
  static toBase64(data: Uint8Array): string {
    let binary = "";
    const len = data.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
  }

  /**
   * 将 Base64 转换为 Uint8Array
   */
  static fromBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * 保存下载的图片到缓存并返回缓存 ID
   */
  async saveDownloadedImage(
    imageData: Uint8Array,
    mimeType: string,
    fileName: string
  ): Promise<string> {
    const cacheId = crypto.randomUUID();
    const success = await this.cacheImage(cacheId, imageData, mimeType, fileName);

    if (!success) {
      console.warn(`Failed to cache image ${fileName} (too large)`);
    }

    return cacheId;
  }

  /**
   * 获取图片的 data URL
   */
  async getImageDataUrl(cacheId: string): Promise<string | null> {
    const image = await this.getImage(cacheId);
    if (!image) return null;

    const base64 = ImageCacheManager.toBase64(image.data);
    return `data:${image.mime_type};base64,${base64}`;
  }
}

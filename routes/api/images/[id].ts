import { Handlers } from "$fresh/server.ts";
import { ImageCacheManager } from "../../../lib/image-cache.ts";

/**
 * 图片服务路由
 * GET /api/images/:id - 获取缓存的图片
 */
export const handler: Handlers = {
  async GET(_req, ctx) {
    const kv = await Deno.openKv();
    const imageCacheManager = new ImageCacheManager(kv);

    try {
      const imageId = ctx.params.id;
      const image = await imageCacheManager.getImage(imageId);

      if (!image) {
        return new Response("Image not found", { status: 404 });
      }

      return new Response(image.data, {
        headers: {
          "Content-Type": image.mime_type,
          "Cache-Control": "public, max-age=3600",
          "Content-Disposition": `inline; filename="${image.file_name}"`,
        },
      });
    } finally {
      kv.close();
    }
  },
};

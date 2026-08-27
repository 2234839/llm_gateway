import { Jimp } from "jimp"
import type { GatewayDB } from "../db.ts"
import type { PendingLogImage } from "../types.ts"

/** 超过该字节数的原图进行压缩重编码 */
const COMPRESS_THRESHOLD = 1_048_576

/** 压缩目标的像素上限：与视觉模型输入的推荐尺寸同量级，兼顾日志可读性 */
const MAX_DIMENSION = 2048

/** 可编码 JPEG 的最小接口（约束 jimp 实例，避免库内部泛型类型的不兼容实例化问题） */
interface JpegEncodable {
  bitmap: { width: number; height: number }
  getBuffer(mime: "image/jpeg", options: { quality: number }): Promise<Buffer>
}

/**
 * 编码为 JPEG 并迭代降质直到满足字节限制
 */
async function encodeUnderLimit<I extends JpegEncodable>(image: I): Promise<{ width: number; height: number; data: Buffer }> {
  let quality = 80
  let encoded = await image.getBuffer("image/jpeg", { quality })
  while (encoded.length > COMPRESS_THRESHOLD && quality > 20) {
    quality -= 15
    encoded = await image.getBuffer("image/jpeg", { quality })
  }
  return { width: image.bitmap.width, height: image.bitmap.height, data: Buffer.from(encoded) }
}

/**
 * 归一化单张待存储图片：小于等于 1MB 的原样保留原始格式字节并读取尺寸；
 * 超限的等比缩放到长边不超过 2048px 后用 JPEG 重编码，仍超限则迭代降质直到达标。
 * 解码失败说明图片无效，让它抛出暴露问题（let it crash）
 */
export async function normalizeImage(img: PendingLogImage): Promise<{ mediaType: string; width: number; height: number; data: Buffer }> {
  const raw = Buffer.from(img.base64, "base64")
  const image = await Jimp.fromBuffer(raw)
  if (raw.length <= COMPRESS_THRESHOLD) {
    return { mediaType: img.mediaType, width: image.bitmap.width, height: image.bitmap.height, data: raw }
  }
  if (Math.max(image.bitmap.width, image.bitmap.height) > MAX_DIMENSION) {
    const fitted = image.scaleToFit({ w: MAX_DIMENSION, h: MAX_DIMENSION })
    return { mediaType: "image/jpeg", ...await encodeUnderLimit(fitted) }
  }
  return { mediaType: "image/jpeg", ...await encodeUnderLimit(image) }
}

/**
 * 日志图片落库旁路：提取自请求的 base64 图片经归一化后内容寻址存储，
 * 由 addLog 返回 logId 后异步调用，不阻塞响应；与消息块同生命周期（引用计数清理）
 */
export async function persistLogImages(
  db: GatewayDB,
  logId: number,
  images: PendingLogImage[],
): Promise<void> {
  if (images.length === 0) return
  const normalized = await Promise.all(images.map(normalizeImage))
  db.addMessageImages(logId, normalized.map((n, i) => ({ seq: images[i]!.seq, ...n })))
}

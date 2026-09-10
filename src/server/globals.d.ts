/** 服务端全局类型声明 */

/** 构建时注入的版本号（scripts/build.ts --define），仅编译产物中存在；dev 模式未定义，health.ts 有 typeof 守卫 */
declare const __GATEWAY_VERSION__: string

/** Bun 编译期资源嵌入：import xxx from "..." with { type: "file" } 的返回类型 */
declare type HTMLBundle = string

/** 嵌入资源映射：url path → Bun embed file path */
declare module "*/embed-assets.ts" {
  const embeddedAssets: Record<string, string | HTMLBundle>
  export { embeddedAssets }
}

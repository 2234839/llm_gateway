/** 服务端全局类型声明 */

/** 构建时注入的版本号（scripts/build.ts --define），仅编译产物中存在；dev 模式未定义，health.ts 有 typeof 守卫 */
declare const __GATEWAY_VERSION__: string

/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue"
  const component: DefineComponent<object, object, unknown>
  export default component
}

declare const __APP_VERSION__: string
/** 服务端构建时注入的版本号（scripts/build.ts --define），仅编译产物中存在 */
declare const __GATEWAY_VERSION__: string

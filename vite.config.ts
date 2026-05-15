import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import { pilot } from "vite-plugin-pilot"
import { resolve } from "path"
import { readFileSync } from "fs"

const backendPort = parseInt(process.env.PORT ?? "") || 3827
const pkgVersion = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8")).version

export default defineConfig({
  plugins: [vue(), pilot({ locale: "zh" })],
  define: {
    __APP_VERSION__: JSON.stringify(`v${pkgVersion}`),
  },
  root: ".",
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": `http://localhost:${backendPort}`,
      "/admin": `http://localhost:${backendPort}`,
      "/health": `http://localhost:${backendPort}`,
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
})

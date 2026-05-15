import { spawn } from "bun"
import { readFileSync } from "fs"
import { join } from "path"

const ROOT = import.meta.dir + "/.."
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"))

const server = spawn({
  cmd: ["bun", "run", "--watch", "src/server/index.ts"],
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, GATEWAY_VERSION: `${pkg.version}-dev` },
})

const vite = spawn({
  cmd: ["bun", "x", "vite"],
  cwd: import.meta.dir + "/..",
  stdout: "inherit",
  stderr: "inherit",
})

/** 任一进程意外退出时，杀掉另一个并报错 */
server.exited.then((code) => {
  if (code !== 0 && code !== null) {
    console.error(`Server exited with code ${code}`)
    vite.kill()
    process.exit(code ?? 1)
  }
})

vite.exited.then((code) => {
  if (code !== 0 && code !== null) {
    console.error(`Vite exited with code ${code}`)
    server.kill()
    process.exit(code ?? 1)
  }
})

process.on("SIGINT", () => {
  server.kill()
  vite.kill()
  process.exit(0)
})

await Promise.race([server.exited, vite.exited])

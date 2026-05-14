import { spawn } from "bun"

const server = spawn({
  cmd: ["bun", "run", "--watch", "src/server/index.ts"],
  cwd: import.meta.dir + "/..",
  stdout: "inherit",
  stderr: "inherit",
})

const vite = spawn({
  cmd: ["bun", "x", "vite"],
  cwd: import.meta.dir + "/..",
  stdout: "inherit",
  stderr: "inherit",
})

process.on("SIGINT", () => {
  server.kill()
  vite.kill()
  process.exit(0)
})

await Promise.race([server.exited, vite.exited])

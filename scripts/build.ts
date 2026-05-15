import { execSync } from "node:child_process"
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = import.meta.dir + "/.."
const DIST_WEB = join(ROOT, "dist/web")
const EMBED_FILE = join(ROOT, "src/server/embed-assets.ts")

/** Bun compile target → 输出文件名后缀 */
const TARGET_EXT: Record<string, string> = {
  "bun-linux-x64": "-linux-x64",
  "bun-linux-arm64": "-linux-arm64",
  "bun-windows-x64": "-windows-x64.exe",
  "bun-darwin-x64": "-macos-x64",
  "bun-darwin-arm64": "-macos-arm64",
}

const target = process.argv[2] ?? ""
const ext = TARGET_EXT[target] ?? ""
const OUTFILE = join(ROOT, `llm-gateway${ext}`)

/** 递归扫描目录，返回所有文件的相对路径 */
function scanDir(dir: string, base: string = dir): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      files.push(...scanDir(full, base))
    } else {
      files.push(relative(base, full))
    }
  }
  return files
}

console.log("=== LLM Gateway Build ===\n")
console.log(`Bun version: ${Bun.version}`)
console.log(`Target: ${target || "(local)"}`)
console.log(`Root: ${ROOT}`)

/** Step 1: 构建前端 */
console.log("\n[1/3] Building frontend...")
try {
  execSync("bun run build:web", { cwd: ROOT, stdio: "inherit" })
} catch (e) {
  console.error("Frontend build failed!")
  throw e
}

if (!existsSync(DIST_WEB)) {
  console.error("Error: dist/web not found after vite build")
  process.exit(1)
}

/** Step 2: 生成 embed-assets.ts */
console.log("\n[2/3] Generating embed-assets.ts...")
const files = scanDir(DIST_WEB)

const importLines: string[] = []
const mapEntries: string[] = []

for (const [i, file] of files.entries()) {
  const id = `f${i}`
  /** import 相对于 src/server/ 的路径 */
  const importPath = "../../dist/web/" + file.split("\\").join("/")
  importLines.push(`import ${id} from "${importPath}" with { type: "file" }`)

  const urlPath = "/" + file.split("\\").join("/")
  mapEntries.push(`  "${urlPath}": ${id},`)

  /** index.html 额外映射到根路径 */
  if (file === "index.html") {
    mapEntries.push(`  "/": ${id},`)
  }
}

const content = [
  "/** 自动生成 - 请勿手动编辑 */",
  importLines.join("\n"),
  "",
  "/** 嵌入资源映射：url path → Bun embed file path */",
  "export const embeddedAssets: Record<string, string> = {",
  ...mapEntries,
  "}",
].join("\n")

writeFileSync(EMBED_FILE, content + "\n")
console.log(`  Embedded ${files.length} files`)

/** Step 3: 编译单文件可执行文件 */
console.log("\n[3/3] Compiling executable...")

/** 从 package.json 读取版本号 */
const pkg = JSON.parse(require("fs").readFileSync(join(ROOT, "package.json"), "utf-8"))
const version = pkg.version ?? "dev"
process.env.GATEWAY_VERSION = version

const targetFlag = target ? ` --target=${target}` : ""
const buildCmd = `bun build --compile${targetFlag} --asset-naming="[name].[ext]" src/server/index.ts --outfile "${OUTFILE}"`
console.log(`  Version: ${version}`)
console.log(`  Command: ${buildCmd}`)
try {
  execSync(buildCmd, { cwd: ROOT, stdio: "inherit", env: { ...process.env, GATEWAY_VERSION: version } })
} catch (e) {
  console.error("Compile failed!")
  throw e
}

console.log(`\n=== Build complete: ${OUTFILE} ===`)
console.log(`Run: ./llm-gateway`)

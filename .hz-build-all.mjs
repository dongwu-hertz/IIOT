import { resolve } from "node:path"
import { builtinModules, createRequire } from "node:module"
import { build } from "vite"
import vue from "@vitejs/plugin-vue"

const require = createRequire(import.meta.url)
const pkg = require("./package.json")
const deps = Object.keys(pkg.dependencies || {})
const external = [
  "electron",
  /^electron\/.+/,
  ...builtinModules.flatMap((m) => [m, "node:" + m]),
  ...deps,
  ...deps.map((dep) => new RegExp("^" + dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/.+"))
]
const RELEASE = {
  version: "1.0.16",
  releaseDate: "2026-09-20",
  buildDate: new Date().toISOString().slice(0, 10),
  homepage: "https://www.hertzinno.com",
  supportEmail: "info@hertzinno.com"
}

await build({
  configFile: false,
  define: { __RELEASE__: JSON.stringify(RELEASE) },
  resolve: {
    browserField: false,
    mainFields: ["module", "jsnext:main", "jsnext"],
    conditions: ["node"],
    alias: { "@main": resolve("src/main"), "@shared": resolve("src/shared") }
  },
  build: {
    ssr: true,
    outDir: resolve("out/main"),
    emptyOutDir: true,
    target: "node22",
    assetsDir: "chunks",
    minify: false,
    cssMinify: false,
    reportCompressedSize: false,
    copyPublicDir: false,
    modulePreload: false,
    sourcemap: false,
    rollupOptions: {
      input: resolve("src/main/index.ts"),
      external,
      output: { format: "cjs", entryFileNames: "index.js", assetFileNames: "chunks/[name]-[hash].[ext]" }
    }
  }
})
console.log("[build] main done")

await build({
  configFile: false,
  resolve: { alias: { "@shared": resolve("src/shared") } },
  build: {
    ssr: true,
    outDir: resolve("out/preload"),
    emptyOutDir: true,
    target: "node22",
    assetsDir: "chunks",
    minify: false,
    cssMinify: false,
    reportCompressedSize: false,
    copyPublicDir: false,
    modulePreload: false,
    sourcemap: false,
    rollupOptions: {
      input: resolve("src/preload/index.ts"),
      external,
      output: { format: "cjs", entryFileNames: "index.js", assetFileNames: "chunks/[name]-[hash].[ext]" }
    }
  }
})
console.log("[build] preload done")

await build({
  configFile: false,
  base: "./",
  root: resolve("src/renderer"),
  resolve: { alias: { "@renderer": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
  plugins: [vue()],
  define: {
    __RELEASE__: JSON.stringify(RELEASE),
    "import.meta.env.VITE_SMOKE_PROBE": JSON.stringify(process.env.VITE_SMOKE_PROBE ?? "0")
  },
  build: {
    outDir: resolve("out/renderer"),
    emptyOutDir: true,
    target: "esnext",
    minify: false,
    cssMinify: false,
    reportCompressedSize: false,
    modulePreload: { polyfill: false },
    rollupOptions: { input: { index: resolve("src/renderer/index.html") } }
  }
})
console.log("[build] renderer done")
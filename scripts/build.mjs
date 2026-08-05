/**
 * Build the extension.
 *
 * tsc alone is not enough any more: the service worker imports onnxruntime-web
 * from node_modules, and an MV3 worker can only load files that ship inside the
 * extension package. esbuild bundles each entrypoint, and the ORT wasm binaries
 * are copied next to it because a strict extension CSP blocks the CDN fallback
 * ORT would otherwise use.
 */

import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const ENTRYPOINTS = [
    "src/background.ts",
    "src/popup.ts",
    "src/blocked.ts",
];

await build({
    entryPoints: ENTRYPOINTS.map((p) => join(ROOT, p)),
    outdir: join(ROOT, "dist"),
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    sourcemap: true,
    // ORT resolves these lazily by URL at runtime; bundling them would inline
    // multi-megabyte binaries into the worker script.
    external: ["*.wasm"],
    logLevel: "info",
});

// ORT looks for its wasm binaries under ort.env.wasm.wasmPaths (assets/ort/).
const ortSrc = join(ROOT, "node_modules/onnxruntime-web/dist");
const ortDst = join(ROOT, "assets/ort");
mkdirSync(ortDst, { recursive: true });

let copied = 0;
for (const file of readdirSync(ortSrc)) {
    if (file.startsWith("ort-wasm") && (file.endsWith(".wasm") || file.endsWith(".mjs"))) {
        cpSync(join(ortSrc, file), join(ortDst, file));
        copied++;
    }
}
console.log(`copied ${copied} onnxruntime binaries to assets/ort/`);

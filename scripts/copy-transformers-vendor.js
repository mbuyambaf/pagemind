#!/usr/bin/env node
// Copies the browser runtime files for @huggingface/transformers (and its
// bundled ONNX Runtime Web WASM backend) out of node_modules and into
// vendor/, so the extension can load them as local, bundled files instead
// of fetching remotely at runtime — required for Manifest V3, which
// disallows extensions from executing remotely hosted code.
//
// Re-run this script (`npm run vendor:transformers`) after bumping the
// @huggingface/transformers version in package.json.

"use strict";

const fs = require("fs");
const path = require("path");

const SOURCE_DIR = path.join(
  __dirname,
  "..",
  "node_modules",
  "@huggingface",
  "transformers",
  "dist"
);
const TARGET_DIR = path.join(__dirname, "..", "vendor");

// Map of "source filename in node_modules" -> "filename to write into vendor/".
// The ONNX Runtime Web WASM loader/binary must keep their exact original
// names, since the bundled runtime looks them up by name relative to the
// configured wasmPaths directory.
const FILES_TO_COPY = {
  "transformers.web.min.js": "transformers.js",
  "ort-wasm-simd-threaded.jsep.mjs": "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm": "ort-wasm-simd-threaded.jsep.wasm",
};

fs.mkdirSync(TARGET_DIR, { recursive: true });

for (const [sourceName, targetName] of Object.entries(FILES_TO_COPY)) {
  const sourcePath = path.join(SOURCE_DIR, sourceName);
  const targetPath = path.join(TARGET_DIR, targetName);
  fs.copyFileSync(sourcePath, targetPath);
  console.log(`Copied ${sourceName} -> vendor/${targetName}`);
}

console.log("Done vendoring @huggingface/transformers runtime files.");

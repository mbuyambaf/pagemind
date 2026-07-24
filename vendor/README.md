# vendor/

These files are the browser runtime for [`@huggingface/transformers`](https://github.com/huggingface/transformers.js)
(Apache-2.0 licensed), vendored locally so the extension can load them as
bundled, local files instead of fetching remote code at runtime — required
under Manifest V3, which disallows extensions from executing remotely
hosted JavaScript.

| File | Source |
| --- | --- |
| `transformers.js` | `node_modules/@huggingface/transformers/dist/transformers.web.min.js` |
| `ort-wasm-simd-threaded.jsep.mjs` | `node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs` |
| `ort-wasm-simd-threaded.jsep.wasm` | `node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm` |

Only the runtime code is bundled here — the actual model weights
(`onnx-community/Qwen2.5-0.5B-Instruct`) are fetched from the Hugging Face
Hub at first use and cached by the browser, not shipped with the extension.

To regenerate after bumping the `@huggingface/transformers` version in
`package.json`:

```sh
npm install
npm run vendor:transformers
```

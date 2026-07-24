# PageMind

A "naked MVP" Chrome extension (Manifest V3) that summarizes the current web
page. There is no backend — everything happens in the browser, and **no API
key is required to use it**.

## How summarization works

On "Summarize Page", the background service worker picks the best available
engine, in this order:

1. **Chrome's built-in on-device AI** (Prompt API / Gemini Nano) — free,
   fully local, no API key. Used automatically on Chrome 138+ when the
   device meets the hardware requirements.
2. **Groq cloud API** — only used if you've optionally saved a free
   [Groq API key](https://console.groq.com/keys) in Settings. Purely a
   quality upgrade; never required.
3. **A local open-source model** ([`onnx-community/Qwen2.5-0.5B-Instruct`](https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct)
   from the Hugging Face Hub) — runs fully client-side via
   [`@huggingface/transformers`](https://github.com/huggingface/transformers.js)
   (WebAssembly) in a hidden offscreen document. Works in any Chromium
   browser with no hardware gate, so it's the guaranteed fallback: the
   extension never *requires* an account or credential to produce a
   summary. The model (~400MB) downloads once and is cached by the browser.

## Project layout

- `manifest.json` — Manifest V3 config.
- `popup.html` / `popup.css` / `popup.js` — the toolbar popup UI and its logic.
- `background.js` — service worker: message routing + all three summarization engines.
- `content.js` — injected on-demand to scrape the page's readable text.
- `offscreen.html` / `offscreen.js` — hosts the local open-source model (engine 3), since a service worker can be suspended mid-task and isn't a safe place to keep a loaded model resident.
- `vendor/` — bundled `@huggingface/transformers` runtime files (see `vendor/README.md`). Required locally because Manifest V3 disallows extensions from executing remotely hosted code.

## Development

Vendored runtime files are already committed, so no build step is required
to load the extension as-is. To regenerate them after bumping the
`@huggingface/transformers` version in `package.json`:

```sh
npm install
npm run vendor:transformers
```

## Loading the extension

1. Open `chrome://extensions`.
2. Enable "Developer mode".
3. Click "Load unpacked" and select this repository's root folder.

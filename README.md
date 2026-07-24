# PageMind

A "naked MVP" Chrome extension (Manifest V3) that summarizes the current web
page. There is no backend server; everything happens in the browser, using
the Groq Chat Completions API to generate summaries.

## How summarization works

1. Clicking "Summarize Page" sends a message to the background service
   worker with the active tab's id and URL.
2. The service worker injects `content.js` into that tab to scrape the
   page's readable text (strips nav/header/footer/ads, drops short lines,
   trims to a reasonable length).
3. That text is sent to the Groq Chat Completions API
   (`llama-3.3-70b-versatile`), streamed, and parsed into a JSON array of
   `{ heading, bullet_points }` sections.
4. The popup renders the sections as an expandable summary, with Stop and
   Revise actions, and a Copy-to-clipboard button.

**A Groq API key is required.** It's hardcoded in `background.js` — there
is no user-facing settings UI. Get a free key (no credit card) at
[console.groq.com/keys](https://console.groq.com/keys) and paste it into
the `GROQ_API_KEY` constant before loading the extension.

## Project layout

- `manifest.json` — Manifest V3 config (permissions, background service
  worker, popup action).
- `popup.html` / `popup.css` / `popup.js` — the toolbar popup UI: state
  panels (idle/loading/results/error), progress bar, and summary
  rendering.
- `background.js` — service worker: message routing and the Groq API call
  (streaming, JSON parsing, abort/stop support).
- `content.js` — injected on-demand via `chrome.scripting.executeScript`
  to scrape and clean the page's readable text.

## Loading the extension

1. Paste a real Groq API key into `GROQ_API_KEY` in `background.js`.
2. Open `chrome://extensions`.
3. Enable "Developer mode".
4. Click "Load unpacked" and select this repository's root folder.

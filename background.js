// PageMind background service worker (Manifest V3).
// Owns the summarization pipeline: scraping the active tab's text, then
// summarizing it with the best available engine, tried in this order so
// the extension works with **zero setup and zero API key** by default:
//   1. Chrome's built-in on-device Prompt API (Gemini Nano) — free, fully
//      local, no API key, used automatically whenever it's available
//      (Chrome 138+ on supported hardware).
//   2. A saved Groq API key, if the user has chosen to add one — used next
//      because cloud models are currently higher quality than what fits
//      on-device, but this is entirely optional.
//   3. A small open-source, instruction-tuned model from the Hugging Face
//      Hub (onnx-community/Qwen2.5-0.5B-Instruct), run fully client-side
//      via @huggingface/transformers (WebAssembly) in an offscreen
//      document. This has no hardware/browser gate beyond WebAssembly
//      support, so it's the guaranteed no-key fallback: the extension
//      never *requires* an account or credential to produce a summary.
// Every engine streams incremental text back to the popup the same way.
// Manifest V3 service workers have no XMLHttpRequest, so the Groq path
// uses the global fetch() API.

const STORAGE_KEYS = {
  API_KEY: "apiKey",
};

const MESSAGE_ACTIONS = {
  START_SUMMARY: "start_summary",
  STOP_SUMMARY: "stop_summary",
  REVISE_SUMMARY: "revise_summary",
  SUMMARY_UPDATE: "summary_update",
};

// Messages exchanged with offscreen.js, which hosts the local open-source
// model (kept separate from MESSAGE_ACTIONS since these never reach the
// popup directly).
const OFFSCREEN_ACTIONS = {
  RUN: "offscreen_run",
  STOP: "offscreen_stop",
  DONE: "offscreen_done",
  ERROR: "offscreen_error",
};

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT =
  "You are an expert summarizer. Read the following text. Output the summary using ONLY main headings, followed immediately by a short paragraph of bullet points containing the most critical information under that heading. Do not include introductory or concluding text.";

// Chrome's Prompt API (LanguageModel) currently only targets English
// input/output reliably; other cases fall back to the next engine.
const ON_DEVICE_MODEL_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

// Tracks the in-flight request so "stop_summary" can abort it: an
// AbortController for the Chrome on-device / Groq engines, or a flag
// telling us to signal the offscreen document instead (AbortController
// instances can't be sent across extension contexts). Also tracks the
// last scraped page text so "revise_summary" can re-run without
// re-injecting the content script.
let activeAbortController = null;
let activeEngine = null; // "on-device" | "cloud" | "offscreen" | null
let lastPageText = null;

// requestId -> { resolve, reject } for summaries running in the offscreen
// document, resolved/rejected when it reports back via OFFSCREEN_ACTIONS.
const pendingOffscreenRequests = new Map();

chrome.runtime.onInstalled.addListener(() => {
  console.log("PageMind installed.");
});

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.action) {
    case MESSAGE_ACTIONS.START_SUMMARY:
      handleStartSummary();
      break;
    case MESSAGE_ACTIONS.STOP_SUMMARY:
      handleStopSummary();
      break;
    case MESSAGE_ACTIONS.REVISE_SUMMARY:
      handleReviseSummary();
      break;
    case OFFSCREEN_ACTIONS.DONE:
      resolvePendingOffscreenRequest(message.requestId);
      break;
    case OFFSCREEN_ACTIONS.ERROR:
      rejectPendingOffscreenRequest(message.requestId, message.message);
      break;
    default:
      break;
  }
});

async function handleStartSummary() {
  try {
    const pageText = await scrapeActiveTabText();
    if (!pageText) {
      sendSummaryUpdate("No readable text was found on this page.");
      return;
    }

    lastPageText = pageText;
    await runSummary(pageText, { isRevision: false });
  } catch (error) {
    reportError(error);
  }
}

async function handleReviseSummary() {
  try {
    if (!lastPageText) {
      sendSummaryUpdate("Nothing to revise yet. Summarize the page first.");
      return;
    }

    await runSummary(lastPageText, { isRevision: true });
  } catch (error) {
    reportError(error);
  }
}

function handleStopSummary() {
  if (activeAbortController) {
    activeAbortController.abort();
  }
  if (activeEngine === "offscreen") {
    chrome.runtime.sendMessage({ action: OFFSCREEN_ACTIONS.STOP }).catch(() => {});
  }
}

// Picks the best available engine. In priority order:
//   1. Chrome's on-device AI, if this browser/device supports it — free,
//      no key, and doesn't even need a download if already cached.
//   2. A saved Groq API key, if the user chose to add one — optional
//      quality upgrade, never required.
//   3. The bundled open-source Hugging Face model, run locally via
//      WebAssembly — the guaranteed zero-key, zero-setup fallback.
async function runSummary(pageText, { isRevision }) {
  if (await isOnDeviceModelAvailable()) {
    sendSummaryUpdate("Summarizing with Chrome's on-device AI (no API key needed)…");
    await streamOnDeviceSummary(pageText, { isRevision });
    return;
  }

  const apiKey = await getApiKey();
  if (apiKey) {
    sendSummaryUpdate("Summarizing via the Groq cloud API…");
    await streamCloudSummary(pageText, apiKey, { isRevision });
    return;
  }

  sendSummaryUpdate(
    "Summarizing with a free, open-source AI model running locally in your browser (no API key needed)…"
  );
  await streamLocalOpenSourceSummary(pageText, { isRevision });
}

function buildUserPrompt(pageText, isRevision) {
  return isRevision
    ? `Please provide a revised, alternative summary of the following page content:\n\n${pageText}`
    : pageText;
}

async function scrapeActiveTabText() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) {
    return null;
  }

  const [injectionResult] = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    files: ["content.js"],
  });

  return injectionResult?.result ?? null;
}

async function getApiKey() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.API_KEY);
  return result[STORAGE_KEYS.API_KEY] ?? null;
}

// --- Engine 1: Chrome's built-in on-device AI (Gemini Nano) ---------------

async function isOnDeviceModelAvailable() {
  if (!("LanguageModel" in self)) {
    return false;
  }

  try {
    const availability = await LanguageModel.availability(ON_DEVICE_MODEL_OPTIONS);
    return availability !== "unavailable";
  } catch (error) {
    console.warn("PageMind: on-device availability check failed", error);
    return false;
  }
}

async function streamOnDeviceSummary(pageText, { isRevision = false } = {}) {
  const controller = new AbortController();
  activeAbortController = controller;
  activeEngine = "on-device";

  let session = null;
  try {
    session = await LanguageModel.create({
      ...ON_DEVICE_MODEL_OPTIONS,
      initialPrompts: [{ role: "system", content: SYSTEM_PROMPT }],
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          sendSummaryUpdate(
            `Downloading Chrome's on-device AI model (one-time download)… ${Math.round(event.loaded * 100)}%`
          );
        });
      },
    });

    const userPrompt = buildUserPrompt(pageText, isRevision);
    const stream = session.promptStreaming(userPrompt, { signal: controller.signal });

    let accumulatedText = "";
    for await (const chunk of stream) {
      // Defensive guard: Chrome has shipped both cumulative and delta chunk
      // semantics for promptStreaming() across versions, so handle both.
      accumulatedText = chunk.startsWith(accumulatedText) ? chunk : accumulatedText + chunk;
      sendSummaryUpdate(accumulatedText);
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }
    throw error;
  } finally {
    session?.destroy();
    if (activeAbortController === controller) {
      activeAbortController = null;
    }
    activeEngine = null;
  }
}

// --- Engine 2: Groq Chat Completions API (optional cloud upgrade) ---------

async function streamCloudSummary(pageText, apiKey, { isRevision = false } = {}) {
  const controller = new AbortController();
  activeAbortController = controller;
  activeEngine = "cloud";

  const userPrompt = buildUserPrompt(pageText, isRevision);

  try {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        stream: true,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(
        `Groq API request failed (${response.status}): ${errorBody || response.statusText}`
      );
    }

    await readStreamedCompletion(response.body);
  } catch (error) {
    if (error?.name === "AbortError") {
      return;
    }
    throw error;
  } finally {
    if (activeAbortController === controller) {
      activeAbortController = null;
    }
    activeEngine = null;
  }
}

async function readStreamedCompletion(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith("data:")) {
        continue;
      }

      const payload = trimmedLine.slice("data:".length).trim();
      if (payload === "[DONE]") {
        continue;
      }

      const delta = extractDeltaContent(payload);
      if (delta) {
        accumulatedText += delta;
        sendSummaryUpdate(accumulatedText);
      }
    }
  }
}

function extractDeltaContent(jsonPayload) {
  try {
    const parsed = JSON.parse(jsonPayload);
    return parsed?.choices?.[0]?.delta?.content ?? "";
  } catch (error) {
    console.warn("PageMind: failed to parse stream chunk", error);
    return "";
  }
}

// --- Engine 3: local open-source model (Hugging Face, offscreen/WASM) -----
//
// Runs entirely offline after the first download: no account, no API key,
// works in any Chromium browser regardless of on-device AI support. The
// heavy lifting (loading @huggingface/transformers + the ONNX WASM
// runtime, generating text) happens in offscreen.js, since a Manifest V3
// service worker can be suspended mid-task and isn't a safe place to keep
// a loaded model resident.

async function streamLocalOpenSourceSummary(pageText, { isRevision = false } = {}) {
  activeEngine = "offscreen";

  try {
    await ensureOffscreenDocument();

    const requestId = crypto.randomUUID();
    const userPrompt = buildUserPrompt(pageText, isRevision);

    await new Promise((resolve, reject) => {
      pendingOffscreenRequests.set(requestId, { resolve, reject });

      chrome.runtime
        .sendMessage({
          action: OFFSCREEN_ACTIONS.RUN,
          requestId,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt,
        })
        .catch((error) => {
          pendingOffscreenRequests.delete(requestId);
          reject(error);
        });
    });
  } finally {
    activeEngine = null;
  }
}

async function ensureOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });

    if (existingContexts.length > 0) {
      return;
    }
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["WORKERS"],
      justification:
        "Run a small open-source AI model locally (via WebAssembly) to summarize page text without any API key.",
    });
  } catch (error) {
    // Another concurrent call may have just created it; that's fine.
    if (!String(error?.message).includes("single offscreen")) {
      throw error;
    }
  }
}

function resolvePendingOffscreenRequest(requestId) {
  const pending = pendingOffscreenRequests.get(requestId);
  if (!pending) {
    return;
  }
  pendingOffscreenRequests.delete(requestId);
  pending.resolve();
}

function rejectPendingOffscreenRequest(requestId, message) {
  const pending = pendingOffscreenRequests.get(requestId);
  if (!pending) {
    return;
  }
  pendingOffscreenRequests.delete(requestId);
  pending.reject(new Error(message ?? "Local model generation failed."));
}

// --- Shared helpers ---------------------------------------------------------

function sendSummaryUpdate(text) {
  chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.SUMMARY_UPDATE, text }).catch(() => {
    // The popup may be closed; there's no one to receive the update.
  });
}

function reportError(error) {
  console.error("PageMind:", error);
  sendSummaryUpdate(`Error: ${error?.message ?? "Something went wrong."}`);
}

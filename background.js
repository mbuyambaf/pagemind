// PageMind background service worker (Manifest V3).
// Owns the summarization pipeline: scraping the active tab's text, then
// summarizing it with either
//   1. Chrome's built-in on-device Prompt API (Gemini Nano) — free, fully
//      local, no API key required, used automatically whenever it's
//      available (Chrome 138+ on supported hardware), or
//   2. the Groq Chat Completions API (OpenAI-compatible format) as a cloud
//      fallback for browsers/devices where the on-device model isn't
//      available. Groq's free tier requires an API key but no credit card.
// Either way, incremental text is pushed back to the popup as it's
// generated. Manifest V3 service workers have no XMLHttpRequest, so the
// Groq path uses the global fetch() API.

const STORAGE_KEYS = {
  API_KEY: "apiKey",
};

const MESSAGE_ACTIONS = {
  START_SUMMARY: "start_summary",
  STOP_SUMMARY: "stop_summary",
  REVISE_SUMMARY: "revise_summary",
  SUMMARY_UPDATE: "summary_update",
};

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT =
  "You are an expert summarizer. Read the following text. Output the summary using ONLY main headings, followed immediately by a short paragraph of bullet points containing the most critical information under that heading. Do not include introductory or concluding text.";

// Chrome's Prompt API (LanguageModel) currently only targets English
// input/output reliably; non-English pages will fall back to the Groq path.
const ON_DEVICE_MODEL_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

// Tracks the in-flight request (fetch or on-device prompt) so
// "stop_summary" can abort it, and the last scraped page text so
// "revise_summary" can re-run without re-injecting the content script.
let activeAbortController = null;
let lastPageText = null;

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
}

// Picks the best available engine: free/local on-device AI first, falling
// back to the Groq cloud API (requires a saved, free API key) only when
// this browser/device doesn't support the on-device model.
async function runSummary(pageText, { isRevision }) {
  if (await isOnDeviceModelAvailable()) {
    sendSummaryUpdate("Summarizing with Chrome's on-device AI (no API key needed)…");
    await streamOnDeviceSummary(pageText, { isRevision });
    return;
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    sendSummaryUpdate(
      "On-device AI isn't available in this browser (needs Chrome 138+ with sufficient RAM/VRAM). " +
        "Please save a free Groq API key in Settings to summarize via the cloud instead."
    );
    return;
  }

  sendSummaryUpdate("Summarizing via the Groq cloud API…");
  await streamCloudSummary(pageText, apiKey, { isRevision });
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
  }
}

// --- Engine 2: Groq Chat Completions API (cloud fallback) -----------------

async function streamCloudSummary(pageText, apiKey, { isRevision = false } = {}) {
  const controller = new AbortController();
  activeAbortController = controller;

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

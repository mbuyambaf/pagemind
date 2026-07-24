// PageMind background service worker (Manifest V3).
// Owns the actual summarization pipeline: scraping the active tab's text,
// calling the Groq Chat Completions API (OpenAI-compatible format) with
// streaming enabled, and pushing incremental text updates back to the
// popup. Manifest V3 service workers have no XMLHttpRequest, so this uses
// the global fetch() API throughout.

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

// Tracks the fetch() currently streaming a summary so "stop_summary" can
// abort it, and the last scraped page text so "revise_summary" can re-run
// without re-injecting the content script.
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

    const apiKey = await getApiKey();
    if (!apiKey) {
      sendSummaryUpdate("Please save your API key in Settings before summarizing.");
      return;
    }

    await streamSummary(pageText, apiKey);
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

    const apiKey = await getApiKey();
    if (!apiKey) {
      sendSummaryUpdate("Please save your API key in Settings before summarizing.");
      return;
    }

    await streamSummary(lastPageText, apiKey, { isRevision: true });
  } catch (error) {
    reportError(error);
  }
}

function handleStopSummary() {
  if (activeAbortController) {
    activeAbortController.abort();
  }
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

async function streamSummary(pageText, apiKey, { isRevision = false } = {}) {
  const controller = new AbortController();
  activeAbortController = controller;

  const userPrompt = isRevision
    ? `Please provide a revised, alternative summary of the following page content:\n\n${pageText}`
    : pageText;

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

function sendSummaryUpdate(text) {
  chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.SUMMARY_UPDATE, text }).catch(() => {
    // The popup may be closed; there's no one to receive the update.
  });
}

function reportError(error) {
  console.error("PageMind:", error);
  sendSummaryUpdate(`Error: ${error?.message ?? "Something went wrong."}`);
}

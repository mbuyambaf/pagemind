// PageMind popup script.
// Handles the Settings section (API key + on/off persistence) and wires up
// message passing with the background service worker for the summarization
// actions. The background worker owns the actual summarization logic.

const STORAGE_KEYS = {
  API_KEY: "apiKey",
  EXTENSION_ENABLED: "extensionEnabled",
};

const MESSAGE_ACTIONS = {
  START_SUMMARY: "start_summary",
  STOP_SUMMARY: "stop_summary",
  REVISE_SUMMARY: "revise_summary",
  SUMMARY_UPDATE: "summary_update",
};

document.addEventListener("DOMContentLoaded", () => {
  const extensionToggle = document.getElementById("extension-toggle");
  const apiKeyInput = document.getElementById("api-key-input");
  const saveKeyBtn = document.getElementById("save-key-btn");
  const summarizeBtn = document.getElementById("summarize-btn");
  const stopBtn = document.getElementById("stop-btn");
  const reviseBtn = document.getElementById("revise-btn");
  const output = document.getElementById("output");

  let saveConfirmationTimeout = null;

  restoreState();

  extensionToggle.addEventListener("change", () => {
    const isEnabled = extensionToggle.checked;
    chrome.storage.local.set({ [STORAGE_KEYS.EXTENSION_ENABLED]: isEnabled });
    updateSummarizeAvailability(isEnabled);
  });

  saveKeyBtn.addEventListener("click", () => {
    const apiKey = apiKeyInput.value.trim();
    chrome.storage.local.set({ [STORAGE_KEYS.API_KEY]: apiKey }, () => {
      showSaveConfirmation();
    });
  });

  summarizeBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.START_SUMMARY });
  });

  stopBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.STOP_SUMMARY });
  });

  reviseBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.REVISE_SUMMARY });
  });

  // Receives text updates streamed/pushed from the background service
  // worker (e.g. summary progress or the final result) and renders them.
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.action === MESSAGE_ACTIONS.SUMMARY_UPDATE) {
      renderSummaryText(message.text ?? "");
    }
  });

  function restoreState() {
    chrome.storage.local.get(
      [STORAGE_KEYS.API_KEY, STORAGE_KEYS.EXTENSION_ENABLED],
      (result) => {
        if (result[STORAGE_KEYS.API_KEY]) {
          apiKeyInput.value = result[STORAGE_KEYS.API_KEY];
        }

        // Default to "on" the first time the extension runs, i.e. before
        // any value has ever been saved to storage.
        const isEnabled = result[STORAGE_KEYS.EXTENSION_ENABLED] !== false;
        extensionToggle.checked = isEnabled;
        updateSummarizeAvailability(isEnabled);
      }
    );
  }

  function updateSummarizeAvailability(isEnabled) {
    summarizeBtn.disabled = !isEnabled;
  }

  function renderSummaryText(text) {
    output.textContent = text;
  }

  function showSaveConfirmation() {
    const originalLabel = "Save Key";
    saveKeyBtn.textContent = "Saved!";
    clearTimeout(saveConfirmationTimeout);
    saveConfirmationTimeout = setTimeout(() => {
      saveKeyBtn.textContent = originalLabel;
    }, 1200);
  }
});

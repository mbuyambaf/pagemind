// PageMind popup script.
// Wires up UI event listeners. Core logic (API calls, messaging with the
// background service worker/content scripts, storage reads/writes, etc.)
// is intentionally left empty for now and will be implemented later.

document.addEventListener("DOMContentLoaded", () => {
  const extensionToggle = document.getElementById("extension-toggle");
  const apiKeyInput = document.getElementById("api-key-input");
  const saveKeyBtn = document.getElementById("save-key-btn");
  const summarizeBtn = document.getElementById("summarize-btn");
  const stopBtn = document.getElementById("stop-btn");
  const reviseBtn = document.getElementById("revise-btn");
  const output = document.getElementById("output");

  extensionToggle.addEventListener("change", () => {
    // TODO: persist on/off state and enable/disable extension behavior.
  });

  saveKeyBtn.addEventListener("click", () => {
    // TODO: validate and save apiKeyInput.value to chrome.storage.
  });

  summarizeBtn.addEventListener("click", () => {
    // TODO: trigger page summarization and render result into `output`.
  });

  stopBtn.addEventListener("click", () => {
    // TODO: stop an in-progress summarization request.
  });

  reviseBtn.addEventListener("click", () => {
    // TODO: request a revised summary based on the current output.
  });
});

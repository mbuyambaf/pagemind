// PageMind background service worker (Manifest V3).
// Routes messages from the popup. The actual summarization logic (page
// content extraction, API calls, streaming results back to the popup) is
// intentionally left as TODOs for now.

const MESSAGE_ACTIONS = {
  START_SUMMARY: "start_summary",
  STOP_SUMMARY: "stop_summary",
  REVISE_SUMMARY: "revise_summary",
  SUMMARY_UPDATE: "summary_update",
};

chrome.runtime.onInstalled.addListener(() => {
  console.log("PageMind installed.");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.action) {
    case MESSAGE_ACTIONS.START_SUMMARY:
      // TODO: read the active tab's content (via scripting/activeTab),
      // call the summarization API with the saved key, and push progress
      // back to the popup with { action: MESSAGE_ACTIONS.SUMMARY_UPDATE, text }.
      break;
    case MESSAGE_ACTIONS.STOP_SUMMARY:
      // TODO: abort any in-flight summarization request.
      break;
    case MESSAGE_ACTIONS.REVISE_SUMMARY:
      // TODO: request a revised summary from the API and stream it back.
      break;
    default:
      break;
  }
});

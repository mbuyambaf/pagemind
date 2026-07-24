// PageMind background service worker (Manifest V3).
// Core logic (message routing, API calls, etc.) will be added here later.

chrome.runtime.onInstalled.addListener(() => {
  console.log("PageMind installed.");
});

// PageMind background service worker (skeleton — no logic yet).

const GROQ_API_KEY = 'PASTE_YOUR_KEY_HERE';
const MODEL = 'llama-3.3-70b-versatile';

function extractAndSummarize(tabId, sendResponse) {
  console.log('extractAndSummarize', tabId, sendResponse);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(message?.action);
});

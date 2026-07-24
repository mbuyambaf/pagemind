// PageMind content script.
// Injected on-demand (via chrome.scripting.executeScript) to extract the
// main readable text from the page. Runs against a detached clone of
// <body> so the live page is never modified, and strips out <script>,
// <nav>, and <footer> elements before reading the text out. The value of
// this expression becomes the injection's result, which the background
// service worker reads back.

(function extractPageText() {
  const bodyClone = document.body.cloneNode(true);

  bodyClone.querySelectorAll("script, nav, footer").forEach((element) => {
    element.remove();
  });

  const rawText = bodyClone.textContent || "";

  return rawText.replace(/\s+/g, " ").trim();
})();

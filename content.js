// Injected by background.js to extract page text.
// Returns a cleaned string of the page's readable text, or null if too
// little readable content was found.

(function extractPageText() {
  const CONTENT_SELECTORS = [
    'article',
    'main',
    '[role="main"]',
    '.post-content',
    '.article-body',
    '.entry-content',
    '#content',
  ];

  const REMOVE_SELECTOR =
    'nav, header, footer, aside, .sidebar, script, style, noscript, ' +
    '[aria-hidden="true"], [class*="ad-"], [class*="advertisement"]';

  const MIN_LINE_LENGTH = 25;
  const MIN_RESULT_LENGTH = 200;
  const MAX_RESULT_LENGTH = 12000;

  let sourceElement = null;
  for (const selector of CONTENT_SELECTORS) {
    sourceElement = document.querySelector(selector);
    if (sourceElement) {
      break;
    }
  }
  if (!sourceElement) {
    sourceElement = document.body;
  }

  const clone = sourceElement.cloneNode(true);
  clone.querySelectorAll(REMOVE_SELECTOR).forEach((element) => element.remove());

  const rawText = clone.innerText || clone.textContent || '';

  const cleanedText = rawText
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= MIN_LINE_LENGTH)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RESULT_LENGTH);

  if (cleanedText.length < MIN_RESULT_LENGTH) {
    return null;
  }

  return cleanedText;
})();

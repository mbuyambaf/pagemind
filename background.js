// PageMind background service worker (Manifest V3).
// The API key is hardcoded below — there is no user-facing settings UI.

const GROQ_API_KEY = 'PASTE_YOUR_KEY_HERE';
const MODEL = 'llama-3.3-70b-versatile';
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `You are a precise summarizer. Read the provided text carefully.
Return ONLY a valid JSON array — no markdown, no code fences,
no explanation, nothing else before or after the array.
Each element must have exactly two keys:
  "heading": a short, specific, descriptive string
  "bullet_points": an array of concise factual strings
Rules:
  - 3 to 5 sections maximum
  - 2 to 4 bullet points per section
  - Headings must be specific, not generic (not 'Overview' or 'Summary')
  - Bullets must be facts from the text, not paraphrased vagueness
  - Do not invent information not present in the source text`;

// Tracks the in-flight Groq request so 'stop_summary' can abort it.
let activeController = null;

chrome.runtime.onMessage.addListener((message) => {
  switch (message?.action) {
    case 'start_summary':
      handleStartSummary(message);
      break;
    case 'stop_summary':
      handleStopSummary();
      break;
    default:
      break;
  }
});

async function handleStartSummary(message) {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }

  let pageText;
  try {
    const [injectionResult] = await chrome.scripting.executeScript({
      target: { tabId: message.tabId },
      files: ['content.js'],
    });
    pageText = injectionResult?.result;
  } catch (error) {
    notifyPopup({
      type: 'summary_error',
      message: 'Could not read this page. Try a different tab.',
    });
    return;
  }

  if (!pageText) {
    notifyPopup({
      type: 'summary_error',
      message: 'Not enough readable content on this page.',
    });
    return;
  }

  const controller = new AbortController();
  activeController = controller;

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        temperature: 0.2,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: pageText },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Groq API request failed (${response.status})`);
    }

    const buffer = await readStreamedContent(response.body);

    try {
      const parsed = JSON.parse(buffer);
      notifyPopup({ type: 'summary_complete', summary: parsed });
    } catch (parseError) {
      notifyPopup({
        type: 'summary_error',
        message: 'The AI returned an unexpected format. Try again.',
      });
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      notifyPopup({
        type: 'summary_error',
        message: 'Something went wrong while summarizing. Try again.',
      });
    }
  } finally {
    activeController = null;
  }
}

function handleStopSummary() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

async function readStreamedContent(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let leftover = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    leftover += decoder.decode(value, { stream: true });
    const lines = leftover.split('\n');
    leftover = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }

      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        continue;
      }

      try {
        const parsedChunk = JSON.parse(payload);
        const delta = parsedChunk?.choices?.[0]?.delta?.content;
        if (delta) {
          buffer += delta;
        }
      } catch (error) {
        // Ignore malformed SSE chunks; keep reading.
      }
    }
  }

  return buffer;
}

// Uses chrome.runtime.sendMessage (not sendResponse) since the popup's
// message channel from the original 'start_summary' dispatch closes long
// before streaming finishes; popup.js listens for these via its own
// chrome.runtime.onMessage handler.
function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // The popup may be closed; there's no one to receive the update.
  });
}

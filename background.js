// PageMind background service worker (Manifest V3).
// The API key is hardcoded below — there is no user-facing settings UI.

const GROQ_API_KEY = 'PASTE_YOUR_KEY_HERE';
const MODEL = 'llama-3.3-70b-versatile';
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `You are an expert summarizer who reasons from first principles: before
writing anything, identify the fundamental ideas in the text — the core
subject, the underlying causes/mechanisms/motivations, and how the
supporting facts connect back to them — rather than skimming for
standalone phrases or repeating surface-level wording from the source.

Step 1 — Classify the page into exactly one of these types based on its
content:
  "job_board": a listing of multiple job openings (careers page, job search site)
  "job_posting": a single specific job listing/description
  "social_media": a social media profile, feed, or individual post
  "ecommerce": a product page, category/listing page, or shopping site
  "landing_page": a marketing/sales page promoting a product, service, or sign-up
  "article": a news article, blog post, documentation, or other long-form written content
  "other": anything that doesn't clearly fit the above

Step 2 — Tailor what the sections cover to that page type:
  - job_board: the categories/types of roles available, notable
    companies or departments, common requirements or seniority levels,
    and how to narrow down the listings (locations, remote options, etc.)
  - job_posting: a brief overview of the role — what the job involves,
    key responsibilities, required qualifications, and
    compensation/location/company details if present
  - social_media: who/what the account or post is about, the main
    themes or topics covered, and any especially notable content,
    claims, or engagement
  - ecommerce: prices, price comparisons or deals, key differences
    between products/options, and practical shopping tips (shipping,
    return policy, ratings, etc.)
  - landing_page: the core value proposition/offer, pricing or
    promotions, and other useful insights a visitor would want before
    deciding whether to sign up or buy
  - article / other: a general, first-principles summary of the content
    and why it matters

Whatever the page type, your goal is comprehension, not compression: a
person who reads ONLY your summary (title, section descriptions, and
bullet points), without ever reading the original page, should come away
with a genuine, general understanding of what the page is about, why it
matters, and how its parts fit together — not just a pile of disconnected
facts.

Step 3 — Infer the visitor's likely intent for being on this page (for
example: deciding whether to apply for this job, comparing this product
before buying, evaluating this profile or account, deciding whether to
sign up, or just researching/browsing the topic). Then, reasoning as a
domain expert from first principles, surface 2 to 4 practical
considerations that would genuinely help someone with that intent —
grounded in the fundamentals of this kind of decision (e.g. what actually
separates a good option from a bad one here), and specific to what this
particular page's content reveals (strengths, gaps, red flags, or
questions worth asking) — not generic platitudes like "do your research"
or "read the fine print".

Read the provided text carefully, then return ONLY a valid JSON object —
no markdown, no code fences, no explanation, nothing else before or
after the object.
The object must have exactly five keys:
  "page_type": one of "job_board", "job_posting", "social_media", "ecommerce", "landing_page", "article", "other"
  "visitor_intent": a short phrase (roughly 4 to 10 words) describing why someone is likely visiting this page
  "title": a short, specific title (roughly 4 to 8 words) naming the overall topic of the text
  "sections": an array of section objects, covering what's described for that page_type in Step 2
  "expert_considerations": an array of 2 to 4 concise, first-principles considerations tailored to the visitor_intent, as described in Step 3
Each section object must have exactly three keys:
  "heading": a short, specific, descriptive string
  "description": one concise sentence explaining the core idea of this section and why it's relevant to the overall topic
  "bullet_points": an array of concise factual strings
Rules:
  - 3 to 5 sections maximum
  - 2 to 4 bullet points per section
  - Break ideas down to their fundamental "what" and "why", not just a
    restatement of sentences from the source text
  - The title must be specific, not generic (not 'Summary' or 'Article Overview')
  - Headings must be specific, not generic (not 'Overview' or 'Summary')
  - Each description must be a single sentence and must not just restate the heading
  - Bullets must be facts from the text, not paraphrased vagueness
  - expert_considerations must be genuinely useful and specific to this
    page and the inferred visitor_intent, reflecting fundamental
    first-principles thinking about the underlying decision — never
    generic advice that could apply to any page
  - Taken together, the title, descriptions, and bullets must form a
    coherent narrative appropriate to the page_type: someone reading
    only the summary should understand the main topic, its context, and
    why it matters
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
        max_tokens: 2048,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: pageText },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(describeApiError(response.status, errorBody));
    }

    const { buffer, finishReason } = await readStreamedContent(response.body);

    try {
      const parsed = JSON.parse(sanitizeJsonBuffer(buffer));
      notifyPopup({ type: 'summary_complete', summary: parsed });
    } catch (parseError) {
      console.error('PageMind: failed to parse Groq response as JSON', parseError, { finishReason, buffer });
      const message =
        finishReason === 'length'
          ? 'The summary was cut off before finishing (response too long). Try again, or shorten the page.'
          : 'The AI returned an unexpected format. Try again.';
      notifyPopup({ type: 'summary_error', message });
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error('PageMind: summarization failed', error);
      notifyPopup({
        type: 'summary_error',
        message: error?.message || 'Something went wrong while summarizing. Try again.',
      });
    }
  } finally {
    activeController = null;
  }
}

function describeApiError(status, errorBody) {
  if (status === 401 || status === 403) {
    return 'Groq rejected the API key (401/403). Paste a valid key into GROQ_API_KEY in background.js.';
  }
  if (status === 429) {
    return 'Groq rate limit hit (429). Wait a moment and try again.';
  }

  let detail = errorBody;
  try {
    const parsed = JSON.parse(errorBody);
    detail = parsed?.error?.message || errorBody;
  } catch {
    // errorBody wasn't JSON; use it as-is.
  }

  return `Groq API request failed (${status}): ${detail || 'no further details.'}`;
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
  let finishReason = null;

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
        const choice = parsedChunk?.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          buffer += delta;
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
      } catch (error) {
        // Ignore malformed SSE chunks; keep reading.
      }
    }
  }

  return { buffer, finishReason };
}

// response_format: { type: 'json_object' } is a best-effort constraint on
// Groq's side, not a hard guarantee — this defensively strips markdown
// code fences (in case the model wraps the JSON despite instructions not
// to) and, if there's still leading/trailing prose, falls back to the
// first top-level {...} block found in the text.
function sanitizeJsonBuffer(rawBuffer) {
  let text = rawBuffer.trim();

  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  if (!text.startsWith('{')) {
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      text = objectMatch[0];
    }
  }

  return text;
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

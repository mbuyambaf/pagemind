// PageMind popup script.
// Owns all popup-side UI logic: state-panel transitions, the fake progress
// bar animation shown while a summary is generating, rendering the
// completed summary, and wiring buttons to messages sent to/received from
// the background service worker. All DOM lookups are defensive
// (optional-chained / null-checked) so this degrades gracefully if an
// expected element isn't present.

const STATES = ['idle', 'loading', 'results', 'error'];
const SECTION_COLORS = ['#6B65D4', '#1B9B6F', '#C47F18', '#5A9020'];

// Human-readable labels for the page_type background.js classifies the
// page as, shown as a small badge above the summary title.
const PAGE_TYPE_LABELS = {
  job_board: 'Job Board',
  job_posting: 'Job Posting',
  social_media: 'Social Media',
  ecommerce: 'Shopping',
  landing_page: 'Landing Page',
  article: 'Article',
  other: 'Web Page',
};

// URL schemes extensions can never read, regardless of permissions granted.
const RESTRICTED_URL_PREFIXES = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'devtools://', 'view-source:'];

const PROGRESS_START_PERCENT = 12;
const PROGRESS_MAX_PERCENT = 85;
const PROGRESS_TICK_MS = 280;
const COPY_RESET_MS = 2000;
const RESULTS_REVEAL_DELAY_MS = 350;

let progressIntervalId = null;
let copyResetTimeoutId = null;

// --- State panels -----------------------------------------------------------

function showState(name) {
  STATES.forEach((state) => {
    const panel = document.getElementById(`state-${state}`);
    if (!panel) {
      return;
    }

    if (state !== name) {
      panel.style.display = 'none';
      panel.classList.remove('active');
      return;
    }

    panel.style.display = 'block';
    // Re-trigger the fade-up animation even if this panel was already
    // shown before: remove the class, force a reflow, then add it back.
    panel.classList.remove('active');
    void panel.offsetHeight;
    panel.classList.add('active');
  });
}

// --- URL bar ------------------------------------------------------------

function renderUrlBar(rawUrl) {
  const urlTextEl = document.getElementById('url-text');
  if (!urlTextEl) {
    return;
  }

  try {
    const parsed = new URL(rawUrl);
    urlTextEl.textContent = `${parsed.hostname}${parsed.pathname.slice(0, 35)}`;
  } catch {
    urlTextEl.textContent = 'Current page';
  }
}

// --- Summary rendering ----------------------------------------------------

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderSummary(summary) {
  // Accepts the current { page_type, visitor_intent, title, sections,
  // expert_considerations } shape from background.js, but falls back to
  // treating `summary` itself as the sections array in case an
  // older-format response ever comes through.
  const isPlainArray = Array.isArray(summary);
  const title = isPlainArray ? '' : summary?.title ?? '';
  const pageType = isPlainArray ? '' : summary?.page_type ?? '';
  const visitorIntent = isPlainArray ? '' : summary?.visitor_intent ?? '';
  const expertConsiderations = isPlainArray
    ? []
    : Array.isArray(summary?.expert_considerations)
      ? summary.expert_considerations
      : [];
  const sections = isPlainArray ? summary : Array.isArray(summary?.sections) ? summary.sections : [];

  const badgeEl = document.getElementById('page-type-badge');
  if (badgeEl) {
    const label = PAGE_TYPE_LABELS[pageType];
    badgeEl.textContent = label ?? '';
    badgeEl.style.display = label ? '' : 'none';
  }

  const titleEl = document.getElementById('summary-title');
  if (titleEl) {
    titleEl.textContent = title;
    titleEl.style.display = title ? '' : 'none';
  }

  const metaEl = document.getElementById('summary-meta');
  const sectionsEl = document.getElementById('summary-sections');

  const pointCount = sections.reduce((total, section) => total + (section.bullet_points?.length ?? 0), 0);
  if (metaEl) {
    metaEl.textContent = `${sections.length} sections · ${pointCount} points`;
  }

  if (!sectionsEl) {
    return;
  }

  sectionsEl.innerHTML = '';

  sections.forEach((section, index) => {
    const color = SECTION_COLORS[index % SECTION_COLORS.length];

    const sectionEl = document.createElement('div');
    sectionEl.className = 'summ-sec';
    if (index < sections.length - 1) {
      sectionEl.style.borderBottom = '1px solid var(--border)';
    }

    const headEl = document.createElement('div');
    headEl.className = 'sec-head';
    headEl.innerHTML =
      `<span class="sec-bar" style="background-color: ${color};"></span>` +
      `<span class="sec-heading">${escapeHtml(section.heading ?? '')}</span>`;
    sectionEl.appendChild(headEl);

    if (section.description) {
      const descEl = document.createElement('p');
      descEl.className = 'sec-desc';
      descEl.textContent = section.description;
      sectionEl.appendChild(descEl);
    }

    const listEl = document.createElement('ul');
    listEl.className = 'pts';
    (section.bullet_points ?? []).forEach((point) => {
      const itemEl = document.createElement('li');
      itemEl.innerHTML =
        `<span class="pt-bullet" style="color: ${color};">▸</span>` +
        `<span class="pt-text">${escapeHtml(point)}</span>`;
      listEl.appendChild(itemEl);
    });
    sectionEl.appendChild(listEl);

    sectionsEl.appendChild(sectionEl);
  });

  if (expertConsiderations.length > 0) {
    sectionsEl.appendChild(buildExpertConsiderationsBlock(visitorIntent, expertConsiderations));
  }
}

// Renders the "why you're likely here" + first-principles expert advice
// as a visually distinct block appended after the regular sections,
// inside the same scrollable #summary-sections container (so it shares
// that container's height budget instead of needing its own).
function buildExpertConsiderationsBlock(visitorIntent, considerations) {
  const blockEl = document.createElement('div');
  blockEl.className = 'expert-block';

  const headEl = document.createElement('div');
  headEl.className = 'expert-head';
  headEl.innerHTML =
    '<span class="expert-icon">💡</span>' +
    '<span class="expert-heading">Expert Considerations</span>';
  blockEl.appendChild(headEl);

  if (visitorIntent) {
    const intentEl = document.createElement('p');
    intentEl.className = 'expert-intent';
    intentEl.innerHTML = `Likely here to: <span class="expert-intent-text">${escapeHtml(visitorIntent)}</span>`;
    blockEl.appendChild(intentEl);
  }

  const listEl = document.createElement('ul');
  listEl.className = 'expert-list';
  considerations.forEach((consideration) => {
    const itemEl = document.createElement('li');
    itemEl.innerHTML =
      '<span class="expert-bullet">✓</span>' +
      `<span class="expert-text">${escapeHtml(consideration)}</span>`;
    listEl.appendChild(itemEl);
  });
  blockEl.appendChild(listEl);

  return blockEl;
}

function showError(message) {
  const errorEl = document.getElementById('error-message');
  if (errorEl) {
    errorEl.textContent = message;
  }
  showState('error');
}

function buildPlainText() {
  const sectionsEl = document.getElementById('summary-sections');
  if (!sectionsEl) {
    return '';
  }

  const blocks = [];

  const badgeText = document.getElementById('page-type-badge')?.textContent?.trim();
  const titleText = document.getElementById('summary-title')?.textContent?.trim();
  if (titleText) {
    blocks.push(badgeText ? `${titleText} [${badgeText}]` : titleText);
  }

  sectionsEl.querySelectorAll('.summ-sec').forEach((sectionEl) => {
    const lines = [];

    const headingEl = sectionEl.querySelector('.sec-heading');
    if (headingEl) {
      lines.push(headingEl.textContent ?? '');
    }

    const descEl = sectionEl.querySelector('.sec-desc');
    if (descEl?.textContent) {
      lines.push(descEl.textContent);
    }

    sectionEl.querySelectorAll('.pt-text').forEach((pointEl) => {
      lines.push(`  • ${pointEl.textContent ?? ''}`);
    });

    blocks.push(lines.join('\n'));
  });

  const expertBlockEl = sectionsEl.querySelector('.expert-block');
  if (expertBlockEl) {
    const lines = ['Expert Considerations'];

    const intentText = expertBlockEl.querySelector('.expert-intent-text')?.textContent;
    if (intentText) {
      lines.push(`Likely here to: ${intentText}`);
    }

    expertBlockEl.querySelectorAll('.expert-text').forEach((el) => {
      lines.push(`  ✓ ${el.textContent ?? ''}`);
    });

    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

// --- Progress bar ---------------------------------------------------------

function setProgressUI(percent) {
  const fillEl = document.getElementById('progress-fill');
  const pctEl = document.getElementById('progress-pct');
  if (fillEl) {
    fillEl.style.width = `${percent}%`;
  }
  if (pctEl) {
    pctEl.textContent = `${percent}%`;
  }
}

function clearProgressInterval() {
  if (progressIntervalId !== null) {
    clearInterval(progressIntervalId);
    progressIntervalId = null;
  }
}

function startProgress() {
  clearProgressInterval();

  let percent = PROGRESS_START_PERCENT;
  setProgressUI(percent);

  progressIntervalId = setInterval(() => {
    const increment = 3 + Math.floor(Math.random() * 8);
    percent = Math.min(PROGRESS_MAX_PERCENT, percent + increment);
    setProgressUI(percent);

    if (percent >= PROGRESS_MAX_PERCENT) {
      clearProgressInterval();
    }
  }, PROGRESS_TICK_MS);
}

function completeProgress() {
  clearProgressInterval();
  setProgressUI(100);
}

function resetProgress() {
  clearProgressInterval();
  setProgressUI(0);
}

// --- Helpers ----------------------------------------------------------------

function isRestrictedUrl(url) {
  return typeof url === 'string' && RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function getActiveTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => callback(tab));
}

// --- Button wiring ----------------------------------------------------------

document.getElementById('summarize-btn')?.addEventListener('click', () => {
  getActiveTab((tab) => {
    if (!tab?.url || isRestrictedUrl(tab.url)) {
      showError("PageMind can't read this page. Try it on a regular website instead.");
      return;
    }

    renderUrlBar(tab.url);
    showState('loading');
    resetProgress();
    startProgress();

    chrome.runtime.sendMessage({ action: 'start_summary', tabId: tab.id, url: tab.url });
  });
});

document.getElementById('stop-btn')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stop_summary' });
  completeProgress();
  resetProgress();
  showState('idle');
});

document.getElementById('revise-btn')?.addEventListener('click', () => {
  getActiveTab((tab) => {
    chrome.runtime.sendMessage({ action: 'start_summary', tabId: tab?.id, url: tab?.url });
    showState('loading');
    resetProgress();
    startProgress();
  });
});

document.getElementById('copy-btn')?.addEventListener('click', () => {
  const copyBtn = document.getElementById('copy-btn');
  const text = buildPlainText();

  navigator.clipboard
    .writeText(text)
    .then(() => {
      if (!copyBtn) {
        return;
      }

      const iconSlot = copyBtn.querySelector('.btn-icon-slot');
      const label = copyBtn.querySelector('.btn-label');
      const previousIconClassName = iconSlot?.className;
      const previousLabelText = label?.textContent;

      copyBtn.classList.add('copied');
      if (iconSlot) {
        iconSlot.className = 'btn-icon-slot ico-check';
      }
      if (label) {
        label.textContent = 'Copied';
      }

      clearTimeout(copyResetTimeoutId);
      copyResetTimeoutId = setTimeout(() => {
        copyBtn.classList.remove('copied');
        if (iconSlot && previousIconClassName !== undefined) {
          iconSlot.className = previousIconClassName;
        }
        if (label && previousLabelText !== undefined) {
          label.textContent = previousLabelText;
        }
      }, COPY_RESET_MS);
    })
    .catch((error) => {
      console.error('PageMind: failed to copy summary', error);
    });
});

document.getElementById('reset-btn')?.addEventListener('click', () => {
  showState('idle');
});

document.getElementById('retry-btn')?.addEventListener('click', () => {
  showState('idle');
});

// --- Messages from background.js -------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
  if (!message) {
    return;
  }

  if (message.type === 'summary_complete') {
    completeProgress();
    setTimeout(() => {
      renderSummary(message.summary);
      showState('results');
    }, RESULTS_REVEAL_DELAY_MS);
  } else if (message.type === 'summary_error') {
    completeProgress();
    resetProgress();
    showError(message.message);
  }
});

// --- Init ---------------------------------------------------------------

function init() {
  getActiveTab((tab) => {
    renderUrlBar(tab?.url ?? '');
    showState('idle');
  });
}

init();

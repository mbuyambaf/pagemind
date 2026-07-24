// PageMind popup script (skeleton — no logic yet).

const STATES = ['idle', 'loading', 'results', 'error'];
const SECTION_COLORS = ['#6B65D4', '#1B9B6F', '#C47F18', '#5A9020'];

function showState(name) {
  console.log('showState', name);
}

function renderSummary(summary) {
  console.log('renderSummary', summary);
}

function renderUrlBar(rawUrl) {
  console.log('renderUrlBar', rawUrl);
}

function showError(message) {
  console.log('showError', message);
}

function buildPlainText() {
  console.log('buildPlainText');
}

document.getElementById('summarize-btn')?.addEventListener('click', () => {});
document.getElementById('stop-btn')?.addEventListener('click', () => {});
document.getElementById('revise-btn')?.addEventListener('click', () => {});
document.getElementById('copy-btn')?.addEventListener('click', () => {});
document.getElementById('reset-btn')?.addEventListener('click', () => {});
document.getElementById('retry-btn')?.addEventListener('click', () => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('onMessage', message);
});

function init() {
  console.log('init');
}

init();

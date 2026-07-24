// PageMind offscreen document script.
// Hosts a small open-source, instruction-tuned language model
// (onnx-community/Qwen2.5-0.5B-Instruct) fully client-side via
// @huggingface/transformers (WebAssembly backend), so summarization works
// out of the box with zero API key, zero account, and zero backend.
// The model weights are fetched once from the Hugging Face Hub and cached
// by the browser; only the (bundled, local) runtime code ships with the
// extension, per Manifest V3's "no remotely hosted code" requirement.

import {
  pipeline,
  env,
  TextStreamer,
  InterruptableStoppingCriteria,
} from "./vendor/transformers.js";

// Load the WASM backend from our bundled copy instead of a remote CDN.
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
// Avoid requiring cross-origin isolation (SharedArrayBuffer) for threading;
// a small model runs acceptably single-threaded.
env.backends.onnx.wasm.numThreads = 1;

const MODEL_ID = "onnx-community/Qwen2.5-0.5B-Instruct";
const MODEL_DTYPE = "q4";
const MAX_NEW_TOKENS = 512;

const OFFSCREEN_ACTIONS = {
  RUN: "offscreen_run",
  STOP: "offscreen_stop",
  DONE: "offscreen_done",
  ERROR: "offscreen_error",
};

const SUMMARY_UPDATE_ACTION = "summary_update";

let generatorPromise = null;
let activeStoppingCriteria = null;

function getGenerator() {
  generatorPromise ??= pipeline("text-generation", MODEL_ID, {
    dtype: MODEL_DTYPE,
    progress_callback: (progress) => {
      if (progress?.status === "progress" && typeof progress.progress === "number") {
        sendSummaryUpdate(
          `Downloading local open-source AI model (one-time, ~400MB, then works offline)… ${Math.round(
            progress.progress
          )}%`
        );
      } else if (progress?.status === "ready") {
        sendSummaryUpdate("Local AI model ready. Generating summary…");
      }
    },
  });
  return generatorPromise;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === OFFSCREEN_ACTIONS.RUN) {
    handleRun(message);
  } else if (message?.action === OFFSCREEN_ACTIONS.STOP) {
    activeStoppingCriteria?.interrupt();
  }
});

async function handleRun({ requestId, systemPrompt, userPrompt }) {
  try {
    sendSummaryUpdate("Loading local open-source AI model…");
    const generator = await getGenerator();

    const stoppingCriteria = new InterruptableStoppingCriteria();
    activeStoppingCriteria = stoppingCriteria;

    let accumulatedText = "";
    const streamer = new TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunk) => {
        accumulatedText += chunk;
        sendSummaryUpdate(accumulatedText);
      },
    });

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    await generator(messages, {
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: false,
      streamer,
      stopping_criteria: stoppingCriteria,
    });

    notifyBackground({ action: OFFSCREEN_ACTIONS.DONE, requestId });
  } catch (error) {
    notifyBackground({
      action: OFFSCREEN_ACTIONS.ERROR,
      requestId,
      message: error?.message ?? "Local model generation failed.",
    });
  } finally {
    activeStoppingCriteria = null;
  }
}

function sendSummaryUpdate(text) {
  chrome.runtime.sendMessage({ action: SUMMARY_UPDATE_ACTION, text }).catch(() => {
    // The popup may be closed; there's no one to receive the update.
  });
}

function notifyBackground(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // The background service worker may have been briefly suspended and
    // restarted; nothing to do if it isn't listening right now.
  });
}

/* global chrome, document, location, MutationObserver */
// The foreign fixture's content script: after ?delay= milliseconds, two
// frames of THIS extension go into the page, the way a password manager's
// inline menu does. How many of them are in the document is published on
// <html data-foreign-frames>, which the test reads over its own DevTools
// socket — the closed shadow root is otherwise invisible to it.
const delay = Number(new URLSearchParams(location.search).get("delay") || 0);
setTimeout(() => {
  const url = chrome.runtime.getURL("frame.html");
  const plain = document.createElement("iframe");
  plain.src = url;
  document.body.appendChild(plain);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "closed" });
  const hidden = document.createElement("iframe");
  hidden.src = url;
  shadow.appendChild(hidden);
  // A frame counts once it has LOADED: before that its document is still
  // about:blank, and Chrome has nothing of this extension's to refuse over.
  const loaded = new Set();
  const publish = () => {
    for (const f of frames) if (!f.isConnected) loaded.delete(f);
    document.documentElement.dataset.foreignFrames = String(loaded.size);
  };
  const frames = [plain, hidden];
  for (const f of frames)
    f.addEventListener("load", () => {
      loaded.add(f);
      publish();
    });
  publish();
  // Not a timer: a background tab's timers are throttled to one a second.
  const watch = new MutationObserver(publish);
  watch.observe(document.body, { childList: true });
  watch.observe(shadow, { childList: true });
}, delay);

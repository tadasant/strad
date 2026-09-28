/* global chrome, document */
const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime
    .sendMessage({ type: "status" })
    .catch(() => null);
  const box = $("status");
  if (!s) {
    box.className = "error";
    box.textContent = "the extension's service worker did not answer";
    return;
  }
  box.className = s.state;
  const attached = s.attached.length
    ? ` · attached to ${s.attached.length} tab${s.attached.length === 1 ? "" : "s"}`
    : "";
  box.textContent = `${s.state}${s.detail ? `: ${s.detail}` : ""}${attached} · extension id ${s.extensionId} · v${s.version}`;
  if (s.managed) {
    $("managed").hidden = false;
    $("daemon").disabled = true;
    $("token").disabled = true;
    $("save").disabled = true;
  }
}

async function load() {
  const local = await chrome.storage.local.get(["daemon", "token"]);
  $("daemon").value = local.daemon ?? "";
  $("token").value = local.token ?? "";
  await refresh();
}

$("save").addEventListener("click", async () => {
  const daemon = $("daemon").value.trim();
  const token = $("token").value.trim();
  await chrome.storage.local.set({
    daemon: daemon || "ws://127.0.0.1:7312/extension",
    token,
  });
  await chrome.runtime.sendMessage({ type: "reconnect" }).catch(() => {});
  setTimeout(refresh, 800);
});

void load();
setInterval(refresh, 3000);

import type { PageLabel } from "./types";

async function getActiveTab(): Promise <chrome.tabs.Tab | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true});
    return tab ?? null;
}

function setStatus(msg: string) {
    const el = document.getElementById("status");
    if (el) el.textContent = msg;
}

function setUrlText(msg: string) {
    const el = document.getElementById("url");
    if (el) el.textContent = msg;
}

async function sendLabel(label: PageLabel) {
    const tab = await getActiveTab();
    if (!tab?.id || !tab.url) {
        setStatus("No active tab URL.");
        return;
    }
    setStatus("Saving...");

    const resp = await chrome.runtime.sendMessage({
        type: "LABEL_PAGE",
        tabId: tab.id,
        raw_url: tab.url,
        label,
    });

    if (resp?.ok) {
    setStatus(`Saved: ${label}`);
    } else {
    setStatus(`Failed: ${resp?.error ?? "unknown error"}`);
    }
}

function bindButton(id: string, label: PageLabel) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (!btn) return;
    btn.addEventListener("click", () => void sendLabel(label));
}

async function main() {
    const tab = await getActiveTab();
    setUrlText(tab?.url ?? "No tab URL.");
  
    bindButton("productive", "productive");
    bindButton("waste", "waste");
    bindButton("skip", "skip");
  }
  
  document.addEventListener("DOMContentLoaded", () => {
    void main();
  });
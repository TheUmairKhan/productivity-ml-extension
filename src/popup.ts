import type { PageLabel, PredictionResult } from "./types.js";

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

async function fetchPageStatus(raw_url: string): Promise<void> {
    const resp = await chrome.runtime.sendMessage({ type: "GET_PAGE_STATUS", raw_url });
    if (resp?.ok) {
        setStatus(resp.label ? `Current: ${resp.label}` : "Status: unknown");
    } else {
        setStatus(`Error: ${resp?.error ?? "unknown"}`);
    }
}

function renderPrediction(r: PredictionResult | null): void {
    const labelEl = document.getElementById("prediction-label");
    const barEl   = document.getElementById("confidence-bar") as HTMLElement | null;
    const countEl = document.getElementById("token-count");
    if (!labelEl || !barEl || !countEl) return;

    if (!r) {
        labelEl.textContent = "Loading…";
        labelEl.style.color = "#888";
        return;
    }
    if (r.n_tokens < 5) {
        labelEl.textContent = "Insufficient content";
        labelEl.style.color = "#888";
        return;
    }
    const conf = Math.max(r.p_productive, r.p_waste);
    labelEl.textContent = r.label === "productive" ? "Productive" : "Waste";
    labelEl.style.color = r.label === "productive" ? "#0b5" : "#e44";
    barEl.style.background = r.label === "productive" ? "#0b5" : "#e44";
    barEl.style.width = `${(conf * 100).toFixed(0)}%`;
    countEl.textContent = `${r.n_tokens} tokens`;
}

async function main() {
    const tab = await getActiveTab();
    setUrlText(tab?.url ?? "No tab URL.");

    if (tab?.id && tab.url) {
        const cached = await chrome.runtime.sendMessage({ type: "GET_PREDICTION", raw_url: tab.url });
        if (cached?.result) {
            renderPrediction(cached.result as PredictionResult);
        } else {
            renderPrediction(null);
            const resp = await chrome.runtime.sendMessage({
                type: "PREDICT_PAGE", tabId: tab.id, raw_url: tab.url,
            });
            if (resp?.result) {
                renderPrediction(resp.result as PredictionResult);
            } else {
                const labelEl = document.getElementById("prediction-label");
                if (labelEl) {
                    labelEl.textContent = `Error: ${resp?.error ?? "prediction failed"}`;
                    labelEl.style.color = "#e44";
                }
            }
        }
    }

    bindButton("productive", "productive");
    bindButton("waste", "waste");
    bindButton("skip", "skip");

    if (tab?.url) {
        await fetchPageStatus(tab.url);
    } else {
        setStatus("No URL to check");
    }
}

document.addEventListener("DOMContentLoaded", () => {
    void main();
});
import { MessageType, StorageKey } from "./shared/constants.js";
import type { AuthStatus, PredictionResult } from "./shared/types.js";
import { initPomodoro } from "./pomodoro.js";
import { initAuthView } from "./popup-auth.js";
import { initDonateView, refreshDonateView } from "./popup-donate.js";

type View = "loading" | "auth" | "main";

let mainInitialized = false;
let authInitialized = false;

function showView(view: View): void {
    for (const name of ["loading", "auth", "main"] as const) {
        const el = document.getElementById(`view-${name}`);
        if (el) el.hidden = name !== view;
    }
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
}

function setStatus(msg: string): void {
    const el = document.getElementById("status");
    if (el) el.textContent = msg;
}

function setUrlText(msg: string): void {
    const el = document.getElementById("url");
    if (el) el.textContent = msg;
}

function renderPrediction(r: PredictionResult | null): void {
    const labelEl = document.getElementById("prediction-label");
    const barEl = document.getElementById("confidence-bar") as HTMLElement | null;
    const noteEl = document.getElementById("prediction-note");
    if (!labelEl || !barEl) return;

    if (!r) {
        labelEl.textContent = "Loading…";
        labelEl.style.color = "#888";
        if (noteEl) noteEl.textContent = "";
        return;
    }

    const conf = Math.max(r.p_productive, r.p_waste);
    labelEl.textContent = r.label === "productive" ? "Productive" : "Waste";
    labelEl.style.color = r.label === "productive" ? "#0b5" : "#e44";
    barEl.style.background = r.label === "productive" ? "#0b5" : "#e44";
    barEl.style.width = `${(conf * 100).toFixed(0)}%`;

    if (noteEl) {
        noteEl.textContent =
            `${(r.p_waste * 100).toFixed(0)}% waste` +
            (r.params_version !== undefined ? ` · model v${r.params_version}` : "");
    }
}

async function fetchAndRenderPrediction(tab: chrome.tabs.Tab): Promise<void> {
    const cached = await chrome.runtime.sendMessage({ type: MessageType.GET_PREDICTION, raw_url: tab.url });
    if (cached?.result) {
        renderPrediction(cached.result as PredictionResult);
        return;
    }

    renderPrediction(null);
    const resp = await chrome.runtime.sendMessage({ type: MessageType.PREDICT_PAGE, tabId: tab.id, raw_url: tab.url });
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

async function initBlockingToggle(tab: chrome.tabs.Tab | null): Promise<void> {
    const toggle = document.getElementById("block-toggle") as HTMLInputElement | null;
    if (!toggle) return;

    const stored = await chrome.storage.local.get(StorageKey.BLOCKING_ENABLED) as { blocking_enabled?: boolean };
    toggle.checked = stored.blocking_enabled ?? false;

    toggle.addEventListener("change", () => {
        void chrome.runtime.sendMessage({ type: MessageType.SET_BLOCKING, enabled: toggle.checked });
        if (toggle.checked && tab?.id && tab?.url) {
            void chrome.runtime.sendMessage({ type: MessageType.PREDICT_PAGE, tabId: tab.id, raw_url: tab.url });
        }
    });
}

async function initMainView(status: AuthStatus): Promise<void> {
    const emailEl = document.getElementById("acct-email");
    if (emailEl) emailEl.textContent = status.email || "Signed in";

    const tab = await getActiveTab();
    setUrlText(tab?.url ?? "No tab URL.");

    const isExtensionPage = tab?.url?.startsWith("chrome-extension://") ?? false;
    if (!isExtensionPage && tab?.id && tab.url) {
        await fetchAndRenderPrediction(tab);
    }

    if (mainInitialized) {
        // Re-entering the main view (e.g. after signing out and back in) — the listeners are
        // already attached, but the staged list belongs to whoever is signed in now.
        refreshDonateView();
        return;
    }
    mainInitialized = true;

    document.getElementById("sign-out")?.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: MessageType.AUTH_LOGOUT });
        await boot();
    });

    await initBlockingToggle(tab);
    await initPomodoro();
    initDonateView();
    setStatus("");
}

async function boot(): Promise<void> {
    showView("loading");

    const resp = await chrome.runtime.sendMessage({ type: MessageType.GET_AUTH_STATUS });
    const status = (resp?.status as AuthStatus | undefined) ?? { signedIn: false };

    if (!status.signedIn) {
        if (!authInitialized) {
            authInitialized = true;
            initAuthView(() => void boot());
        }
        showView("auth");
        return;
    }

    await initMainView(status);
    showView("main");
}

// Converges the two paths that change auth state outside this document: the Google consent
// window (which destroys the popup mid-flow) and the uploader clearing an expired token.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[StorageKey.AUTH_TOKEN]) void boot();
});

document.addEventListener("DOMContentLoaded", () => { void boot(); });

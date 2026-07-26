import { MessageType, StorageKey } from "./shared/constants.js";
import type { PageLabel, StagedPageMeta, UploadState } from "./shared/types.js";

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function hostOf(url: string): string {
    return url.split("/")[0] ?? url;
}

/** Set by initDonateView so popup.ts can refresh the list after a sign-out/sign-in cycle. */
let refresh: (() => Promise<void>) | null = null;

export function refreshDonateView(): void {
    void refresh?.();
}

export function initDonateView(): void {
    const productiveBtn = document.getElementById("donate-productive") as HTMLButtonElement;
    const wasteBtn = document.getElementById("donate-waste") as HTMLButtonElement;
    const donateBtn = document.getElementById("donate-btn") as HTMLButtonElement;
    const donateError = document.getElementById("donate-error") as HTMLElement;
    const countEl = document.getElementById("staged-count") as HTMLElement;
    const listEl = document.getElementById("staged-list") as HTMLUListElement;
    const clearBtn = document.getElementById("clear-all") as HTMLButtonElement;
    const uploadBtn = document.getElementById("upload-all") as HTMLButtonElement;
    const progressEl = document.getElementById("upload-progress") as HTMLElement;

    let label: PageLabel = "productive";
    let items: StagedPageMeta[] = [];

    function setLabel(next: PageLabel): void {
        label = next;
        productiveBtn.classList.toggle("active", next === "productive");
        wasteBtn.classList.toggle("active", next === "waste");
    }

    function renderList(): void {
        countEl.textContent = String(items.length);
        uploadBtn.disabled = items.length === 0;
        listEl.replaceChildren();

        for (const item of items) {
            const li = document.createElement("li");
            li.className = `staged-item${item.status === "failed" ? " failed" : ""}`;

            const main = document.createElement("div");
            main.className = "staged-main";

            const title = document.createElement("div");
            title.className = "staged-title";
            title.textContent = item.title;
            title.title = item.raw_url;

            const meta = document.createElement("div");
            meta.className = "staged-meta";
            meta.textContent = `${hostOf(item.url)} · ${item.label} · ${formatBytes(item.html_bytes)}`;

            main.append(title, meta);

            if (item.status === "failed" && item.error) {
                const err = document.createElement("div");
                err.className = "staged-error";
                err.textContent = item.error;
                main.append(err);
            }

            const actions = document.createElement("div");
            actions.className = "staged-actions";

            if (item.status === "failed") {
                const retry = document.createElement("button");
                retry.className = "link";
                retry.textContent = "Retry";
                retry.addEventListener("click", () => void send(MessageType.RETRY_STAGED, { id: item.id }));
                actions.append(retry);
            }

            const remove = document.createElement("button");
            remove.className = "icon-btn";
            remove.textContent = "×";
            remove.title = "Remove";
            remove.addEventListener("click", () => void send(MessageType.REMOVE_STAGED, { id: item.id }));
            actions.append(remove);

            li.append(main, actions);
            listEl.append(li);
        }
    }

    async function send(type: string, extra: object = {}): Promise<void> {
        const resp = await chrome.runtime.sendMessage({ type, ...extra });
        if (resp?.items) {
            items = resp.items as StagedPageMeta[];
            renderList();
        }
    }

    function renderProgress(state: UploadState | undefined): void {
        if (!state) { progressEl.textContent = ""; return; }

        if (state.running) {
            const where = state.currentUrl ? ` — ${hostOf(state.currentUrl)}` : "";
            progressEl.textContent = `Uploading ${state.done + 1}/${state.total}${where}`;
            uploadBtn.disabled = true;
            uploadBtn.textContent = "Uploading…";
            return;
        }

        uploadBtn.textContent = "Upload all";
        uploadBtn.disabled = items.length === 0;

        if (state.error) {
            progressEl.textContent = state.error;
            progressEl.className = "progress error";
        } else if (state.finishedAt) {
            progressEl.className = "progress";
            progressEl.textContent = state.failed > 0
                ? `Uploaded ${state.done}, ${state.failed} failed.`
                : `Uploaded ${state.done} page${state.done === 1 ? "" : "s"}.`;
        } else {
            progressEl.textContent = "";
        }
    }

    async function donate(): Promise<void> {
        donateError.textContent = "";
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url) {
            donateError.textContent = "No active tab.";
            return;
        }

        donateBtn.disabled = true;
        donateBtn.textContent = "Capturing…";
        try {
            const resp = await chrome.runtime.sendMessage({
                type: MessageType.STAGE_PAGE,
                tabId: tab.id,
                raw_url: tab.url,
                title: tab.title ?? tab.url,
                label,
            });
            if (resp?.ok) {
                items = resp.items as StagedPageMeta[];
                renderList();
            } else {
                donateError.textContent = resp?.error ?? "Couldn't donate this page.";
            }
        } finally {
            donateBtn.disabled = false;
            donateBtn.textContent = "Add to donation list";
        }
    }

    productiveBtn.addEventListener("click", () => setLabel("productive"));
    wasteBtn.addEventListener("click", () => setLabel("waste"));
    donateBtn.addEventListener("click", () => void donate());
    clearBtn.addEventListener("click", () => void send(MessageType.CLEAR_STAGED));
    uploadBtn.addEventListener("click", async () => {
        progressEl.textContent = "Starting…";
        await chrome.runtime.sendMessage({ type: MessageType.START_UPLOAD });
    });

    // The uploader publishes progress to storage rather than broadcasting messages, so the
    // popup can be closed and reopened mid-batch and still render the live state.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes[StorageKey.UPLOAD_STATE]) return;
        const state = changes[StorageKey.UPLOAD_STATE].newValue as UploadState | undefined;
        renderProgress(state);
        if (state && !state.running) void send(MessageType.LIST_STAGED);
    });

    refresh = async () => {
        await send(MessageType.LIST_STAGED);
        const resp = await chrome.runtime.sendMessage({ type: MessageType.GET_UPLOAD_STATE });
        renderProgress(resp?.state as UploadState | undefined);
    };

    setLabel("productive");
    void refresh();
}

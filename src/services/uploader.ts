import { MAX_UPLOAD_ATTEMPTS, MessageType, StorageKey, UPLOAD_LEASE_MS } from "../shared/constants.js";
import { MessageRouter } from "../shared/message-router.js";
import type { StagedPageMeta, UploadState } from "../shared/types.js";
import { ApiError, uploadPage } from "./api.js";
import {
    countStaged, getStagedHtml, nextPending, removeStaged, resetInFlight, updateStaged,
} from "./staging.js";

const IDLE_STATE: UploadState = { running: false, total: 0, done: 0, failed: 0, heartbeat: 0 };

export async function getUploadState(): Promise<UploadState> {
    const s = await chrome.storage.local.get(StorageKey.UPLOAD_STATE);
    return (s[StorageKey.UPLOAD_STATE] as UploadState) ?? IDLE_STATE;
}

async function setUploadState(patch: Partial<UploadState>): Promise<void> {
    const current = await getUploadState();
    await chrome.storage.local.set({
        [StorageKey.UPLOAD_STATE]: { ...current, ...patch, heartbeat: Date.now() },
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts a batch and returns immediately — never awaits it. Awaiting would make the popup's
 * sendMessage promise reject with "message channel closed" the moment the popup closes,
 * which is exactly when a long upload is most likely to be running.
 */
export async function startUpload(): Promise<{ ok: true; started: boolean }> {
    const state = await getUploadState();
    // A module-level boolean would be lost on service-worker restart, so the guard is a
    // storage lease: a batch whose heartbeat has gone stale is treated as abandoned.
    if (state.running && Date.now() - state.heartbeat < UPLOAD_LEASE_MS) {
        return { ok: true, started: false };
    }

    void runBatch().catch(async (e) => {
        await setUploadState({ running: false, error: String((e as Error)?.message ?? e) });
    });
    return { ok: true, started: true };
}

async function runBatch(): Promise<void> {
    await resetInFlight();

    const total = await countStaged();
    await chrome.storage.local.set({
        [StorageKey.UPLOAD_STATE]: {
            running: true, total, done: 0, failed: 0, heartbeat: Date.now(),
            error: undefined, code: undefined, finishedAt: undefined,
        } satisfies UploadState,
    });

    // A batch calls chrome.storage per page, which resets the 30s idle timer. This only
    // covers the gap where one single upload runs longer than that with no API call between.
    const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);

    let done = 0;
    let failed = 0;

    try {
        for (;;) {
            const rec: StagedPageMeta | null = await nextPending();
            if (!rec) break;

            await updateStaged(rec.id, { status: "uploading" });
            await setUploadState({ done, failed, currentUrl: rec.url });

            const html = await getStagedHtml(rec.id);
            if (html === null) {
                await updateStaged(rec.id, {
                    status: "failed", attempts: MAX_UPLOAD_ATTEMPTS, error: "Staged HTML is missing.",
                });
                failed++;
                continue;
            }

            try {
                await uploadPage({
                    url: rec.url,
                    raw_url: rec.raw_url,
                    html,
                    label: rec.label,
                    captured_at: rec.captured_at,
                });
                // Delete only after a 200. A crash before this re-uploads the page next time,
                // which is safe: the backend upserts by unique url and (user_id, page_id).
                await removeStaged(rec.id);
                done++;
            } catch (e) {
                const err = e as ApiError;

                if (err?.code === "session_expired") {
                    // Every remaining request would fail identically — stop the whole batch
                    // and leave the pages staged for after the user signs back in.
                    await updateStaged(rec.id, { status: "pending" });
                    await setUploadState({
                        running: false, done, failed,
                        currentUrl: undefined,
                        code: "session_expired",
                        error: "Session expired — sign in again.",
                        finishedAt: Date.now(),
                    });
                    return;
                }

                const message = String(err?.message ?? e);
                const permanent = err?.status >= 400 && err?.status < 500;
                const attempts = rec.attempts + 1;

                if (!permanent && attempts < MAX_UPLOAD_ATTEMPTS) {
                    await updateStaged(rec.id, { status: "pending", attempts, error: message });
                    await sleep(1500);
                } else {
                    await updateStaged(rec.id, {
                        status: "failed",
                        attempts: permanent ? MAX_UPLOAD_ATTEMPTS : attempts,
                        error: message,
                    });
                    failed++;
                }
            }
        }

        await setUploadState({ running: false, done, failed, currentUrl: undefined, finishedAt: Date.now() });
    } finally {
        clearInterval(keepAlive);
    }
}

export function registerHandlers(router: MessageRouter): void {
    router.register(MessageType.START_UPLOAD, async () => startUpload());
    router.register(MessageType.GET_UPLOAD_STATE, async () => {
        return { ok: true, state: await getUploadState() };
    });
}

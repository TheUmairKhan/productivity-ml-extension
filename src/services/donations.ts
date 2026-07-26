import { MessageType } from "../shared/constants.js";
import { MessageRouter } from "../shared/message-router.js";
import type { StagePageRequest, StagedIdRequest } from "../shared/types.js";
import { captureHtml, isHttpUrl, normalizeUrl } from "./capture.js";
import {
    clearStaged, listStaged, removeStaged, retryStaged, stagePage,
} from "./staging.js";

export function registerHandlers(router: MessageRouter): void {
    router.register(MessageType.STAGE_PAGE, async (msg: StagePageRequest) => {
        if (!isHttpUrl(msg.raw_url)) {
            return { ok: false, error: "Only http(s) pages can be donated." };
        }

        // executeScript rejects on the Web Store, PDF viewer, view-source: and discarded tabs.
        let html: string;
        try {
            html = await captureHtml(msg.tabId);
        } catch {
            return { ok: false, error: "Couldn't read this page. Try reloading it first." };
        }

        const item = await stagePage({
            raw_url: msg.raw_url,
            url: normalizeUrl(msg.raw_url),
            title: msg.title || msg.raw_url,
            label: msg.label,
            captured_at: new Date().toISOString(),
            html,
        });

        return { ok: true, item, items: await listStaged() };
    });

    router.register(MessageType.LIST_STAGED, async () => {
        return { ok: true, items: await listStaged() };
    });

    router.register(MessageType.REMOVE_STAGED, async (msg: StagedIdRequest) => {
        await removeStaged(msg.id);
        return { ok: true, items: await listStaged() };
    });

    router.register(MessageType.RETRY_STAGED, async (msg: StagedIdRequest) => {
        await retryStaged(msg.id);
        return { ok: true, items: await listStaged() };
    });

    router.register(MessageType.CLEAR_STAGED, async () => {
        await clearStaged();
        return { ok: true, items: [] };
    });
}

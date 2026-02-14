import { PageLabel } from "./types";
import { pageCapture } from "./capture";
import { sendToLocalHost, queryPageStatus } from "./messaging";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        if (msg?.type === "LABEL_PAGE") {
            const tabId: number | undefined = msg.tabId;
            const raw_url: string | undefined = msg.raw_url;
            const label: PageLabel | undefined = msg.label;

            if (!tabId || !raw_url || !label) {
                sendResponse({ ok: false, error: "Missing fields." });
                return;
            }

            const capture = await pageCapture(raw_url, tabId, label);
            if (!capture) {
                sendResponse({ ok: false, error: "Capture failed or URL not allowed." });
                return;
            }
            capture.label = label;

            await sendToLocalHost(capture);

            sendResponse({ ok: true });
        } else if (msg?.type === "GET_PAGE_STATUS") {
            const raw_url: string | undefined = msg.raw_url;
            if (!raw_url) {
                sendResponse({ ok: false, label: null, error: "Missing raw_url." });
                return;
            }

            const response = await queryPageStatus(raw_url);
            sendResponse(response);
        }
    })().catch((e) => {
        sendResponse({ ok: false, error: String(e?.message ?? e) });
    });
    return true;
});

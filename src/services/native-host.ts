import { PageCapture, StatusResponse, LabelPageRequest, GetPageStatusRequest } from "../shared/types.js";
import { MessageType, NativeHost } from "../shared/constants.js";
import { normalizeUrl, pageCapture } from "./capture.js";
import { MessageRouter } from "../shared/message-router.js";

function callNativeHost<T>(message: object): Promise<T> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendNativeMessage(NativeHost.MLOPS, message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
            } else {
                resolve(response as T);
            }
        });
    });
}

export async function sendToLocalHost(capture: PageCapture): Promise<void> {
    await callNativeHost({ type: "capture", ...capture });
}

export async function queryPageStatus(raw_url: string): Promise<StatusResponse> {
    return callNativeHost<StatusResponse>({ type: "get_status", url: normalizeUrl(raw_url) });
}

export function registerHandlers(router: MessageRouter): void {
    router.register(MessageType.LABEL_PAGE, async (msg: LabelPageRequest) => {
        const capture = await pageCapture(msg.raw_url, msg.tabId, msg.label);
        if (!capture) return { ok: false, error: "Capture failed or URL not allowed." };
        await sendToLocalHost(capture);
        return { ok: true };
    });
    router.register(MessageType.GET_PAGE_STATUS, async (msg: GetPageStatusRequest) => {
        return queryPageStatus(msg.raw_url);
    });
}

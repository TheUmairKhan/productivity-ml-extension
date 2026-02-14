import { PageCapture, StatusResponse } from "./types";
import { normalizeUrl } from "./capture";

const HOST_NAME = "com.mlops.host";

export async function sendToLocalHost(capture: PageCapture): Promise<void> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendNativeMessage(
            HOST_NAME,
            { type: "capture", ...capture },
            (response) => {
                if (chrome.runtime.lastError) {
                    console.error("Native Messaging Error:", chrome.runtime.lastError.message);
                    reject(chrome.runtime.lastError);
                } else {
                    console.log("Response from Rust:", response);
                    resolve();
                }
            }
        )
    })
}

export async function queryPageStatus(raw_url: string): Promise<StatusResponse> {
    const url = normalizeUrl(raw_url);
    return new Promise((resolve, reject) => {
        chrome.runtime.sendNativeMessage(
            HOST_NAME,
            { type: "get_status", url },
            (response) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(response);
                }
            }
        );
    });
}

type Handler = (msg: any) => Promise<object>;

export class MessageRouter {
    private readonly handlers = new Map<string, Handler>();

    register(type: string, handler: Handler): void {
        this.handlers.set(type, handler);
    }

    listen(): void {
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
            const handler = this.handlers.get(msg?.type);
            if (!handler) {
                sendResponse({ ok: false, error: "Unknown message type." });
                return true;
            }
            handler(msg)
                .then(sendResponse)
                .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e), code: e?.code }));
            return true;
        });
    }
}

export type PageLabel = "productive" | "waste" | "skip";

export interface PageCapture {
    raw_url: string;
    url: string;
    html: string;
    screenshot: string;
    captured_at: string;
    label: PageLabel;
}

export interface GetStatusMessage {
    type: "get_status";
    url: string;
}

export interface StatusResponse {
    ok: boolean;
    label: PageLabel | null;
    error?: string;
}
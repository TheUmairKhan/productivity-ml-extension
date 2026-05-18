export type PageLabel = "productive" | "waste" | "skip";

export interface PageCapture {
    raw_url: string;
    url: string;
    html: string;
    screenshot: string;
    captured_at: string;
    label: PageLabel;
}

export interface StatusResponse {
    ok: boolean;
    label: PageLabel | null;
    error?: string;
}

export interface PredictionResult {
    label: "productive" | "waste";
    p_productive: number;
    p_waste: number;
    n_tokens: number;
}

// Typed message request interfaces — discriminated union for the message router
export interface LabelPageRequest {
    type: "LABEL_PAGE";
    tabId: number;
    raw_url: string;
    label: PageLabel;
}

export interface GetPageStatusRequest {
    type: "GET_PAGE_STATUS";
    raw_url: string;
}

export interface PredictPageRequest {
    type: "PREDICT_PAGE";
    tabId: number;
    raw_url: string;
}

export interface GetPredictionRequest {
    type: "GET_PREDICTION";
    raw_url: string;
}

export interface SetBlockingRequest {
    type: "SET_BLOCKING";
    enabled: boolean;
}

export interface SetPomodoro {
    type: "SET_POMODORO";
    enabled: boolean;
    durationMinutes?: number;
}

export type ExtensionMessage =
    | LabelPageRequest
    | GetPageStatusRequest
    | PredictPageRequest
    | GetPredictionRequest
    | SetBlockingRequest
    | SetPomodoro;

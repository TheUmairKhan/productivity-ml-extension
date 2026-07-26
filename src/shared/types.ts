export type PageLabel = "productive" | "waste";

export type AuthProvider = "password" | "google";

export interface PredictionResult {
    label: PageLabel;
    p_productive: number;
    p_waste: number;
}

// --- Auth ---

export interface Session {
    token: string;
    email: string;
    provider: AuthProvider;
    expiresAt: number;
}

export interface AuthStatus {
    signedIn: boolean;
    email?: string;
    provider?: AuthProvider;
}

// --- Donation staging ---

export type StagedStatus = "pending" | "uploading" | "failed";

export interface StagedPageMeta {
    id: string;
    raw_url: string;
    url: string;
    title: string;
    label: PageLabel;
    captured_at: string;
    html_bytes: number;
    status: StagedStatus;
    attempts: number;
    error?: string;
}

export interface UploadState {
    running: boolean;
    total: number;
    done: number;
    failed: number;
    currentUrl?: string;
    error?: string;
    code?: string;
    heartbeat: number;
    finishedAt?: number;
}

// --- Backend DTOs (mirror backend/pages.py and backend/auth.py) ---

export interface TokenResponse {
    access_token: string;
    token_type: string;
}

export interface PageUploadBody {
    url: string;
    raw_url: string;
    html: string;
    label: string;
    captured_at: string;
}

export interface PageUploadResponse {
    page_id: string;
}

export interface PageLabelOut {
    page_id: string;
    url: string;
    raw_url: string;
    label: string;
    captured_at: string;
}

// --- Typed message requests — discriminated union for the message router ---

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

export interface AuthCredsRequest {
    type: "AUTH_REGISTER" | "AUTH_LOGIN_PASSWORD";
    email: string;
    password: string;
}

export interface SimpleRequest {
    type: "GET_AUTH_STATUS" | "AUTH_LOGIN_GOOGLE" | "AUTH_LOGOUT"
    | "LIST_STAGED" | "CLEAR_STAGED" | "START_UPLOAD" | "GET_UPLOAD_STATE";
}

export interface StagePageRequest {
    type: "STAGE_PAGE";
    tabId: number;
    raw_url: string;
    title: string;
    label: PageLabel;
}

export interface StagedIdRequest {
    type: "REMOVE_STAGED" | "RETRY_STAGED";
    id: string;
}

export type ExtensionMessage =
    | PredictPageRequest
    | GetPredictionRequest
    | SetBlockingRequest
    | SetPomodoro
    | AuthCredsRequest
    | SimpleRequest
    | StagePageRequest
    | StagedIdRequest;

export type PageLabel = "productive" | "waste";

export type AuthProvider = "password" | "google";

export interface PredictionResult {
    label: PageLabel;
    p_productive: number;
    p_waste: number;
    /** z_u . z_i, before calibration. Kept for debugging the scorer. */
    score?: number;
    /** Which global param version produced this, so stale cache entries are visible. */
    params_version?: number;
}

// --- Item tower ---

/** assets/extractor-config.json, with the list fields turned into Sets. */
export interface ExtractorConfig {
    max_tokens: number;
    tag_to_idx: Record<string, number>;
    innertext_tags: Set<string>;
    exclude_tags: Set<string>;
    void_elements: Set<string>;
    meta_names: Set<string>;
    cdata_elements: Set<string>;
}

/** assets/entities.json — Python's html.entities, so both sides decode alike. */
export interface EntityTables {
    html5: Record<string, string>;
    invalid_charrefs: Record<string, string>;
    invalid_codepoints: Set<number>;
}

// --- Two-tower parameters ---

/** GET /params. Fit server-side on pooled donated data, cached on device. */
export interface GlobalParams {
    version: number;
    sigma: number[];
    z_global: number[];
    a: number;
    b: number;
    kappa: number;
    threshold: number;
    encoder_version: string;
    fitted_at: string;
}

/**
 * The user tower's entire state: running sums and counts of preprocessed item
 * embeddings, positives being "waste". Updating it on a new label is O(1) and
 * involves no training.
 */
export interface UserAccumulators {
    s_pos: number[];
    n_pos: number;
    s_neg: number[];
    n_neg: number;
}

/** GET /users/me/embeddings — centroids plus the counts needed to rebuild sums. */
export interface UserEmbeddingsOut {
    productive: number[] | null;
    waste: number[] | null;
    n_productive: number;
    n_waste: number;
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

export const MessageType = {
    PREDICT_PAGE: "PREDICT_PAGE",
    GET_PREDICTION: "GET_PREDICTION",
    SET_BLOCKING: "SET_BLOCKING",
    SET_POMODORO: "SET_POMODORO",

    GET_AUTH_STATUS: "GET_AUTH_STATUS",
    AUTH_REGISTER: "AUTH_REGISTER",
    AUTH_LOGIN_PASSWORD: "AUTH_LOGIN_PASSWORD",
    AUTH_LOGIN_GOOGLE: "AUTH_LOGIN_GOOGLE",
    AUTH_LOGOUT: "AUTH_LOGOUT",

    STAGE_PAGE: "STAGE_PAGE",
    LIST_STAGED: "LIST_STAGED",
    REMOVE_STAGED: "REMOVE_STAGED",
    CLEAR_STAGED: "CLEAR_STAGED",
    RETRY_STAGED: "RETRY_STAGED",
    START_UPLOAD: "START_UPLOAD",
    GET_UPLOAD_STATE: "GET_UPLOAD_STATE",
} as const;

export type MessageType = typeof MessageType[keyof typeof MessageType];

export const StorageKey = {
    BLOCKING_ENABLED: "blocking_enabled",
    BLOCK_ALLOWLIST: "block_allowlist",
    POMODORO_ENABLED: "pomodoro_enabled",

    AUTH_TOKEN: "auth_token",
    AUTH_EMAIL: "auth_email",
    AUTH_PROVIDER: "auth_provider",
    AUTH_EXPIRES_AT: "auth_expires_at",

    UPLOAD_STATE: "upload_state",
} as const;

export const API_BASE_URL = "http://127.0.0.1:8000";

export const GOOGLE_CLIENT_ID = "154654044556-i48sihfe0d71ao42d8t5cpgqs2m62sm5.apps.googleusercontent.com";
export const GOOGLE_SCOPES = "openid email profile";

export const API_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

// IndexedDB staging store for donated pages.
export const STAGING_DB_NAME = "mlops-staging";
export const STAGING_DB_VERSION = 1;
export const STORE_META = "staged_meta";
export const STORE_HTML = "staged_html";

export const MAX_UPLOAD_ATTEMPTS = 2;
export const MAX_HTML_BYTES = 12 * 1024 * 1024;

// An upload batch is treated as abandoned once its heartbeat is older than this.
export const UPLOAD_LEASE_MS = 30_000;

export function predictionCacheKey(normalizedUrl: string): string {
    return `pred:${normalizedUrl}`;
}

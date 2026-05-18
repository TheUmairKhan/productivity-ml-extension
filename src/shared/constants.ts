export const MessageType = {
    LABEL_PAGE: "LABEL_PAGE",
    GET_PAGE_STATUS: "GET_PAGE_STATUS",
    PREDICT_PAGE: "PREDICT_PAGE",
    GET_PREDICTION: "GET_PREDICTION",
    SET_BLOCKING: "SET_BLOCKING",
    SET_POMODORO: "SET_POMODORO",
} as const;

export type MessageType = typeof MessageType[keyof typeof MessageType];

export const StorageKey = {
    BLOCKING_ENABLED: "blocking_enabled",
    BLOCK_ALLOWLIST: "block_allowlist",
    POMODORO_ENABLED: "pomodoro_enabled",
} as const;

export const NativeHost = {
    MLOPS: "com.mlops.host",
    PREDICTOR: "com.predictor",
} as const;

export const PREDICTION_TIMEOUT_MS = 30_000;

export function predictionCacheKey(normalizedUrl: string): string {
    return `pred:${normalizedUrl}`;
}

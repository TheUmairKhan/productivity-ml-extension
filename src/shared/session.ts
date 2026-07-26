import { StorageKey } from "./constants.js";
import type { AuthProvider, Session } from "./types.js";

/**
 * Reads the `exp` claim without verifying the signature. Advisory only — it lets the UI say
 * "session expired" before firing a request that is guaranteed to 401. The backend is the
 * authority on validity.
 */
function decodeJwtExp(token: string): number {
    try {
        const payload = token.split(".")[1];
        if (!payload) return 0;
        const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
        const exp = JSON.parse(json)?.exp;
        return typeof exp === "number" ? exp * 1000 : 0;
    } catch {
        return 0;
    }
}

export async function getSession(): Promise<Session | null> {
    const s = await chrome.storage.local.get([
        StorageKey.AUTH_TOKEN, StorageKey.AUTH_EMAIL,
        StorageKey.AUTH_PROVIDER, StorageKey.AUTH_EXPIRES_AT,
    ]);
    const token = s[StorageKey.AUTH_TOKEN] as string | undefined;
    if (!token) return null;
    return {
        token,
        email: (s[StorageKey.AUTH_EMAIL] as string) ?? "",
        provider: (s[StorageKey.AUTH_PROVIDER] as AuthProvider) ?? "password",
        expiresAt: (s[StorageKey.AUTH_EXPIRES_AT] as number) ?? 0,
    };
}

export async function getToken(): Promise<string | null> {
    return (await getSession())?.token ?? null;
}

export async function setSession(token: string, email: string, provider: AuthProvider): Promise<void> {
    await chrome.storage.local.set({
        [StorageKey.AUTH_TOKEN]: token,
        [StorageKey.AUTH_EMAIL]: email,
        [StorageKey.AUTH_PROVIDER]: provider,
        [StorageKey.AUTH_EXPIRES_AT]: decodeJwtExp(token),
    });
}

export async function clearSession(): Promise<void> {
    await chrome.storage.local.remove([
        StorageKey.AUTH_TOKEN, StorageKey.AUTH_EMAIL,
        StorageKey.AUTH_PROVIDER, StorageKey.AUTH_EXPIRES_AT,
    ]);
}

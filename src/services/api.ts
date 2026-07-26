import { API_BASE_URL, API_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from "../shared/constants.js";
import { clearSession, getSession } from "../shared/session.js";
import type {
    PageLabelOut, PageUploadBody, PageUploadResponse, TokenResponse,
} from "../shared/types.js";

export class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(message);
        this.name = "ApiError";
    }
}

/**
 * fastapi-users returns `detail` as a bare string ("LOGIN_BAD_CREDENTIALS"), as an object
 * ({code, reason}), or as pydantic's 422 list. Normalize all three into one shape.
 */
async function toApiError(res: Response): Promise<ApiError> {
    let code = `http_${res.status}`;
    let message = `Request failed (${res.status})`;

    try {
        const detail = (await res.json())?.detail;
        if (typeof detail === "string") {
            code = detail;
            message = detail;
        } else if (Array.isArray(detail)) {
            message = detail.map((d) => d?.msg ?? String(d)).join("; ") || message;
            code = "validation_error";
        } else if (detail && typeof detail === "object") {
            code = detail.code ?? code;
            message = detail.reason ?? detail.code ?? message;
        }
    } catch {
        // Non-JSON body — keep the status-based defaults.
    }

    return new ApiError(res.status, code, message);
}

async function rawFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
        return await fetch(`${API_BASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        const name = (e as Error)?.name;
        if (name === "TimeoutError" || name === "AbortError") {
            throw new ApiError(0, "timeout", "The server took too long to respond.");
        }
        throw new ApiError(0, "network", "Can't reach the server. Is the backend running?");
    }
}

async function authedFetch(path: string, init: RequestInit = {}, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
    const session = await getSession();
    if (!session) throw new ApiError(401, "session_expired", "You are signed out.");

    const res = await rawFetch(path, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${session.token}` },
    }, timeoutMs);

    // The JWT lives 3600s and the backend has no refresh endpoint, so expiry is a routine
    // path: drop the session and let the caller bounce the user to sign-in.
    if (res.status === 401) {
        await clearSession();
        throw new ApiError(401, "session_expired", "Session expired — sign in again.");
    }
    if (!res.ok) throw await toApiError(res);
    return res;
}

// --- Auth endpoints ---

export async function register(email: string, password: string): Promise<void> {
    const res = await rawFetch("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    }, API_TIMEOUT_MS);
    if (!res.ok) throw await toApiError(res);
}

export async function loginPassword(email: string, password: string): Promise<TokenResponse> {
    // fastapi-users' OAuth2PasswordRequestForm: form-encoded, and the email goes in `username`.
    // Deliberately no Content-Type header — fetch sets the correct one for URLSearchParams.
    const res = await rawFetch("/auth/jwt/login", {
        method: "POST",
        body: new URLSearchParams({ username: email, password }),
    }, API_TIMEOUT_MS);
    if (!res.ok) throw await toApiError(res);
    return res.json() as Promise<TokenResponse>;
}

export async function loginGoogle(googleAccessToken: string): Promise<TokenResponse> {
    const res = await rawFetch("/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: googleAccessToken }),
    }, API_TIMEOUT_MS);
    if (!res.ok) throw await toApiError(res);
    return res.json() as Promise<TokenResponse>;
}

// --- Authed endpoints ---

export async function getMe(): Promise<{ email: string }> {
    const res = await authedFetch("/users/me");
    return res.json() as Promise<{ email: string }>;
}

export async function listMyPages(): Promise<PageLabelOut[]> {
    const res = await authedFetch("/pages/me");
    return res.json() as Promise<PageLabelOut[]>;
}

export async function uploadPage(body: PageUploadBody): Promise<PageUploadResponse> {
    const res = await authedFetch("/pages/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }, UPLOAD_TIMEOUT_MS);
    return res.json() as Promise<PageUploadResponse>;
}

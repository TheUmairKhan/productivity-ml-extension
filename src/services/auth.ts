import { MessageType } from "../shared/constants.js";
import { MessageRouter } from "../shared/message-router.js";
import { clearSession, getSession, setSession } from "../shared/session.js";
import type { AuthCredsRequest, AuthStatus } from "../shared/types.js";
import { getMe, loginGoogle, loginPassword, register } from "./api.js";
import { getGoogleAccessToken } from "./google-auth.js";

export async function getAuthStatus(): Promise<AuthStatus> {
    const session = await getSession();
    if (!session) return { signedIn: false };
    return { signedIn: true, email: session.email, provider: session.provider };
}

export async function signIn(email: string, password: string): Promise<AuthStatus> {
    const { access_token } = await loginPassword(email, password);
    await setSession(access_token, email, "password");
    return { signedIn: true, email, provider: "password" };
}

export async function signUp(email: string, password: string): Promise<AuthStatus> {
    // /auth/register returns the user, not a token, so log in immediately afterwards.
    await register(email, password);
    return signIn(email, password);
}

export async function signInWithGoogle(): Promise<AuthStatus> {
    const googleToken = await getGoogleAccessToken();
    const { access_token } = await loginGoogle(googleToken);

    // The backend derives the email from Google; store the token first so getMe() can use it.
    await setSession(access_token, "", "google");
    let email = "";
    try {
        email = (await getMe()).email;
    } catch {
        // Non-fatal: we are signed in either way, we just can't label the account yet.
    }
    await setSession(access_token, email, "google");
    return { signedIn: true, email, provider: "google" };
}

export async function signOut(): Promise<void> {
    await clearSession();
}

export function registerHandlers(router: MessageRouter): void {
    router.register(MessageType.GET_AUTH_STATUS, async () => {
        return { ok: true, status: await getAuthStatus() };
    });
    router.register(MessageType.AUTH_REGISTER, async (msg: AuthCredsRequest) => {
        return { ok: true, status: await signUp(msg.email, msg.password) };
    });
    router.register(MessageType.AUTH_LOGIN_PASSWORD, async (msg: AuthCredsRequest) => {
        return { ok: true, status: await signIn(msg.email, msg.password) };
    });
    router.register(MessageType.AUTH_LOGIN_GOOGLE, async () => {
        return { ok: true, status: await signInWithGoogle() };
    });
    router.register(MessageType.AUTH_LOGOUT, async () => {
        await signOut();
        return { ok: true };
    });
}

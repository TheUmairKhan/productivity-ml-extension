import { MessageType } from "./shared/constants.js";

type Mode = "signin" | "signup";

const FRIENDLY: Record<string, string> = {
    LOGIN_BAD_CREDENTIALS: "Wrong email or password.",
    REGISTER_USER_ALREADY_EXISTS: "That email is already registered — sign in instead.",
    REGISTER_INVALID_PASSWORD: "That password is too weak. Use at least 8 characters.",
    session_expired: "Session expired — sign in again.",
    network: "Can't reach the server. Is the backend running?",
    timeout: "The server took too long to respond.",
};

function friendly(resp: { error?: string; code?: string } | undefined): string {
    if (!resp) return "Something went wrong.";
    return FRIENDLY[resp.code ?? ""] ?? resp.error ?? "Something went wrong.";
}

export function initAuthView(onSignedIn: () => void): void {
    const emailEl = document.getElementById("auth-email") as HTMLInputElement;
    const passwordEl = document.getElementById("auth-password") as HTMLInputElement;
    const submitEl = document.getElementById("auth-submit") as HTMLButtonElement;
    const googleEl = document.getElementById("google-signin") as HTMLButtonElement;
    const errorEl = document.getElementById("auth-error") as HTMLElement;
    const signinTab = document.getElementById("tab-signin") as HTMLButtonElement;
    const signupTab = document.getElementById("tab-signup") as HTMLButtonElement;

    let mode: Mode = "signin";

    function setMode(next: Mode): void {
        mode = next;
        signinTab.classList.toggle("active", mode === "signin");
        signupTab.classList.toggle("active", mode === "signup");
        submitEl.textContent = mode === "signin" ? "Sign in" : "Create account";
        passwordEl.autocomplete = mode === "signin" ? "current-password" : "new-password";
        errorEl.textContent = "";
    }

    function setBusy(busy: boolean): void {
        submitEl.disabled = busy;
        googleEl.disabled = busy;
    }

    async function submit(): Promise<void> {
        const email = emailEl.value.trim();
        const password = passwordEl.value;
        if (!email || !password) {
            errorEl.textContent = "Enter an email and password.";
            return;
        }

        errorEl.textContent = "";
        setBusy(true);
        submitEl.textContent = mode === "signin" ? "Signing in…" : "Creating account…";
        try {
            const resp = await chrome.runtime.sendMessage({
                type: mode === "signin" ? MessageType.AUTH_LOGIN_PASSWORD : MessageType.AUTH_REGISTER,
                email,
                password,
            });
            if (resp?.ok) {
                onSignedIn();
                return;
            }
            errorEl.textContent = friendly(resp);
        } catch (e) {
            errorEl.textContent = String((e as Error)?.message ?? e);
        } finally {
            setBusy(false);
            setMode(mode);
        }
    }

    async function googleSignIn(): Promise<void> {
        errorEl.textContent = "";
        setBusy(true);
        googleEl.textContent = "Waiting for Google…";
        try {
            // Google's consent window steals focus, which usually destroys this popup before
            // the response lands. That's expected: the background finishes the flow and the
            // storage listener in popup.ts re-boots into the signed-in view on reopen.
            const resp = await chrome.runtime.sendMessage({ type: MessageType.AUTH_LOGIN_GOOGLE });
            if (resp?.ok) {
                onSignedIn();
                return;
            }
            errorEl.textContent = friendly(resp);
        } catch (e) {
            errorEl.textContent = String((e as Error)?.message ?? e);
        } finally {
            setBusy(false);
            googleEl.textContent = "Continue with Google";
        }
    }

    signinTab.addEventListener("click", () => setMode("signin"));
    signupTab.addEventListener("click", () => setMode("signup"));
    submitEl.addEventListener("click", () => void submit());
    googleEl.addEventListener("click", () => void googleSignIn());
    passwordEl.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
    emailEl.addEventListener("keydown", (e) => { if (e.key === "Enter") passwordEl.focus(); });

    setMode("signin");
}

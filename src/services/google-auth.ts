import { GOOGLE_CLIENT_ID, GOOGLE_SCOPES } from "../shared/constants.js";

/**
 * The single point where the Google mechanism is decided. Everything downstream only ever
 * sees an access token, which is exactly what `POST /auth/google` validates against Google's
 * userinfo endpoint.
 *
 * Uses launchWebAuthFlow against Google directly (implicit flow, `response_type=token`), so
 * no client secret is needed and no backend endpoint has to exist. If Google ever refuses the
 * implicit flow for this client, switch to `response_type=code` + PKCE and exchange at
 * https://oauth2.googleapis.com/token — the backend is unaffected either way.
 *
 * MUST be called from the background service worker. The consent window steals focus, which
 * destroys the popup document and would leave this promise unresolved.
 */
export async function getGoogleAccessToken(): Promise<string> {
    if (GOOGLE_CLIENT_ID.startsWith("YOUR_CLIENT_ID")) {
        throw new Error(
            "Google sign-in isn't configured yet. Set GOOGLE_CLIENT_ID in src/shared/constants.ts.",
        );
    }

    const redirectUri = chrome.identity.getRedirectURL();
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    authUrl.searchParams.set("response_type", "token");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", GOOGLE_SCOPES);
    authUrl.searchParams.set("prompt", "consent");

    const responseUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl.toString(),
        interactive: true,
    });
    if (!responseUrl) throw new Error("Google sign-in was cancelled.");

    // The token comes back in the fragment, not the query string.
    const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
    const error = params.get("error");
    if (error) throw new Error(`Google sign-in failed: ${error}`);

    const token = params.get("access_token");
    if (!token) throw new Error("Google did not return an access token.");
    return token;
}

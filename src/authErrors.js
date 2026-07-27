// Supabase hands back an error *object*, so rendering it — or rendering a
// message that is itself a JSON blob — puts a bare red "{}" on screen. That
// blob comes from auth-js: when an error response body has none of
// msg/message/error_description/error, _getErrorMessage falls through to
// JSON.stringify(body), and "{}" becomes error.message verbatim.
//
// Every auth error the UI shows goes through here and comes out a sentence.
export function formatAuthError(error) {
  if (!error) return "";

  const raw = typeof error === "string" ? error : error?.message ?? String(error);
  const { code, status, name } = typeof error === "object" && error ? error : {};

  // Supabase throttles magic links to one per address per 60s. The message
  // reads "For security purposes, you can only request this after 41 seconds."
  if (
    code === "over_email_send_rate_limit" ||
    status === 429 ||
    /\bafter\s+\d+\s+seconds?\b/i.test(raw)
  ) {
    return "Please wait a minute before requesting another link.";
  }

  // fetch() never reached the server (offline, DNS, CORS) or the gateway
  // failed — auth-js wraps both as AuthRetryableFetchError.
  if (
    name === "AuthRetryableFetchError" ||
    /failed to fetch|load failed|networkerror|network request failed/i.test(raw)
  ) {
    return "Couldn't reach the server — try again.";
  }

  // An empty or opaque message is the "{}" bug itself — never show it raw.
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[object Object]" || /^[[{]/.test(trimmed)) {
    return "Something went wrong — please try again.";
  }

  return trimmed;
}

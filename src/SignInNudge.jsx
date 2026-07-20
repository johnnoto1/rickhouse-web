import AddEmail from "./AddEmail";

// Reusable sign-in nudge shown where a full account is required but the
// current session is anonymous (today: the Scan Shelf entry point). It is
// deliberately its own component, not inlined, because it will later host
// OAuth provider buttons (Sign in with Google/Apple, etc.) above the email
// path. For now it routes straight into the existing AddEmail upgrade flow —
// the same flow ContributionGate uses — so a guest's votes and collection
// carry over when they create or sign into an account.
export default function SignInNudge({ onDone, message }) {
  return (
    <div>
      {/* OAuth provider buttons will live here in a later pass. */}
      <AddEmail
        onDone={onDone}
        contextMessage={
          message ??
          "This feature requires a full account — your votes and collection carry over."
        }
      />
    </div>
  );
}

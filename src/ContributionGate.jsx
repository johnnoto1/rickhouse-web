import AddEmail from "./AddEmail";

// Wraps any contribution entry point (new_bottle / edit_field /
// price_report). Anonymous sessions render the account-upgrade view
// instead of the form itself — contribution features are where trust
// starts, so every entry point requires a real account, not just a vote.
export default function ContributionGate({ session, onDone, children }) {
  const isAnon = session?.user?.is_anonymous === true;
  if (!session || isAnon) {
    return (
      <AddEmail
        onDone={onDone}
        contextMessage="Contributing requires an account — your votes and collection carry over."
      />
    );
  }
  return children;
}

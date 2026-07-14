import { useState } from "react";
import { supabase } from "./supabaseClient";

// Anonymous → email upgrade. Shared by /rank (Game's "Sign in" tab) and
// every contribution entry point (new_bottle / edit_field / price_report)
// — one implementation, not a per-page reimplementation, since App.jsx's
// pages are inline-style and Collection/BottleProfile/TradeCalculator are
// Tailwind, but Tailwind's stylesheet is loaded globally (index.css)
// regardless of which page renders this, so a single Tailwind version
// works everywhere.
//
// Two explicit paths:
//   "Create account"       → updateUser({ email }) keeps vote history
//   "Already have account" → signInWithOtp({ email }) abandons anon session
export default function AddEmail({ onDone, contextMessage }) {
  const [path, setPath] = useState("create"); // "create" | "signin"
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");
  const [emailConflict, setEmailConflict] = useState(false);

  const switchPath = (p) => {
    setPath(p);
    setErr("");
    setSent(false);
    setEmailConflict(false);
  };

  const send = async () => {
    setErr("");
    setEmailConflict(false);
    if (path === "create") {
      const { error } = await supabase.auth.updateUser(
        { email },
        { emailRedirectTo: window.location.origin }
      );
      if (error) {
        if (error.code === "email_exists" || error.message?.includes("already been registered")) {
          setEmailConflict(true);
        } else {
          setErr(error.message);
        }
      } else {
        setSent(true);
      }
    } else {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) setErr(error.message);
      else setSent(true);
    }
  };

  return (
    <div className="bg-amber-50 rounded-md border border-amber-200 shadow-md max-w-md mx-auto text-center overflow-hidden">
      <div className="px-4 py-3.5 border-b-2 border-stone-900 text-[13px] tracking-[0.3em] font-bold text-stone-900 font-serif">
        {path === "create" ? "SAVE YOUR PROGRESS" : "WELCOME BACK"}
      </div>

      {contextMessage && (
        <p className="px-5 pt-4 mb-0 text-[13px] text-stone-600 italic">{contextMessage}</p>
      )}

      <div className="flex border-b-2 border-stone-900">
        {[
          ["create", "NEW ACCOUNT"],
          ["signin", "SIGN IN"],
        ].map(([p, label]) => (
          <button
            key={p}
            type="button"
            onClick={() => switchPath(p)}
            className={
              "flex-1 py-2.5 font-serif text-[11px] tracking-[0.25em] font-bold focus:outline-none focus:ring-2 focus:ring-amber-500 " +
              (p === "create" ? "border-r border-stone-900 " : "") +
              (path === p ? "bg-amber-400 text-stone-900" : "bg-transparent text-stone-500 hover:text-stone-800")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {sent ? (
        <div className="p-6">
          <p className="mt-0 text-sm text-stone-700">
            {path === "create"
              ? "Check your email — click the link to lock in your voting history. Your rounds stay with you."
              : "Check your email for your sign-in link."}
          </p>
          {onDone && (
            <button
              type="button"
              onClick={onDone}
              className="mt-2 text-xs uppercase tracking-widest text-amber-800 border border-amber-700/60 rounded px-4 py-2 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              ← Back
            </button>
          )}
        </div>
      ) : (
        <div className="p-6">
          {path === "create" ? (
            <p className="mt-0 text-sm text-stone-700">
              Add an email to keep your board across devices. Your existing
              rounds stay with you — keeps your votes and your collection.
            </p>
          ) : (
            <p className="mt-0 text-sm text-stone-700">
              Send yourself a magic link to sign in to your existing account.
            </p>
          )}

          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            className="w-full box-border mt-3 px-3 py-2.5 font-serif text-sm bg-[#FFF9EC] border border-[#8A6A3A] text-stone-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
          />

          {err && <p className="text-red-700 text-[13px] mb-0 mt-2">{err}</p>}

          {emailConflict && (
            <p className="text-red-700 text-[13px] mb-0 mt-2">
              That email is already registered.{" "}
              <span
                className="text-amber-700 cursor-pointer underline"
                onClick={() => switchPath("signin")}
              >
                Sign in instead →
              </span>
            </p>
          )}

          <button
            type="button"
            onClick={send}
            disabled={!email}
            className="mt-3.5 bg-amber-400 text-stone-900 border-none px-8 py-3 font-serif text-[13px] tracking-[0.3em] font-bold hover:opacity-90 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-amber-500"
          >
            {path === "create" ? "SAVE MY BOARD" : "SEND SIGN-IN LINK"}
          </button>
        </div>
      )}
    </div>
  );
}

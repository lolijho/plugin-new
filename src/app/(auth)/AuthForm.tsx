"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isRegister = mode === "register";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isRegister ? { email, password, name } : { email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="card p-6">
      <h1 className="mb-4 text-lg font-semibold">
        {isRegister ? "Create your account" : "Sign in"}
      </h1>

      {isRegister && (
        <div className="mb-3">
          <label className="label">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
        </div>
      )}

      <div className="mb-3">
        <label className="label">Email</label>
        <input
          className="input"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </div>

      <div className="mb-4">
        <label className="label">Password</label>
        <input
          className="input"
          type="password"
          required
          minLength={isRegister ? 8 : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={isRegister ? "At least 8 characters" : "••••••••"}
        />
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

      <button className="btn-primary w-full" disabled={loading}>
        {loading ? "Please wait…" : isRegister ? "Create account" : "Sign in"}
      </button>

      <p className="mt-4 text-center text-sm text-[var(--color-muted)]">
        {isRegister ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-[var(--color-accent)] hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            No account yet?{" "}
            <Link href="/register" className="text-[var(--color-accent)] hover:underline">
              Register
            </Link>
          </>
        )}
      </p>
    </form>
  );
}

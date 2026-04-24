import Link from 'next/link';

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="text-4xl font-semibold tracking-tight">rhud</h1>
      <p className="mt-3 text-neutral-600">
        Scope-to-proposal automation. Sprint-1 skeleton — auth works, rest is stubs.
      </p>

      <div className="mt-10 space-y-2 text-sm">
        <Link href="/login" className="block underline underline-offset-4">
          /login
        </Link>
        <Link href="/dashboard" className="block underline underline-offset-4">
          /dashboard (auth-required placeholder)
        </Link>
      </div>
    </main>
  );
}

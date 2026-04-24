'use client';

import { useEffect, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

interface Me {
  sub: string;
  tid: string;
  role: string;
  email: string;
}

export default function Dashboard() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('rhud.token');
    if (!token) {
      setErr('no token — sign in first');
      return;
    }
    fetch(`${API}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then(setMe)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Placeholder. Real dashboard lands in a later sprint.
      </p>
      <pre className="mt-8 overflow-auto rounded bg-neutral-100 p-4 text-xs">
        {err ? err : JSON.stringify(me, null, 2)}
      </pre>
    </main>
  );
}

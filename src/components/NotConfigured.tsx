export default function NotConfigured({ missing }: { missing: string[] }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-5 text-slate-100">
      <section className="max-w-md space-y-3 text-center">
        <h1 className="text-xl font-bold">App is not configured</h1>
        <p className="text-sm text-slate-300">
          This build is missing required settings, so it cannot connect to its server.
          If you run this site, set the variables below and rebuild.
        </p>
        <ul className="text-sm text-slate-400">
          {missing.map((name) => <li key={name}><code>{name}</code></li>)}
        </ul>
      </section>
    </main>
  );
}

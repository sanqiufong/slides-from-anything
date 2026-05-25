import { HomeLibrary } from "@/components/HomeLibrary";
import { ImportQueue } from "@/components/ImportQueue";
import { IngestDrawer } from "@/components/IngestDrawer";
import { ModelStatusControl } from "@/components/ModelStatusControl";
import { ThemeToggle } from "@/components/ThemeToggle";
import { readCommunityAuth } from "@/lib/auth-storage";
import { fetchMySubmissions, fetchRegistry, type MySubmission, type RegistryEntry } from "@/lib/community-client";
import { listDesigns, readFavorites } from "@/lib/storage";
import type { IngestMode } from "@/lib/types";
import { Database } from "lucide-react";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ url?: string; mode?: string }>;
}) {
  const [{ url, mode }, designs, favoriteSet, communityAuth] = await Promise.all([
    searchParams,
    listDesigns(),
    readFavorites(),
    readCommunityAuth(),
  ]);
  const initialMode = mode === "clone-website" || mode === "design-system-project" ? (mode as IngestMode) : "url";
  const initialFavorites = [...favoriteSet];
  const communityLogin = communityAuth?.token ? communityAuth.login ?? null : null;
  // Fetch my submission history only when logged in. fetchMySubmissions silently
  // returns [] if not, but we skip the network round-trip when we already know.
  const mySubmissions: MySubmission[] = communityLogin ? await fetchMySubmissions().catch(() => []) : [];
  // Public registry is fetchable without login; show approved designs even if
  // user has never logged in. Network failures fall back to an empty list.
  const registry: RegistryEntry[] = communityAuth?.baseUrl ? await fetchRegistry({}).catch(() => []) : [];
  // Open the drawer automatically if the page was opened with ?url=... or ?mode=...
  const drawerInitialOpen = Boolean(url) || Boolean(mode);

  return (
    <div className="dv-app">
      {/* Sticky topbar: single dense row, never wraps. */}
      <header className="dv-topbar">
        <div className="flex min-w-0 flex-none items-center gap-2">
          <div
            className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-accent text-white shadow-[var(--shadow-xs)]"
            aria-hidden="true"
          >
            <Database size={15} strokeWidth={2.2} />
          </div>
          <span className="font-serif whitespace-nowrap text-[15px] font-semibold leading-none text-foreground">
            设计系统<span className="italic text-accent">库</span>
          </span>
        </div>

        <span className="flex-none whitespace-nowrap text-xs text-muted">
          <span className="tabular-nums font-semibold text-foreground">{designs.length}</span>
          <span className="ml-1">条记录</span>
        </span>

        <div className="ml-auto flex flex-none items-center gap-2">
          <IngestDrawer initialUrl={url} initialMode={initialMode} defaultOpen={drawerInitialOpen} />
          <div className="dv-topbar-divider" aria-hidden="true" />
          <ModelStatusControl />
          <div className="dv-topbar-divider" aria-hidden="true" />
          <ThemeToggle />
        </div>
      </header>

      {/* Library fills the whole content area */}
      <main className="dv-pane dv-pane-main" aria-label="设计资料库">
        <HomeLibrary
          designs={designs}
          initialFavorites={initialFavorites}
          communityLogin={communityLogin}
          mySubmissions={mySubmissions}
          remoteEntries={registry}
          communityBaseUrl={communityAuth?.baseUrl ?? null}
        />
      </main>

      <ImportQueue />
    </div>
  );
}

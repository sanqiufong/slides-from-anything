import { headers } from "next/headers";

import { env } from "@/lib/env";
import { listRegistry } from "@/lib/registry";

export const dynamic = "force-dynamic";

export default async function Home() {
  const designs = await listRegistry({}).catch(() => []);
  const h = await headers();
  const host = h.get("host") ?? env.publicBaseUrl;

  return (
    <main>
      <p className="eyebrow">Design Vault · 社区目录</p>
      <h1>来自社区的设计系统</h1>
      <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
        审核通过的设计系统在这里展示。本地 Design Vault 客户端可以从这里搜索、下载、一键安装。
      </p>

      <div className="row" style={{ marginTop: 24, gap: 16 }}>
        <span className="badge muted">已收录 {designs.length} 个</span>
        <span className="badge muted">服务: {host}</span>
        <a className="button" href="/admin">管理后台</a>
      </div>

      <h2>已发布</h2>
      {designs.length === 0 ? (
        <div className="card" style={{ color: "var(--muted)" }}>
          还没有任何设计被审核通过。当发布者上传第一个 bundle 并通过审核后，会出现在这里。
        </div>
      ) : (
        designs.map((entry) => (
          <article className="card" key={entry.slug}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <p className="eyebrow">{entry.manifest.sourceHost || entry.slug}</p>
                <h3 style={{ margin: "4px 0 0", fontSize: 18 }}>{entry.title}</h3>
              </div>
              <div className="row">
                {entry.archetype ? <span className="badge">{entry.archetype}</span> : null}
                {typeof entry.qualityScore === "number" ? (
                  <span className="badge muted">质量 {entry.qualityScore}/100</span>
                ) : null}
                <span className="badge muted">{(entry.bundleBytes / 1024).toFixed(0)} KB</span>
              </div>
            </div>
            <p style={{ color: "var(--muted)", margin: "12px 0 0", lineHeight: 1.5 }}>{entry.summary}</p>
            <div className="row" style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
              <span>by @{entry.publisher.login}</span>
              <span>·</span>
              <span>↓ {entry.downloads} 次下载</span>
              <span>·</span>
              <a href={`/api/registry/${entry.slug}/bundle`} download>
                下载 .tgz
              </a>
              <span>·</span>
              <a href={`/api/registry/${entry.slug}`}>JSON</a>
            </div>
          </article>
        ))
      )}
    </main>
  );
}

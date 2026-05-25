"use client";

import { useState } from "react";

import { ScaledPreviewFrame } from "@/components/ScaledPreviewFrame";

type PreviewKind = "card" | "style" | "web" | "ppt";

const PREVIEW_CANVAS: Record<PreviewKind, { w: number; h: number }> = {
  card: { w: 800, h: 500 },
  style: { w: 800, h: 500 },
  web: { w: 1280, h: 800 },
  ppt: { w: 1920, h: 1080 },
};

type QueueItem = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  status: string;
  qualityScore: number | null;
  qualityGrade: string | null;
  bundleBytes: number;
  bundleSha256: string;
  submittedAt: string;
  reviewedAt: string | null;
  publisher: { login: string; displayName: string | null };
};

function fmtCstTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${shifted.getUTCFullYear()}/${pad(shifted.getUTCMonth() + 1)}/${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

export function AdminQueue({ initial, status }: { initial: QueueItem[]; status: string }) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewKindByItem, setPreviewKindByItem] = useState<Record<string, PreviewKind>>({});

  async function call(id: string, action: "approve" | "reject", note?: string) {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/submissions/${id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: note ?? "" }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || `${action} failed`);
      }
      setItems((current) => current.filter((entry) => entry.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="card" style={{ marginTop: 16, color: "var(--muted)" }}>
        {status === "pending" ? "队列空着。" : `没有 ${status} 状态的提交。`}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      {error ? (
        <div className="card" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
          {error}
        </div>
      ) : null}
      {items.map((item) => {
        const kind = previewKindByItem[item.id] ?? "card";
        return (
          <article className="card" key={item.id} style={{ display: "grid", gap: 16 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <p className="eyebrow">@{item.publisher.login} · {item.slug}</p>
                <h3 style={{ margin: "4px 0 0", fontSize: 20 }}>{item.title}</h3>
                <p style={{ color: "var(--muted)", margin: "10px 0 0", lineHeight: 1.5, fontSize: 13 }}>{item.summary}</p>
              </div>
              <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 280 }}>
                {item.qualityScore != null ? <span className="badge muted">质量 {item.qualityScore}/100</span> : null}
                <span className="badge muted">{(item.bundleBytes / 1024).toFixed(0)} KB</span>
                <span className="badge muted" title={item.bundleSha256}>{item.bundleSha256.slice(0, 10)}</span>
              </div>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              <div className="row" style={{ fontSize: 12, color: "var(--muted)", gap: 8 }}>
                <strong style={{ fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.12em" }}>预览</strong>
                {(["card", "style", "web", "ppt"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={kind === k ? "primary" : ""}
                    style={{ padding: "2px 10px", fontSize: 11, height: 24 }}
                    onClick={() => setPreviewKindByItem((current) => ({ ...current, [item.id]: k }))}
                  >
                    {k === "card" ? "样张" : k === "style" ? "STYLE_CARD" : k === "web" ? "网页" : "PPT"}
                  </button>
                ))}
              </div>
              <ScaledPreviewFrame
                src={`/api/admin/submissions/${item.id}/preview?kind=${kind}`}
                title={`${item.title} ${kind} preview`}
                ariaLabel={`${item.title} ${kind} preview`}
                canvasWidth={PREVIEW_CANVAS[kind].w}
                canvasHeight={PREVIEW_CANVAS[kind].h}
                style={{
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  colorScheme: "light",
                }}
              />
            </div>

            <div className="row" style={{ fontSize: 12, color: "var(--muted)" }}>
              <a href={`/api/registry/${item.slug}/bundle`} target="_blank" rel="noreferrer">
                下载 bundle (.tgz)
              </a>
              <span>·</span>
              <span>提交 {fmtCstTimestamp(item.submittedAt)}</span>
            </div>

            {status === "pending" ? (
              <div className="row" style={{ marginTop: 4 }}>
                <button
                  className="primary"
                  disabled={busy === item.id}
                  onClick={() => call(item.id, "approve")}
                  type="button"
                >
                  {busy === item.id ? "处理中" : "通过"}
                </button>
                <button
                  className="danger"
                  disabled={busy === item.id}
                  onClick={() => {
                    const note = window.prompt("说明拒绝原因（必填）");
                    if (note && note.trim()) void call(item.id, "reject", note.trim());
                  }}
                  type="button"
                >
                  拒绝
                </button>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

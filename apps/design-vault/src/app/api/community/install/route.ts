import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NextResponse } from "next/server";

import { installBundle } from "@/lib/community";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BUNDLE_BYTES = 80 * 1024 * 1024;

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "请通过 multipart/form-data 提交 bundle 文件。" }, { status: 400 });
  }
  const entry = formData.get("bundle");
  if (!(entry instanceof File)) {
    return NextResponse.json({ error: "缺少 bundle 文件字段。" }, { status: 400 });
  }
  if (entry.size <= 0) {
    return NextResponse.json({ error: "上传的 bundle 文件为空。" }, { status: 400 });
  }
  if (entry.size > MAX_BUNDLE_BYTES) {
    return NextResponse.json(
      { error: `Bundle 体积超过 ${(MAX_BUNDLE_BYTES / 1024 / 1024).toFixed(0)}MB 上限。` },
      { status: 413 },
    );
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "design-vault-upload-"));
  const safeName = entry.name && /\.(tgz|tar\.gz)$/i.test(entry.name) ? entry.name : "bundle.tgz";
  const tarPath = path.join(tempDir, safeName);
  try {
    const buffer = Buffer.from(await entry.arrayBuffer());
    await writeFile(tarPath, buffer);
    const result = await installBundle(tarPath, { sourceLabel: entry.name || safeName });
    return NextResponse.json(
      {
        ok: true,
        slug: result.slug,
        upstreamSlug: result.upstreamSlug,
        title: result.title,
        designDir: result.designDir,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "导入社区包失败。" },
      { status: 400 },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

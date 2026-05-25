import path from "node:path";

import { installBundle } from "../src/lib/community";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: pnpm install-bundle <path-to-bundle.tgz>");
    process.exit(1);
  }
  const tarPath = path.resolve(process.cwd(), arg);
  try {
    const result = await installBundle(tarPath, { sourceLabel: path.basename(tarPath) });
    console.log(`✓ Installed ${result.title}`);
    console.log(`  Slug:        ${result.slug}`);
    console.log(`  Upstream:    ${result.upstreamSlug}`);
    console.log(`  Destination: ${result.designDir}`);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();

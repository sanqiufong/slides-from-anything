import { bundleDesign } from "../src/lib/community";

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: pnpm publish-design <slug>");
    process.exit(1);
  }
  try {
    const result = await bundleDesign(slug);
    console.log(`✓ Published ${result.title} (${result.slug}) v${result.version}`);
    console.log(`  Bundle: ${result.bundlePath}`);
    console.log(`  Size:   ${formatBytes(result.bytes)}`);
    console.log(`  Quality: ${result.submission.qualityScore ?? "n/a"}/100 (${result.submission.qualityGrade ?? "unknown"})`);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();

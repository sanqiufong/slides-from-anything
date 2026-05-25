import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyBundledResourceTrees } from "../src/resources.js";

describe("copyBundledResourceTrees", () => {
  it("includes prompt templates", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-tools-pack-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "resources");

    try {
      const promptTemplatePath = join(
        workspaceRoot,
        "prompt-templates",
        "image",
        "sample.json",
      );
      await mkdir(join(workspaceRoot, "skills", "sample"), { recursive: true });
      await mkdir(join(workspaceRoot, "design-systems", "sample"), {
        recursive: true,
      });
      await mkdir(
        join(workspaceRoot, "design-vault", "data", "designs", "sample-design"),
        { recursive: true },
      );
      await mkdir(join(workspaceRoot, "craft", "sample"), { recursive: true });
      await mkdir(join(workspaceRoot, "assets", "frames"), { recursive: true });
      await mkdir(join(workspaceRoot, "prompt-templates", "image"), {
        recursive: true,
      });
      await writeFile(promptTemplatePath, "{\"id\":\"sample\"}\n", "utf8");
      await writeFile(
        join(
          workspaceRoot,
          "design-vault",
          "data",
          "designs",
          "sample-design",
          "meta.json",
        ),
        "{\"slug\":\"sample-design\"}\n",
        "utf8",
      );

      await copyBundledResourceTrees({ workspaceRoot, resourceRoot });

      await expect(
        readFile(
          join(resourceRoot, "prompt-templates", "image", "sample.json"),
          "utf8",
        ),
      ).resolves.toBe("{\"id\":\"sample\"}\n");
      await expect(
        readFile(
          join(
            resourceRoot,
            "design-vault",
            "data",
            "designs",
            "sample-design",
            "meta.json",
          ),
          "utf8",
        ),
      ).resolves.toBe("{\"slug\":\"sample-design\"}\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

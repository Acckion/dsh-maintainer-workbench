import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { collectPatch, git } from "../../core/git.ts";

/** Inspect even an interrupted workspace without changing the Agent's real index. */
export async function inspectTree(
  path: string,
  base: string,
): Promise<{ patch: string; treeHash: string }> {
  const temporary = await mkdtemp(join(tmpdir(), "maintainer-inspection-")),
    index = join(temporary, "index");
  try {
    const original = resolve(
      path,
      await git(path, ["rev-parse", "--git-path", "index"]),
    );
    try {
      await copyFile(original, index);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await git(
        path,
        ["read-tree", "HEAD"],
        false,
        undefined,
        30000,
        false,
        index,
      );
    }
    const patch = await collectPatch(path, base, false, index);
    return {
      patch,
      treeHash: await git(
        path,
        ["write-tree"],
        false,
        undefined,
        30000,
        false,
        index,
      ),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

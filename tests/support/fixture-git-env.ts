import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixture git operations must not inherit the host's global/system git config
// (core.autocrlf, protocol.allow, url rewrites, credential helpers). Route the
// whole test process at an isolated empty global config; tests that need
// explicit settings still pass them with -c flags.
const dir = mkdtempSync(join(tmpdir(), "mw-git-env-"));
const file = join(dir, "gitconfig");
writeFileSync(file, "[init]\n\tdefaultBranch = main\n");
process.env.GIT_CONFIG_GLOBAL = file;
process.env.GIT_CONFIG_NOSYSTEM = "1";
// Temp fixtures must not resolve to an enclosing repository outside %TEMP%
// (for example a user home directory that is itself a git checkout), which
// would flip "folder" fixtures to "git" and graft foreign remotes onto them.
process.env.GIT_CEILING_DIRECTORIES = tmpdir();

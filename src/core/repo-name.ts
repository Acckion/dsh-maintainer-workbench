const REPO_NAME = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/;

/**
 * Accepts owner/repo, GitHub URLs (with protocol, host, path, query, .git
 * suffix in any case) and ssh/SCP-style git@github.com:owner/repo links.
 * Returns the lowercase owner/repo, or undefined when the input is not a
 * GitHub repository name.
 */
export function normalizeRepoName(input: string): string | undefined {
  let value = input.trim();
  if (!value) return undefined;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  let github = false;
  value = value.replace(
    /^(?:[^/@]+@)?(?:www\.)?github\.com(?::|\/|$)/i,
    () => {
      github = true;
      return "";
    },
  );
  value = value.split(/[?#]/)[0].replace(/\/+$/, "");
  if (github) value = value.split("/").filter(Boolean).slice(0, 2).join("/");
  else {
    const segments = value.split("/").filter(Boolean);
    if (segments.length > 2 && !segments[0].includes("."))
      value = segments.slice(0, 2).join("/");
  }
  value = value.replace(/\.git$/i, "").toLowerCase();
  return REPO_NAME.test(value) ? value : undefined;
}

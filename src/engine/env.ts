export type CredentialKind = "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN" | "none";

/**
 * Child environment: GITHUB_TOKEN injected, exactly one Anthropic credential.
 * ANTHROPIC_API_KEY wins and CLAUDE_CODE_OAUTH_TOKEN is stripped.
 */
export function buildChildEnv(
  base: Record<string, string | undefined>,
  githubToken: string,
): { env: Record<string, string>; credential: CredentialKind } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) env[k] = v;
  }
  env.GITHUB_TOKEN = githubToken;
  let credential: CredentialKind = "none";
  if (env.ANTHROPIC_API_KEY) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    credential = "ANTHROPIC_API_KEY";
  } else {
    delete env.ANTHROPIC_API_KEY;
    if (env.CLAUDE_CODE_OAUTH_TOKEN) credential = "CLAUDE_CODE_OAUTH_TOKEN";
    else delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  return { env, credential };
}

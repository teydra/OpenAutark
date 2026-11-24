// Is an OpenAI-compatible key's address Alibaba DashScope – the host of Qwen's Token Plan, which runs here as an agent tool only?
// The settings row shows the Qwen Token Plan note under "Plan credits" only for such a key (24.11.2026, Felix review: DeepSeek or
// OpenRouter keys with the switch got it too). Hosts: dashscope.aliyuncs.com and dashscope-intl.aliyuncs.com (the catalog's Qwen
// entry, providers-connect.ts), and their subdomains. Nothing else on aliyuncs.com counts.
// Owns: this host test. Never: the account, the UI or any network call.

const DASHSCOPE_HOSTS: readonly string[] = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'];

/** True when the base address's host is a DashScope host (or a subdomain of one); an empty or unreadable address is not.
 *  The host is read by pattern, as externalSocketUrls does – the shared build has no URL type. */
export function isDashScopeBaseUrl(baseUrl: string | undefined | null): boolean {
  const parsed = baseUrl ? /^https?:\/\/(?:[^/?#@\s]*@)?([^/?#:\s]+)(?::\d+)?(?=[/?#]|$)/i.exec(baseUrl.trim()) : null;
  if (!parsed) return false;
  const host = parsed[1].toLowerCase();
  return DASHSCOPE_HOSTS.some((known) => host === known || host.endsWith(`.${known}`));
}

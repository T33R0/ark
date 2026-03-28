// ============================================================================
// Ark — Native HTTP Fetch Tool
// ============================================================================

import type { RegisteredTool } from '../types.js';

export const httpFetchTool: RegisteredTool = {
  definition: {
    name: 'http_fetch',
    description: 'Fetch a URL and return its content. Supports GET/POST/PUT/DELETE.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        method: { type: 'string', description: 'HTTP method (default: GET)', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
        headers: { type: 'object', description: 'Request headers' },
        body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
      },
      required: ['url'],
    },
  },
  async execute(args) {
    const url = args.url as string;
    const method = (args.method as string) || 'GET';
    const timeout = (args.timeout as number) || 30000;

    // SSRF protection: block private/internal IPs
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;
      if (isPrivateHost(hostname)) {
        return {
          content: `Blocked: "${hostname}" resolves to a private/internal address. http_fetch cannot access private networks.`,
          is_error: true,
        };
      }
    } catch {
      return { content: `Invalid URL: ${url}`, is_error: true };
    }

    try {
      const fetchOptions: RequestInit = {
        method,
        headers: (args.headers as Record<string, string>) || {},
        signal: AbortSignal.timeout(timeout),
      };

      if (args.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        fetchOptions.body = args.body as string;
      }

      const res = await fetch(url, fetchOptions);
      const contentType = res.headers.get('content-type') || '';
      let body: string;

      if (contentType.includes('application/json')) {
        const json = await res.json();
        body = JSON.stringify(json, null, 2);
      } else {
        body = await res.text();
      }

      // Truncate very large responses
      const maxLen = 50000;
      if (body.length > maxLen) {
        body = body.slice(0, maxLen) + `\n\n... (truncated, ${body.length} total chars)`;
      }

      return {
        content: `HTTP ${res.status} ${res.statusText}\n\n${body}`,
        is_error: res.status >= 400,
        metadata: {
          status: res.status,
          content_type: contentType,
          size: body.length,
        },
      };
    } catch (err) {
      return {
        content: `HTTP fetch failed: ${(err as Error).message}`,
        is_error: true,
      };
    }
  },
};

/** Block requests to private/internal network addresses */
function isPrivateHost(hostname: string): boolean {
  // IPv4 private ranges
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;       // link-local
  if (/^0\./.test(hostname)) return true;

  // IPv6 private
  if (hostname === '::1' || hostname === '[::1]') return true;
  if (/^f[cd]/i.test(hostname)) return true;            // fc00::/7
  if (/^fe80/i.test(hostname)) return true;             // link-local

  // Common internal hostnames
  if (hostname === 'localhost') return true;
  if (hostname === 'metadata.google.internal') return true;
  if (hostname === '169.254.169.254') return true;      // cloud metadata

  return false;
}

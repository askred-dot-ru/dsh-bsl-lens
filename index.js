/**
 * BSL Lens — host half.
 *
 * The browser half renders a 1C:Enterprise (BSL) document preview in the
 * Sidebar, and that stays a browser concern. This half exists for one thing the
 * page cannot do itself: read a routine from cfsmcp2.
 *
 * The MCP server listens on its own port and sends no CORS headers, so a page
 * served by the GUI cannot call it. The host can, and it already owns an
 * authenticated same-origin route surface, so it exposes one exact route:
 *
 *   GET /api/bsl-external/method?module=<Модуль>&method=<Метод>[&context=<контекст>]
 *        → `{ found: true, module, method, kind, line, signature, source }`
 *          or `{ found: false, reason }` with 404 when cfsmcp2 knows no such routine
 *
 * The browser half calls it when a `Модуль.Метод()` reference is clicked and
 * shows the returned source with the same palette it uses for the open file.
 *
 * @module dsh-bsl-lens
 */

import { createBridge } from './bridge.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bsl-lens';

/** The route is served by Connection; nothing else is needed. */
export const inject = ['connection'];

/** The one exact Fetch route this plugin adds. */
const ROUTE_PATH = '/api/bsl-external/method';

/** Where cfsmcp2 listens when the row says nothing. */
const DEFAULT_MCP_HOST = '127.0.0.1';
/** Port cfsmcp2 uses out of the box; override it with `mcpPort`. */
const DEFAULT_MCP_PORT = 8559;
/** The MCP endpoint path every cfsmcp2 serves. */
const MCP_PATH = '/mcp/';
/** Context a lookup falls back to; override it with `context` in the row's config. */
const DEFAULT_CONTEXT = 'p0';

/**
 * A JSON response the page can read.
 * @param value - the payload.
 * @param status - the HTTP status.
 * @returns the response.
 */
function json(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Read a port from the row, accepting a number or a numeric string.
 *
 * @param value - the raw value.
 * @returns the port, or null when the value is not a usable port.
 */
function readPort(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const port = Number(String(value).trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * Resolve the row's configuration.
 *
 * cfsmcp2 does not have to sit on this machine, and it does not have to use the
 * default port: the row can name the endpoint either as a whole URL or as a
 * host plus a port.
 *
 *   mcpUrl   full endpoint, e.g. `http://10.0.0.5:8600/mcp/` (wins over the rest)
 *   mcpHost  host name or address (default `127.0.0.1`)
 *   mcpPort  port (default `8559`)
 *   context  dump context the page does not know (default `p0`)
 *
 * @param config - the row's raw configuration.
 * @returns `{ mcpUrl, context }` with a normalised endpoint.
 */
export function readConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};

  let mcpUrl = null;
  if (typeof raw.mcpUrl === 'string' && raw.mcpUrl.trim() !== '') {
    mcpUrl = raw.mcpUrl.trim();
  } else if (typeof raw.mcpPort === 'string' && /^\S+:\d+$/.test(raw.mcpPort.trim())) {
    // A shorthand some people write: `host:port` in the port field.
    const [host, port] = raw.mcpPort.trim().split(':');
    mcpUrl = `http://${host}:${port}${MCP_PATH}`;
  } else {
    const port = readPort(raw.mcpPort) ?? DEFAULT_MCP_PORT;
    const host = typeof raw.mcpHost === 'string' && raw.mcpHost.trim() !== '' ? raw.mcpHost.trim() : DEFAULT_MCP_HOST;
    mcpUrl = `http://${host}:${port}${MCP_PATH}`;
  }

  // Accept `…:8559`, `…:8559/mcp` and `…:8559/mcp/` alike; the canonical form is
  // `…/mcp/`, which is what cfsmcp2 itself advertises.
  if (!mcpUrl.includes('://')) mcpUrl = `http://${mcpUrl}`;
  if (/\/mcp$/.test(mcpUrl)) mcpUrl = `${mcpUrl}/`;
  if (!/\/mcp\/$/.test(mcpUrl)) mcpUrl = `${mcpUrl.replace(/\/+$/, '')}${MCP_PATH}`;

  const context = typeof raw.context === 'string' && raw.context.trim() !== '' ? raw.context.trim() : DEFAULT_CONTEXT;
  return { mcpUrl, context };
}

/**
 * Register the route.
 * @param ctx - Host context carrying the Connection service.
 * @param config - the row's raw configuration.
 */
export function apply(ctx, config) {
  const resolved = readConfig(config);
  const connection = ctx.connection;
  if (connection === undefined || connection === null) return;

  const bridge = createBridge({ url: resolved.mcpUrl });

  connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const params = new URL(request.url).searchParams;
      const module = params.get('module') ?? '';
      const method = params.get('method') ?? '';
      const context = params.get('context') ?? resolved.context;
      try {
        const answer = await bridge.resolveMethod({ context, module, method });
        return json(answer, answer.found === true ? 200 : 404);
      } catch (error) {
        return json({ found: false, reason: String(error?.message ?? error) }, 502);
      }
    },
  });
}

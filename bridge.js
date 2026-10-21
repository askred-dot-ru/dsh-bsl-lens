/**
 * BSL Lens — MCP bridge (host half).
 *
 * The browser half cannot reach the cfsmcp2 MCP server: that server listens on
 * another port and sends no CORS headers, so a page at `127.0.0.1:<gui>` cannot
 * call `127.0.0.1:8559`. The host half can, and it already owns an authenticated
 * same-origin route surface, so it proxies the two calls the preview needs:
 *
 *   GET /api/bsl-external/method?context=p0&module=X&method=Y
 *        → the routine's source, resolved through cfsmcp2
 *
 * The MCP client here is deliberately small: streamable-HTTP JSON-RPC with a
 * cached session id, one retry when the server forgets the session, and a short
 * timeout. Nothing is cached for long: the dump can change under the index.
 *
 * @module dsh-bsl-lens/bridge
 */

/** Default MCP endpoint of cfsmcp2 (see the profile's cordis patch). */
const DEFAULT_URL = 'http://127.0.0.1:8559/mcp/';
/** Per-request timeout: the local server answers in milliseconds or not at all. */
const TIMEOUT_MS = 8000;

/** The JSON-RPC ids we send; the counter only keeps answers apart. */
let requestId = 0;

/**
 * Parses a streamable-HTTP body.
 *
 * The server answers either a JSON document or an SSE stream whose `data:`
 * lines carry the JSON-RPC frames. Both are normalised to a list of messages.
 *
 * @param text - the raw body.
 * @returns the JSON-RPC messages it carried.
 */
function parseBody(text) {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }
  const messages = [];
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      messages.push(JSON.parse(payload));
    } catch {
      /* a partial or non-JSON frame is simply not a message */
    }
  }
  return messages;
}

/**
 * One MCP session against cfsmcp2.
 *
 * `initialize` opens it and hands back the session id the server wants echoed;
 * `call` runs a tool. A session the server has dropped is reopened once, which is
 * what keeps the bridge working after the MCP server restarts.
 */
class McpSession {
  /**
   * @param options - `{ url }` of the MCP endpoint.
   */
  constructor(options) {
    this.url = options.url;
    this.sessionId = null;
    this.ready = null;
  }

  /**
   * POST a JSON-RPC frame.
   * @param payload - the frame.
   * @returns `{ messages, sessionId }`.
   */
  async post(payload, sessionId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      if (sessionId !== null && sessionId !== undefined) headers['mcp-session-id'] = sessionId;
      let response;
      try {
        response = await fetch(this.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        // The port, the host or the server is wrong — say which endpoint failed,
        // because the page shows this text as-is.
        throw new Error(`${this.url} не отвечает (${error?.message ?? error})`);
      }
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`MCP ${response.status}: ${text.slice(0, 200)}`);
      }
      return {
        messages: parseBody(text),
        sessionId: response.headers.get('mcp-session-id') ?? sessionId ?? null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Open the session once; concurrent callers share the same promise. */
  async open() {
    if (this.ready !== null) return this.ready;
    this.ready = (async () => {
      const { messages, sessionId } = await this.post({
        jsonrpc: '2.0',
        id: (requestId += 1),
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'dsh-bsl-lens', version: '1.0.0' },
        },
      });
      const failure = messages.find((message) => message.error !== undefined);
      if (failure !== undefined) throw new Error(`MCP initialize failed: ${failure.error.message}`);
      this.sessionId = sessionId;
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, this.sessionId);
      return this;
    })();
    try {
      return await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  /**
   * Call a tool and return its first text block, parsed as JSON when it is JSON.
   * @param name - the tool name.
   * @param args - its arguments.
   * @returns the parsed result.
   */
  async call(name, args) {
    await this.open();
    const run = async (sessionId) => {
      const { messages } = await this.post({
        jsonrpc: '2.0',
        id: (requestId += 1),
        method: 'tools/call',
        params: { name, arguments: args },
      }, sessionId);
      const answer = messages.find((message) => message.id !== undefined && message.result !== undefined)
        ?? messages.find((message) => message.error !== undefined);
      if (answer === undefined) throw new Error('MCP returned no result');
      if (answer.error !== undefined) throw new Error(`MCP ${answer.error.message}`);
      const blocks = answer.result.content ?? [];
      const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
      if (answer.result.isError === true) throw new Error(text.slice(0, 300) || `${name} failed`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    try {
      return await run(this.sessionId);
    } catch (error) {
      const message = String(error.message ?? error);
      if (!message.includes('MCP 404')) throw error;
      // The server forgot the session: open a new one and try once more.
      this.ready = null;
      this.sessionId = null;
      await this.open();
      return run(this.sessionId);
    }
  }
}

/**
 * The cfsmcp2 path of a common-module routine.
 * @param module - module name, e.g. `актив_Бюджетирование_ПоЗатратамНаВыпуск`.
 * @param method - routine name.
 * @returns the path `get_method` expects.
 */
function methodPath(module, method) {
  return `ОбщиеМодули.${module}.Методы.Module.${method}`;
}

/**
 * Resolve one routine and return what the preview needs.
 *
 * It asks `find_methods` first (scoped to the module) so the answer carries the
 * canonical path and signature; a direct `get_method` is the fallback for a
 * module the search does not index.
 *
 * @param session - the MCP session.
 * @param query - `{ context, module, method }`.
 * @returns the routine, or `{ found: false, reason }`.
 */
export async function resolveMethod(session, query) {
  const context = query.context === undefined ? 'p0' : query.context;
  const module = String(query.module ?? '');
  const method = String(query.method ?? '');
  if (module === '' || method === '') return { found: false, reason: 'module and method are required' };

  let path = methodPath(module, method);
  let kind = null;
  let signature = null;
  try {
    const found = await session.call('find_methods', {
      context,
      query: method,
      parent_path: `ОбщиеМодули.${module}`,
      limit: 5,
    });
    const hits = Array.isArray(found) ? [] : (found.methods ?? []);
    const exact = hits.find((hit) => String(hit.name ?? '').toLowerCase() === method.toLowerCase());
    if (exact !== undefined) {
      path = exact.path ?? path;
      kind = exact.kind ?? null;
      signature = exact.signature ?? null;
    }
  } catch (error) {
    // A search failure is not fatal: the direct path may still work.
  }

  let detail;
  try {
    detail = await session.call('get_method', { context, path });
  } catch (error) {
    return { found: false, reason: String(error.message ?? error), path };
  }
  if (detail === null || typeof detail !== 'object' || typeof detail.body !== 'string') {
    return { found: false, reason: 'get_method returned no body', path };
  }

  const header = detail.signature ?? signature ?? '';
  const body = detail.body;
  return {
    found: true,
    context: detail.context ?? context,
    module,
    method: detail.name ?? method,
    path,
    kind: String(kind ?? (header.trim().toLowerCase().startsWith('функция') ? 'function' : 'procedure')).toLowerCase(),
    signature: header.trim(),
    line: detail.line ?? 1,
    source: header === '' ? body : `${header.replace(/\r?\n/g, '')}\n${body}`,
  };
}

/**
 * Build the bridge: one cached MCP session and the lookup the route serves.
 *
 * @param options - `{ url }` of the MCP endpoint.
 * @returns `{ resolveMethod }`.
 */
export function createBridge(options = {}) {
  const session = new McpSession({ url: options.url ?? DEFAULT_URL });
  return {
    /**
     * The routine the page asked about.
     * @param query - `{ context, module, method }`.
     */
    resolveMethod: (query) => resolveMethod(session, query),
  };
}

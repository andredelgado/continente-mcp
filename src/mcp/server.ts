import { McpServer, ProtocolError, ProtocolErrorCode, isCallToolResult } from '@modelcontextprotocol/server';
import type { CallToolResult, GetPromptResult, ToolAnnotations, Transport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { OperationExecutionErrorSchema, RecoverySchema } from './contracts.js';
import { checkRequest, inRequest, RequestScope, RequestStopped } from '../session/request.js';
import type { RequestOptions } from '../session/request.js';

export interface ToolHandler {
  readonly definition: { name: string; title?: string; description?: string; annotations?: ToolAnnotations; _meta?: Record<string, unknown> };
  readonly inputSchema: z.ZodType;
  readonly outputSchema?: z.ZodType;
  readonly cartMutation?: boolean;
  readonly recoveryAction?: 'get_cart' | 'get_checkout_summary' | 'list_pickup_slots';
  readonly recoveryInput?: (input: unknown) => unknown;
  execute(input: unknown): Promise<CallToolResult>;
}
/** A prompt template. Every argument is an optional string, as MCP prompt arguments are strings. */
export interface PromptHandler {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: Readonly<Record<string, string>>;
  render(args: Readonly<Record<string, string | undefined>>): GetPromptResult;
}
/** A fixed text resource, such as an MCP Apps view. */
export interface ResourceHandler {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType: string;
  readonly text: string;
  readonly meta?: Record<string, unknown>;
}
export interface McpServerOptions {
  readonly version: string;
  readonly tools: readonly ToolHandler[];
  readonly prompts?: readonly PromptHandler[];
  readonly resources?: readonly ResourceHandler[];
  /** Usage guidance sent to clients when they connect. */
  readonly instructions?: string;
  readonly closeResources?: () => Promise<void>;
  readonly requestTimeoutMs?: number;
}
/** The `result` envelope every tool returns in its structured content. */
const structuredResult = (result: CallToolResult) => (result.structuredContent as { result?: { status?: string } } | undefined)?.result;
export class ContinenteMcpServer {
  private readonly server: McpServer;
  private readonly handlers = new Map<string, ToolHandler>();
  private cleanup: Promise<void> | undefined;
  private readonly shutdown = new AbortController();
  constructor(private readonly options: McpServerOptions) {
    this.server = new McpServer({ name: 'continentept-mcp', version: options.version },
      { capabilities: { tools: {} }, ...(options.instructions ? { instructions: options.instructions } : {}) });
    for (const handler of options.tools) {
      if (this.handlers.has(handler.definition.name)) throw new Error(`Duplicate tool: ${handler.definition.name}`);
      this.handlers.set(handler.definition.name, handler);
    }
    this.server.server.onclose = () => { this.shutdown.abort(new RequestStopped('server_closed')); void this.closeResources().catch(() => {}); };
    this.registerTools();
    this.registerPrompts();
    this.registerResources();
  }
  private registerResources(): void {
    for (const resource of this.options.resources ?? []) {
      const { uri, name, title, description, mimeType, text, meta } = resource;
      this.server.registerResource(name, uri, { mimeType, ...(title ? { title } : {}), ...(description ? { description } : {}) },
        async () => ({ contents: [{ uri, mimeType, text, ...(meta ? { _meta: meta } : {}) }] }));
    }
  }
  private registerPrompts(): void {
    for (const prompt of this.options.prompts ?? []) {
      const argsSchema = Object.fromEntries(Object.entries(prompt.arguments ?? {})
        .map(([name, description]) => [name, z.string().optional().describe(description)]));
      this.server.registerPrompt(prompt.name, { ...(prompt.title ? { title: prompt.title } : {}),
        ...(prompt.description ? { description: prompt.description } : {}), argsSchema },
      args => prompt.render(args as Record<string, string | undefined>));
    }
  }
  private registerTools(): void {
    if (!this.handlers.size) this.server.server.setRequestHandler('tools/list', async () => ({ tools: [] }));
    for (const handler of this.handlers.values()) {
      const { name, ...metadata } = handler.definition;
      this.server.registerTool(name, { ...metadata, inputSchema: handler.inputSchema,
        ...(handler.outputSchema ? { outputSchema: handler.outputSchema } : {}) },
      input => this.dispatchToolCall(name, input));
    }
    // Replace the SDK's tools/call handler: it turns argument errors into text-only tool results
    // and skips output validation for errors.
    this.server.server.setRequestHandler('tools/call', (request, ctx) => {
      // Task-augmented calls would run as ordinary calls here; refuse them, as no task support is advertised.
      if ((request.params as { task?: unknown }).task !== undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task execution is not supported');
      const progressToken = request.params._meta?.progressToken;
      return this.dispatchToolCall(request.params.name, request.params.arguments ?? {}, { signal: ctx.mcpReq.signal,
        ...(progressToken === undefined ? {} : { onProgress: progress => {
          void ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken,
            progress: progress.completed, ...(progress.total === undefined ? {} : { total: progress.total }), message: progress.message } }).catch(() => {});
        } }),
      });
    });
  }
  async dispatchToolCall(name: string, input: unknown = {}, options: RequestOptions = {}): Promise<CallToolResult> {
    const scope = new RequestScope({ ...options, timeoutMs: options.timeoutMs ?? this.options.requestTimeoutMs ?? 45000,
      signal: options.signal ? AbortSignal.any([options.signal, this.shutdown.signal]) : this.shutdown.signal });
    try { return await inRequest(scope, () => this.execute(name, input, scope)); }
    finally { scope.dispose(); }
  }
  private async execute(name: string, input: unknown, scope: RequestScope): Promise<CallToolResult> {
    const handler = this.handlers.get(name);
    if (!handler) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No tool named "${name}"`);
    const parsed = handler.inputSchema.safeParse(input);
    if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for ${name}`, {
      issues: parsed.error.issues.map(issue => ({ path: issue.path.map(String).join('.'), code: issue.code })),
    });
    let result: CallToolResult;
    const recovery = this.recoveryFor(handler, parsed.data);
    try {
      checkRequest();
      result = await handler.execute(parsed.data);
      if (scope.signal.aborted && structuredResult(result)?.status !== 'partial') throw scope.signal.reason;
    } catch (error) {
      if (error instanceof RequestStopped) return this.executionError(error.code, handler.cartMutation === true,
        scope.writeAttempted ? 'unknown' : 'not_applied', recovery);
      return this.executionError('internal_error', handler.cartMutation === true, 'unknown', recovery);
    }
    if (!isCallToolResult(result)) return this.executionError('invalid_result', handler.cartMutation === true, 'unknown', recovery);
    if (handler.outputSchema) {
      const validated = handler.outputSchema.safeParse(result.structuredContent);
      if (!validated.success) return this.executionError('invalid_result', handler.cartMutation === true, 'unknown', recovery);
      // The tool's own schema has checked the envelope, including error details such as a scan's
      // statistics; here the status only has to agree with isError.
      const failed = structuredResult(result)?.status === 'error';
      if (failed !== (result.isError === true)) return this.executionError('invalid_result', handler.cartMutation === true, 'unknown', recovery);
    }
    return result;
  }
  private executionError(code: 'internal_error' | 'invalid_result' | RequestStopped['code'], mutation: boolean,
    outcome: 'unknown' | 'not_applied' = 'unknown', recovery: z.infer<typeof RecoverySchema> = { action: 'get_cart', automaticReplay: false }): CallToolResult {
    process.stderr.write(`[continentept-mcp] ${code}\n`);
    const message = code === 'internal_error' ? 'The tool could not complete.' : code === 'invalid_result' ? 'The tool returned an invalid result.' :
      code === 'deadline_exceeded' ? 'The request deadline was exceeded.' : code === 'queue_full' ? 'The session queue is full.' :
      code === 'server_closed' ? 'The server is shutting down.' : 'The request was cancelled.';
    const structuredContent = OperationExecutionErrorSchema.parse({ result: { status: 'error', error: { code, message, retryable: false },
      ...(mutation ? { mutation: { outcome, ...(outcome === 'unknown' ? { recovery } : {}) } } : {}) } });
    return { isError: true, structuredContent, content: [{ type: 'text', text: message + (mutation && outcome === 'unknown' ? ` Use ${recovery.action} before another change.` : '') }] };
  }
  private recoveryFor(handler: ToolHandler, input: unknown): z.infer<typeof RecoverySchema> {
    const candidate = handler.recoveryInput?.(input) ?? { action: handler.recoveryAction ?? 'get_cart', automaticReplay: false };
    const parsed = RecoverySchema.safeParse(candidate);
    return parsed.success ? parsed.data : { action: handler.recoveryAction === 'list_pickup_slots' ? 'get_cart' : handler.recoveryAction ?? 'get_cart', automaticReplay: false };
  }
  async connect(transport: Transport): Promise<void> { await this.server.connect(transport); }
  async close(): Promise<void> { this.shutdown.abort(new RequestStopped('server_closed')); await this.server.close(); await this.closeResources(); }
  private closeResources(): Promise<void> {
    this.cleanup ??= Promise.resolve().then(() => this.options.closeResources?.());
    return this.cleanup;
  }
}

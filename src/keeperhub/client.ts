/**
 * KeeperHub MCP client — the execution layer.
 *
 * Everything that writes to a chain goes through here. We do not hold a signing
 * key: KeeperHub's Turnkey-backed wallet signs, handles gas, retries, and
 * private submission, and returns a receipt it has independently re-read from
 * chain. That last part is why the audit trail is worth anything.
 *
 * Transport notes, each learned the hard way:
 *
 *  - MCP requires the full handshake. `tools/call` before
 *    `notifications/initialized` returns "Session not initialized".
 *  - The session id comes back as a response header and must ride on every
 *    subsequent request.
 *  - A default User-Agent gets a 403. Send an explicit one.
 *  - Responses may be SSE-framed even for unary calls, so parse the last
 *    `data:` line rather than assuming raw JSON.
 */

import 'dotenv/config';

const MCP_URL = 'https://app.keeperhub.com/mcp';

export class KeeperHubError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'KeeperHubError';
  }
}

export interface ExecutionResult {
  executionId?: string;
  status?: string;
  transactionHash?: string;
  transactionLink?: string;
  sponsored?: boolean;
  gasUsed?: string;
  blockNumber?: number;
  receiptStatus?: string;
  /** Simulation only. */
  wouldRevert?: boolean;
  gasEstimate?: string;
  raw: unknown;
}

export class KeeperHub {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(private readonly apiKey = process.env['KEEPERHUB_API_KEY']) {
    if (!this.apiKey) {
      throw new KeeperHubError('KEEPERHUB_API_KEY missing — add it to .env at the repo root');
    }
  }

  private async post(body: unknown, expectReply = true): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': 'understudy/0.1',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    const text = await res.text();
    if (!expectReply || !text.trim()) return null;

    const sseLines = [...text.matchAll(/^data:\s*(\{.*)$/gm)].map((m) => m[1]!);
    const payload = sseLines.length ? sseLines[sseLines.length - 1]! : text;

    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      throw new KeeperHubError(`unparseable MCP response (${res.status})`, text.slice(0, 400));
    }
    if (json.error) throw new KeeperHubError(json.error.message ?? 'MCP error', json.error);
    return json;
  }

  async connect(): Promise<void> {
    await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'understudy', version: '0.1.0' },
      },
    });
    // Required before any tools/call, or the server rejects with
    // "Session not initialized".
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const text = (r?.result?.content ?? [])
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('\n');

    // KeeperHub returns errors as plain text inside a successful envelope, so a
    // 200 is not by itself evidence the call worked.
    if (/^(API call failed|MCP error|Error:)/i.test(text)) {
      throw new KeeperHubError(`${name}: ${text.slice(0, 400)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }

  /**
   * Call a contract function.
   *
   * Two encoding rules the tool schema does not state, both of which return a
   * 400 if broken (upstream issue #1841): `chain_id` must be a string, and
   * `function_args` must be a *stringified* JSON array.
   *
   * `idempotencyKey` must be unique **per attempt**, not per logical action.
   * KeeperHub caches failures under a reused key and replays them, so a retry
   * that reuses the key can never recover once the first attempt has failed
   * (upstream issue #1840).
   */
  async executeContractCall(p: {
    contract: string;
    chainId: number;
    functionName: string;
    args: unknown[];
    abi?: unknown[];
    simulate?: boolean;
    idempotencyKey: string;
  }): Promise<ExecutionResult> {
    const raw = await this.callTool('execute_contract_call', {
      contract_address: p.contract,
      chain_id: String(p.chainId),
      function_name: p.functionName,
      function_args: JSON.stringify(p.args),
      ...(p.abi ? { abi: JSON.stringify(p.abi) } : {}),
      ...(p.simulate ? { simulate: true } : {}),
      idempotency_key: p.idempotencyKey,
    });
    return { ...raw, raw };
  }

  async executionStatus(executionId: string): Promise<ExecutionResult> {
    const raw = await this.callTool('get_direct_execution_status', {
      execution_id: executionId,
    });
    const receipt = raw?.receipts?.[0];
    return {
      ...raw,
      gasUsed: receipt?.gasUsed,
      blockNumber: receipt?.blockNumber,
      receiptStatus: receipt?.receiptStatus,
      raw,
    };
  }

  /**
   * Poll until the execution reaches a terminal state. KeeperHub often returns
   * `completed` immediately, but the receipt — and therefore the verified
   * transaction hash — can lag by a beat.
   */
  async waitForReceipt(executionId: string, timeoutMs = 180_000): Promise<ExecutionResult> {
    const deadline = Date.now() + timeoutMs;
    let last: ExecutionResult | null = null;
    while (Date.now() < deadline) {
      last = await this.executionStatus(executionId);
      if (last.transactionHash && last.receiptStatus) return last;
      if (last.status === 'failed') {
        throw new KeeperHubError(`execution ${executionId} failed`, last.raw);
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    throw new KeeperHubError(`execution ${executionId} did not produce a receipt in time`, last?.raw);
  }
}

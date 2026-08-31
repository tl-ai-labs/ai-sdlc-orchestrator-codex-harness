/**
 * A driver-side MCP client for this server's own tools.
 *
 * docs/verification/p1-codex-runtime.md check 4 found that a model running
 * inside a plain `codex exec` session cannot see or call this server's tools
 * via function-calling — no per-tool binding exists in the model's schema,
 * and the MCP Resources primitives it does expose (list_mcp_resources etc.)
 * are the wrong capability (this server implements Tools, not Resources).
 *
 * The fix: the codex driver script calls the bridge itself, as a genuine MCP
 * client, rather than relying on the model to call it. This module is that
 * client — it spawns this same server as a stdio subprocess and speaks the
 * MCP protocol to it directly, in Node, with no model in the loop. The five
 * tool names and their argument/result shapes are unchanged (Document A
 * section 8's locked MCP tool signatures); only who calls them changed.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SERVER_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "server.js");

export interface BridgeClientOptions {
  /** Override the server entry point — tests point this at a fixture server. */
  serverPath?: string;
  /** Extra environment variables layered onto the spawned server's process.env. */
  env?: Record<string, string>;
}

export interface BridgeClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

function extractText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const first = result.content?.[0];
  if (first?.type === "text" && typeof first.text === "string") return first.text;
  return JSON.stringify(result.content ?? null);
}

function parseToolResult(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Some tools (log_telemetry) reply with the bare string "ok", not JSON.
    return text;
  }
}

export async function connectBridge(options: BridgeClientOptions = {}): Promise<BridgeClient> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverPath ?? DEFAULT_SERVER_ENTRY],
    env: options.env
      ? ({ ...(process.env as Record<string, string>), ...options.env })
      : (process.env as Record<string, string>),
  });

  const client = new Client({ name: "codex-driver", version: "0.1.0" });
  await client.connect(transport);

  return {
    async callTool(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      const text = extractText(result as any);
      if ((result as any).isError) {
        throw new Error(`bridge tool '${name}' returned an error: ${text}`);
      }
      return parseToolResult(text);
    },
    async close() {
      await client.close();
    },
  };
}

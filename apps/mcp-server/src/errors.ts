/**
 * Structured MCP error types and utilities
 */

import { LumenError } from "@lumenbazaar/shared";

export class McpError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "McpError";
  }

  toMcpError() {
    return {
      code: this.code,
      message: this.message,
      details: this.details
    };
  }
}

export class ValidationError extends McpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("INVALID_ARGUMENT", message, details);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends McpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("RESOURCE_NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

export class BackendError extends McpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("INTERNAL_ERROR", message, details);
    this.name = "BackendError";
  }
}

export class PermissionError extends McpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("PERMISSION_DENIED", message, details);
    this.name = "PermissionError";
  }
}

export class CapabilityUnavailableError extends McpError {
  constructor() {
    super("CAPABILITY_UNAVAILABLE", "The backing service for this tool is unavailable.");
    this.name = "CapabilityUnavailableError";
  }
}

export type ConcurrencyLimitScope = "client" | "global";

/**
 * Fail-closed rejection when a tool call would exceed the per-client or
 * global MCP tool concurrency bound. The call never starts, so no
 * payment flow runs and no capacity is consumed.
 */
export class ConcurrencyLimitError extends McpError {
  constructor(scope: ConcurrencyLimitScope, details?: Record<string, unknown>) {
    super(
      "CONCURRENCY_LIMIT_EXCEEDED",
      scope === "client"
        ? "Too many concurrent tool calls for this client. Retry after an in-flight call finishes."
        : "Too many concurrent tool calls. Retry after an in-flight call finishes.",
      { scope, ...details }
    );
    this.name = "ConcurrencyLimitError";
  }
}

export class ResponseTooLargeError extends McpError {
  constructor(tool: string, budgetBytes: number, evidenceBytes: number, originalBytes: number) {
    super(
      "RESPONSE_TOO_LARGE",
      `Payment evidence (${evidenceBytes} bytes) exceeds the ${tool} response budget of ${budgetBytes} bytes; refusing to return a result without payment evidence.`,
      { tool, budgetBytes, evidenceBytes, originalBytes }
    );
    this.name = "ResponseTooLargeError";
  }
}

/**
 * Map errors to structured MCP responses
 */
export function handleToolError(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (error instanceof McpError) {
    const result: { code: string; message: string; details?: Record<string, unknown> } = {
      code: error.code,
      message: error.message
    };
    if (error.details !== undefined) {
      result.details = error.details;
    }
    return result;
  }

  // Typed API errors (for example SELLER_SUSPENDED from suspension
  // enforcement) keep their code so MCP callers can tell a suspension
  // refusal apart from an internal failure.
  if (error instanceof LumenError) {
    const result: { code: string; message: string; details?: Record<string, unknown> } = {
      code: error.code,
      message: error.message
    };
    if (error.details !== undefined) {
      result.details = error.details;
    }
    return result;
  }

  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: "Tool execution failed."
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred"
  };
}

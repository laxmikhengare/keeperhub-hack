/**
 * Typed errors for the seam.
 *
 * §4 contract: analyze() and adjudicate() must throw one of these, never return
 * partial garbage. Kaustubh's pipeline branches on these, so the class names and
 * the `name` fields are part of the interface — do not rename them.
 */

/** The model's safety classifiers declined the request (HTTP 200, stop_reason: 'refusal'). */
export class AgentRefusalError extends Error {
  constructor(
    public stopDetails: unknown,
    message = 'Model refused the request',
  ) {
    super(message);
    this.name = 'AgentRefusalError';
  }
}

/**
 * The model returned something that is not schema-valid, or that violates an
 * invariant we assert after the call (e.g. verdict/blockingIssues inconsistency).
 */
export class AgentSchemaError extends Error {
  constructor(
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'AgentSchemaError';
  }
}

/** The call exceeded its wall-clock budget. */
export class AgentTimeoutError extends Error {
  constructor(message = 'Model call timed out') {
    super(message);
    this.name = 'AgentTimeoutError';
  }
}

/** Configuration problem — almost always a missing ANTHROPIC_API_KEY. */
export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

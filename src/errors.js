export class CLIError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CLIError";
    this.code = options.code ?? "ERR_CLI";
    this.exitCode = options.exitCode ?? 1;
    this.details = options.details ?? null;
  }
}

export function toErrorPayload(error) {
  if (error instanceof CLIError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "ERR_UNEXPECTED",
      message: error instanceof Error ? error.message : String(error),
      details: null,
    },
  };
}

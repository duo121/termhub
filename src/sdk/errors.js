export class TermhubSDKError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "TermhubSDKError";
    this.code = options.code ?? "ERR_SDK";
    this.details = options.details ?? null;
    this.cause = options.cause;
  }
}

export function toSDKError(error, fallbackMessage = "Termhub SDK operation failed") {
  if (error instanceof TermhubSDKError) {
    return error;
  }

  if (error && typeof error === "object" && "code" in error) {
    return new TermhubSDKError(error.message ?? fallbackMessage, {
      code: error.code,
      details: error.details ?? null,
      cause: error,
    });
  }

  return new TermhubSDKError(fallbackMessage, {
    code: "ERR_SDK_UNKNOWN",
    details: error ?? null,
    cause: error,
  });
}

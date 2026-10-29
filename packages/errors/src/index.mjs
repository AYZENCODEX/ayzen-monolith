const STATUS_BY_CODE = Object.freeze({
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
});

export class AyzenError extends Error {
  constructor(code, message, { status, details, cause } = {}) {
    super(message, { cause });
    this.name = "AyzenError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 500;
    this.details = details;
  }
}

export function createErrorResponse(error, requestId) {
  const code = typeof error?.code === "string" ? error.code : "INTERNAL";
  const status = Number.isInteger(error?.status) ? error.status : STATUS_BY_CODE[code] ?? 500;
  return {
    status,
    body: {
      error: {
        code,
        message: status >= 500 ? "Internal service error" : String(error?.message ?? "Request failed"),
        ...(error?.details === undefined ? {} : { details: error.details }),
      },
      ...(requestId ? { requestId } : {}),
    },
  };
}
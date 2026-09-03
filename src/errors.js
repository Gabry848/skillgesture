export class SkillgestureError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SkillgestureError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new SkillgestureError(code, message, details);
}

export function errorPayload(error) {
  if (error instanceof SkillgestureError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  return {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

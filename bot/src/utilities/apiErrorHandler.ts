import { logger } from "../bot";

const invalidRequestLog: Record<string, number> = {
  "401": 0,
  "403": 0,
  "429": 0,
  "404": 0,
};

let invalidRequestLogString = JSON.stringify(invalidRequestLog);

export const handleRateLimit = (retryAfter: number, isGlobal = false) => {
  const delay = isGlobal ? retryAfter * 1000 : retryAfter;
  return new Promise((resolve) => setTimeout(resolve, delay));
};

export const handleApiError = async <T>(
  err: { code?: number; status?: number; headers?: Record<string, string>; retry_after?: number },
  retryFunction: () => Promise<T>
): Promise<T> => {
  if (!err || (!err.code && !err.status)) {
    console.error("Error: Status code is undefined.");
    return Promise.reject(new Error("Error: Status code is undefined."));
  }
  const statusCode = err?.code ?? err?.status;
  if (statusCode === 429) {
    const retryAfter = err.headers?.['retry-after'] ?? err.retry_after ?? 10;
    const isGlobal = err.headers && err.headers['x-ratelimit-global'] === 'true';
    await handleRateLimit(retryAfter as number, isGlobal);
    try {
      return await retryFunction();
    } catch (retryError) {
      throw new Error(`Retry function failed: ${(retryError as Error).message}`);
    }
  } else if (statusCode !== undefined && [401, 403, 404].includes(statusCode)) {
    invalidRequestLog[statusCode]++;
    invalidRequestLogString = JSON.stringify(invalidRequestLog);
    logger.warn(`Invalid request detected: ${statusCode}. Count: ${invalidRequestLog[statusCode]}`);
    if (statusCode === 401) {
      // Stop further requests if token is invalid
      throw new Error(`Error ${statusCode}: Invalid token provided. Stopping further requests.`);
    } else if (statusCode === 403) {
      // Handle permission errors
      throw new Error(`Error ${statusCode}: Permission error. Check role or channel permissions.`);
    } else if (statusCode === 404) {
      // Handle not found errors
      throw new Error(`Error ${statusCode}: Resource not found. Stopping further attempts.`);
    }
  } else {
    throw new Error(`Unhandled error occurred. Status code: ${statusCode}. Original error: ${(err as Error)?.message ?? 'No error message available'}`);
  }
  // Ensure function always returns a value or throws an error
  return Promise.reject(new Error(`Unhandled error occurred. Status code: ${statusCode}.`));
};

export const logInvalidRequests = () => {
  logger.info(`Invalid request log: ${invalidRequestLogString}`);
};

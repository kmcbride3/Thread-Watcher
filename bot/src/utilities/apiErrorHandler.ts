import { logger } from "../bot";

const invalidRequestLog: { [key: string]: number } = {
  "401": 0,
  "403": 0,
  "429": 0,
  "404": 0,
};

export const handleRateLimit = (retryAfter: number, isGlobal = false) => {
  const delay = isGlobal ? retryAfter * 1000 : retryAfter;
  return new Promise((resolve) => setTimeout(resolve, delay));
};

export const handleApiError = async (err: any, retryFunction: Function) => {
  const statusCode = err.code || err.status;
  if (statusCode === 429) {
    const retryAfter = err.headers['retry-after'] || err.retry_after;
    const isGlobal = err.headers['x-ratelimit-global'] === 'true';
    await handleRateLimit(retryAfter, isGlobal);
    return retryFunction();
  } else if ([401, 403, 404].includes(statusCode)) {
    invalidRequestLog[statusCode]++;
    logger.warn(`Invalid request detected: ${statusCode}. Count: ${invalidRequestLog[statusCode]}`);
    if (statusCode === 401) {
      // Stop further requests if token is invalid
      throw new Error("Invalid token provided. Stopping further requests.");
    } else if (statusCode === 403) {
      // Handle permission errors
      throw new Error("Permission error. Check role or channel permissions.");
    } else if (statusCode === 404) {
      // Handle not found errors
      throw new Error("Resource not found. Stopping further attempts.");
    }
  } else {
    throw err;
  }
};

export const logInvalidRequests = () => {
  logger.info(`Invalid request log: ${JSON.stringify(invalidRequestLog)}`);
};

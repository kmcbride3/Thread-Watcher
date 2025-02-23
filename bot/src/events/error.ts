import { logger } from "../bot";

export default function (error: Error): void {
  logger.error(`Client error: ${error.message}`);
}
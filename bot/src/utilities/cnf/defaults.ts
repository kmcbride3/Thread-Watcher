import { ColorResolvable, resolveColor } from "discord.js";
import { validate } from "node-cron";
import { ConfigValue } from "../../interfaces/config";
import { BackupProviders, DataBases } from "../database/DatabaseManager";
import { logger, STATUS_TYPES, StatusType } from "../logger";
import { isValidUrl } from "../securityUtils";

const token: ConfigValue = {
  validate: (value) => {
    if (typeof value !== "string") return false;
    return value.length > 10;
  },
  matchKeys: ["discord"],
};

// Enhanced color validation for style.<StatusType>.color format
const color: ConfigValue = {
  validate: (value, key) => {
    if (value === null || value === undefined) return false;

    // Check if this is a style color key (style.<type>.color)
    const styleMatch = key?.match(/^style\.(\w+)\.color$/);
    if (styleMatch) {
      // Extract the status type from the key
      const statusType = styleMatch[1];

      // Validate that it's a valid StatusType
      // Use the STATUS_TYPES constant for a single source of truth
      if (!STATUS_TYPES.includes(statusType as StatusType)) {
        logger.warn(
          `Invalid status type '${statusType}' in style config. Must be one of: ${STATUS_TYPES.join(", ")}`
        );
        return false;
      }
    }

    try {
      // Use Discord.js's internal color resolver to validate the color
      resolveColor(value as ColorResolvable);
      return true;
    } catch {
      return false;
    }
  },
  matchKeys: ["color", /^style\.\w+\.color$/], // Match both simple color keys and style.<type>.color pattern
  defaultOnInvalid: true,
  default: "#197BBD",
};

const webhook: ConfigValue = {
  validate: (value) => {
    if (!value) return true;
    if (typeof value !== "string") return false;

    // Use isValidUrl and additional Discord-specific check
    return isValidUrl(value) && value.startsWith("https://discord.com");
  },
  matchKeys: ["logWebhook"],
};

const dbType: ConfigValue = {
  validate: (value) => {
    if (typeof value !== "string") return false;

    // Properly use type-safe check instead of 'any' type
    const validDatabaseTypes = Object.values(DataBases) as string[];
    return validDatabaseTypes.includes(value);
  },
  default: "sqlite",
  defaultOnInvalid: true,
  matchKeys: ["type"],
};

const backupProvider: ConfigValue = {
  validate: (value) => {
    if (typeof value !== "string") return false;

    // Properly use type-safe check instead of 'any' type
    const validBackupProviders = Object.values(BackupProviders) as string[];
    return validBackupProviders.includes(value);
  },
  default: "discord",
  defaultOnInvalid: true,
  matchKeys: ["backupProvider"],
};

const cronTime: ConfigValue = {
  validate: (value) => {
    if (typeof value !== "string") return false;
    return !value.trim() || validate(value);
  },
  default: "0 */6 * * *",
  matchKeys: ["backupInterval"],
};

const validators = [token, color, webhook, dbType, cronTime, backupProvider];

export function validateValue(
  key: string,
  value: string | boolean | null | undefined
): string | boolean | null | undefined {
  // Fix for empty root key in JSON parsing (common with reviver functions)
  if (key === "") {
    return value; // Root object, no validation needed
  }

  if (!key || typeof key !== "string") {
    logger.error(`Invalid key provided to validateValue: ${String(key)}`);
    return value;
  }

  const validator = validators.find((a) => {
    // Check if key directly matches any matchKey
    if (
      a.matchKeys.some((matchKey) => {
        if (typeof matchKey === "string") {
          return matchKey === key;
        } else if (matchKey instanceof RegExp) {
          return matchKey.test(key);
        }
        return false;
      })
    ) {
      return true;
    }
    return false;
  });

  if (!validator) return value;

  // Use optional chaining for safer function access
  const passes = validator.validate?.(value, key);

  if (passes) {
    return value;
  } else if (validator.defaultOnInvalid && validator.default !== undefined) {
    logger.warn(
      `CONFIG warning\nKey "${key}" with value "${String(value)}" does not follow allowed format. Defaulting to "${String(validator.default)}"`
    );
    return validator.default as string | boolean | null | undefined;
  } else {
    logger.error(
      `CONFIG error\nKey "${key}" with value "${String(value)}" does not follow allowed format. Aborting!`
    );
    // skipcq: JS-0263
    process.exit(1);
    return undefined;
  }
}

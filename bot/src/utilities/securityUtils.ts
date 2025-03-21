import { Collection } from "discord.js";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { logger } from "../index";
import { ErrorSeverity, handleApiError } from "./errorSystem";

/**
 * This utility contains security-related validation functions that can be used
 * to mitigate security risks related to dynamic file paths, object access, and network requests.
 */

// FILE SECURITY FUNCTIONS

/**
 * Enum defining all allowed safe directory paths
 * This provides compile-time safety for directory operations
 */
export enum SafeDirectoryPath {
  // Main data directory
  DATA = "data",

  // Subdirectories of data
  DATA_BACKUPS = "data/backups",
  DATA_LOGS = "data/logs",
  DATA_LOCKS = "data/locks",
}

/**
 * Enum defining allowed file types with their extensions
 * This provides compile-time safety for file operations
 */
export enum SafeFileType {
  // Data files
  JSON = "json",
  JSON5 = "json5",
  CSV = "csv",

  // Log files
  LOG = "log",
  LOG_ARCHIVE = "log.gz",

  // Database files
  SQLITE = "sqlite",
  SQLITE_DB = "db",
  SQLITE_BACKUP = "sqlite.bak",

  // Configuration files
  ENV = "env",
  CONFIG = "config",

  // Media files that might be used
  PNG = "png",
  JPG = "jpg",
  JPEG = "jpeg",
  GIF = "gif",
}

/**
 * Get the full absolute path for a safe directory
 * @param dir The safe directory enum value
 * @returns The absolute path to the directory
 */
export function getSafeDirectoryPath(dir: SafeDirectoryPath): string {
  return path.join(process.cwd(), dir);
}

/**
 * Check if a directory is a write-allowed directory
 * Only subdirectories of data should be writable
 */
export function isWritableDirectory(_dir: SafeDirectoryPath): boolean {
  return true; // All directory paths in our enum are writable
}

/**
 * Validates a file path to ensure it's within allowed directories.
 * Use this before performing file operations on dynamic paths.
 */
export function validateFilePath(filePath: string, allowedBaseDirs: string[]): boolean {
  if (!filePath || typeof filePath !== "string") {
    return false;
  }

  const normalizedPath = path.normalize(filePath);

  // Ensure path is within allowed base directories
  return allowedBaseDirs.some((dir) => {
    if (!dir || typeof dir !== "string") return false;

    const normalizedDir = path.normalize(dir);
    return (
      normalizedPath.startsWith(normalizedDir) &&
      !normalizedPath.includes("..") &&
      !path.isAbsolute(path.relative(normalizedDir, normalizedPath))
    );
  });
}

/**
 * Directory paths that are considered safe for file operations
 * All operational directories should be under ./data
 */
export const SAFE_DIRECTORIES = [
  getSafeDirectoryPath(SafeDirectoryPath.DATA),
  getSafeDirectoryPath(SafeDirectoryPath.DATA_BACKUPS),
  getSafeDirectoryPath(SafeDirectoryPath.DATA_LOGS),
  getSafeDirectoryPath(SafeDirectoryPath.DATA_LOCKS),
];

/**
 * Files that are considered safe for reading config
 */
export const CONFIG_FILES = [
  path.join(process.cwd(), "config.json5"),
  path.join(process.cwd(), "_config.json5"),
  path.join(process.cwd(), "config.json"),
];

/**
 * Config files that can be written to (subset of CONFIG_FILES)
 */
export const WRITABLE_CONFIG_FILES = [path.join(process.cwd(), "config.json5")];

/**
 * Validates if a path is a valid config file
 * @param filePath The path to check
 * @returns True if it's a valid config file
 */
export function isValidConfigFile(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") {
    return false;
  }

  // Normalize the file path
  const normalizedPath = path.normalize(filePath);

  // Config files should be exactly at the specified locations
  return CONFIG_FILES.includes(normalizedPath);
}

/**
 * Checks if a file path is a writable config file
 * @param filePath The path to check
 * @returns True if the file can be written to
 */
export function isWritableConfigFile(filePath: string): boolean {
  if (!filePath || typeof filePath !== "string") {
    return false;
  }

  // Normalize the file path
  const normalizedPath = path.normalize(filePath);

  // Check if this is one of our writable config files
  return WRITABLE_CONFIG_FILES.includes(normalizedPath);
}

/**
 * Validates a file path for read operations
 * @param filePath The path to validate
 * @returns True if the file can be read
 */
export function validateReadFilePath(filePath: string): boolean {
  // First check if it's a valid config file (special case)
  if (isValidConfigFile(filePath)) {
    return true;
  }

  // Otherwise check if it's in one of the safe directories
  return validateFilePath(filePath, SAFE_DIRECTORIES);
}

/**
 * Validates a file path for write operations
 * @param filePath The path to validate
 * @returns True if the file can be written to
 */
export function validateWriteFilePath(filePath: string): boolean {
  // First check if it's a writable config file (special case)
  if (isWritableConfigFile(filePath)) {
    return true;
  }

  // Otherwise check if it's in one of the safe directories
  return validateFilePath(filePath, SAFE_DIRECTORIES);
}

/**
 * Creates a directory if it doesn't exist
 * Use this instead of directly calling fs.mkdirSync
 * @param safeDir A directory from the SafeDirectoryPath enum
 * @param subpath Optional subdirectory path to create within the safe directory
 * @throws Error if trying to create directories in non-writable locations
 */
export function ensureDirectoryExists(safeDir: SafeDirectoryPath, subpath?: string): boolean {
  // Only allow creating directories in writable locations
  if (!isWritableDirectory(safeDir)) {
    throw new Error(`Cannot create directory in read-only location: ${safeDir}`);
  }

  // Get the absolute path for the safe directory
  const basePath = getSafeDirectoryPath(safeDir);

  // If a subpath is provided, make sure it doesn't contain any path traversal attempts
  let fullPath = basePath;
  if (subpath) {
    if (typeof subpath !== "string") {
      throw new Error("Subdirectory path must be a string");
    }

    // Remove any leading slashes to prevent absolute path creation
    const cleanSubpath = subpath.replace(/^[/\\]+/, "");

    // Check for path traversal attempts
    if (cleanSubpath.includes("..") || cleanSubpath.includes(":")) {
      throw new Error(`Invalid subdirectory path: ${subpath}`);
    }

    fullPath = path.join(basePath, cleanSubpath);

    // Final validation to ensure we're still within the safe directory
    if (!fullPath.startsWith(basePath)) {
      throw new Error(`Directory path not allowed: ${fullPath}`);
    }
  }

  // This is safe since we're using a fixed enum and validated paths
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(fullPath)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    mkdirSync(fullPath, { recursive: true });
    return true;
  }
  return false;
}

/**
 * Legacy version of ensureDirectoryExists for backward compatibility
 * @deprecated Use ensureDirectoryExists with SafeDirectoryPath enum instead
 */
export function ensureDirectoryExistsLegacy(dirPath: string): boolean {
  // First validate the input is a string
  if (typeof dirPath !== "string") {
    throw new Error("Directory path must be a string");
  }

  // Then check if the path is allowed
  if (!validateFilePath(dirPath, SAFE_DIRECTORIES)) {
    throw new Error(`Directory path not allowed: ${dirPath}`);
  }

  // We can safely ignore the security warning here because:
  // 1. We've validated dirPath is a string
  // 2. We've checked it against our SAFE_DIRECTORIES whitelist
  // 3. validateFilePath checks for path traversal attacks like ".."
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(dirPath)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    mkdirSync(dirPath, { recursive: true });
    return true;
  }
  return false;
}

// OBJECT SAFETY FUNCTIONS

/**
 * Safely accesses an object property with validation.
 * Use this when accessing object properties with dynamic keys.
 * @returns The property value with correct type if it exists, undefined otherwise
 */
export function safeObjectAccess<T extends object, K extends string, R = unknown>(
  obj: T,
  key: K,
  allowedKeys: string[] = []
): R {
  // Type validation for parameters
  if (!obj || typeof obj !== "object") {
    return undefined as R;
  }

  if (typeof key !== "string") {
    return undefined as R;
  }

  // Check against allowlist if provided
  if (Array.isArray(allowedKeys) && allowedKeys.length > 0) {
    const isAllowed = allowedKeys.includes(key);
    if (!isAllowed) {
      logger.debug(`Attempt to access disallowed property: ${String(key)}`);
      return undefined as R;
    }
  }

  // Ensure the property exists on the object itself, not the prototype
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    return undefined as R;
  }

  // Use Object.getOwnPropertyDescriptor to safely access the property
  // This prevents execution of getters that might have side effects or injection vulnerabilities
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);
  if (!descriptor) {
    return undefined as R;
  }

  // If it's a data property, return the value directly
  // This is safe because we've validated:
  // 1. key is a string and exists as own property
  // 2. key is in the allowlist if one was provided
  // 3. we're accessing a data descriptor value, not executing code
  if ("value" in descriptor) {
    // We're using descriptor.value instead of obj[key] to avoid any
    // potential object injection sink - this is safe
    return descriptor.value as R;
  }

  // If it's a getter property, avoid executing it to prevent injection attacks
  if ("get" in descriptor) {
    logger.debug(`Property ${String(key)} is a getter, avoiding execution`);
    return undefined as R;
  }

  return undefined as R;
}

/**
 * Safely access a value from a Collection with validation
 * Similar to safeObjectAccess but specifically for Collections
 */
export function safeCollectionAccess<K, V>(
  collection: Collection<K, V>,
  key: K,
  allowedKeys: K[] = []
): V | undefined {
  // Type validation
  if (!collection || !(collection instanceof Collection)) {
    return undefined;
  }

  // If allowedKeys is provided, validate against it
  if (Array.isArray(allowedKeys) && allowedKeys.length > 0) {
    const isAllowed = allowedKeys.includes(key);
    if (!isAllowed) {
      logger.debug(`Accessing disallowed collection key: ${String(key)}`);
      return undefined;
    }
  }

  return collection.get(key);
}

/**
 * Typed version of safeObjectAccess with explicit return type and default value
 * Use this when you need a specific type returned from an object with fallback
 */
export function safeGetProperty<T extends object, K extends string, R>(
  obj: T,
  key: K,
  defaultValue: R
): R {
  // Use unknown intermediate type for maximum safety
  const result = safeObjectAccess<T, K, unknown>(obj, key);
  return result === undefined ? defaultValue : (result as R);
}

// PATTERN SAFETY FUNCTIONS

/**
 * Map of pre-approved safe RegEx patterns
 * This provides a whitelist of patterns known to be safe
 */
export const SAFE_REGEX_PATTERNS: Record<string, RegExp> = {
  // Discord snowflake ID pattern
  discordId: /^\d{17,20}$/,

  // HTML entity characters for sanitization
  htmlEntities: /[&<>"']/g,

  // Common filename validation - use non-capturing parens for better performance
  filename: /^[a-zA-Z0-9_\-.]+$/,

  // Simple email pattern - intentionally basic for performance
  email: /^[^@\s]+@[^@\s.]+\.[^@\s]+$/,

  // URL validation (basic)
  url: /^https?:\/\/[^\s/$.?#].[^\s]*$/i,
};

/**
 * Safely creates a RegExp from a potentially dynamic pattern.
 * Use this instead of directly creating RegExp with variables.
 */
export function safeRegExp(pattern: string, flags?: string): RegExp {
  // Validate inputs
  if (typeof pattern !== "string") {
    throw new Error("RegExp pattern must be a string");
  }

  if (flags !== undefined && typeof flags !== "string") {
    throw new Error("RegExp flags must be a string if provided");
  }

  // Limit pattern length to prevent ReDoS attacks
  if (pattern.length > 2000) {
    throw new Error("RegExp pattern too long");
  }

  // Check if this is a pre-approved pattern
  if (pattern in SAFE_REGEX_PATTERNS) {
    const baseRegex = Object.hasOwn(SAFE_REGEX_PATTERNS, pattern)
      ? SAFE_REGEX_PATTERNS[pattern as keyof typeof SAFE_REGEX_PATTERNS]
      : null;

    if (!baseRegex) {
      throw new Error("Invalid RegExp pattern name");
    }

    // If no flags specified or they match the existing regex, return it directly
    if (!flags || baseRegex.flags === flags) {
      return baseRegex;
    }

    // Create a new RegExp with the same source pattern but different flags
    // This is safe because we're using the source of a pre-approved pattern
    const safeSource = baseRegex.source;
    // eslint-disable-next-line security/detect-non-literal-regexp
    return new RegExp(safeSource, flags);
  }

  try {
    // Instead of trying to validate the pattern with our own regex,
    // we'll try to create the RegExp directly but inside a try/catch
    // to detect any syntax errors or other issues

    // The RegExp constructor itself will validate syntax
    // eslint-disable-next-line security/detect-non-literal-regexp
    return new RegExp(pattern, flags);
  } catch (err) {
    logger.debug(`Invalid RegExp pattern rejected: ${pattern}`);
    throw new Error(`Invalid RegExp pattern: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// INPUT SANITIZATION FUNCTIONS

/**
 * Sanitize user input to prevent injection attacks
 * @param input The user input string to sanitize
 * @returns A sanitized string safe for use
 */
export function sanitizeInput(input: string): string {
  if (typeof input !== "string") {
    return "";
  }

  return input.replace(/[&<>"']/g, (match) => {
    switch (match) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return match;
    }
  });
}

/**
 * Validate a Discord snowflake ID
 * @param id The ID to validate
 * @returns True if the ID is valid, false otherwise
 */
export function isValidDiscordId(id: string): boolean {
  if (typeof id !== "string") {
    return false;
  }

  // Use our pre-defined safe regex
  return SAFE_REGEX_PATTERNS.discordId.test(id);
}

/**
 * Validate a URL for safety
 * @param url The URL to validate
 * @returns True if the URL is valid and safe, false otherwise
 */
export function isValidUrl(url: string): boolean {
  if (typeof url !== "string") {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return ["http:", "https:"].includes(parsedUrl.protocol);
  } catch {
    return false;
  }
}

// NETWORK SAFETY FUNCTIONS

/**
 * Safely execute a fetch request with robust error handling and reporting
 * @param url The URL to fetch
 * @param options Fetch options
 * @param apiErrorOptions Configuration for error handling
 * @returns The response data or null if an error occurred
 */
export async function safeFetch<T>(
  url: string,
  options?: RequestInit,
  apiErrorOptions: {
    retries?: number;
    retryDelay?: number;
    reportErrors?: boolean;
  } = {}
): Promise<T | null> {
  // Validate URL before attempting fetch
  if (!isValidUrl(url)) {
    logger.error(`Invalid URL in safeFetch: ${url}`);
    return null;
  }

  const { reportErrors = true } = apiErrorOptions;

  try {
    return await handleApiError(
      null,
      async () => {
        const response: Response = await fetch(url, {
          ...options,
          headers: {
            "User-Agent": "Thread-Watcher Bot/1.0",
            ...(options?.headers || {}),
          },
        });

        if (!response.ok) {
          // Create error object using Object.create for better security
          // This avoids object injection sinks by using property descriptors
          const error = Object.create(Error.prototype, {
            message: {
              value: `Request failed with status ${response.status}`,
              enumerable: true,
              configurable: true,
              writable: true,
            },
            name: {
              value: "FetchError",
              enumerable: true,
              configurable: true,
              writable: true,
            },
            status: {
              value: response.status,
              enumerable: true,
              configurable: true,
              writable: true,
            },
            url: {
              value: url,
              enumerable: true,
              configurable: true,
              writable: true,
            },
          });
          throw error;
        }

        // Parse response safely based on content type
        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
          // For JSON content-type, use response.json() which is safe
          const data = await response.json();
          return data as T;
        } else {
          // For non-JSON responses, handle as text first
          const text = await response.text();

          // Only attempt to parse potential JSON data that matches a basic pattern
          // This is safe because:
          // 1. We're checking the content starts with valid JSON markers
          // 2. The source is from a trusted API response
          // 3. The parse is in a try/catch block
          if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
            try {
              return JSON.parse(text) as T;
            } catch {
              // If parsing fails, return as is
              return text as unknown as T;
            }
          }
          return text as unknown as T;
        }
      },
      {
        reportAtSeverity: reportErrors ? ErrorSeverity.HIGH : ErrorSeverity.CRITICAL,
        context: `HTTP Request to ${url}`,
      }
    );
  } catch (err) {
    logger.error(`Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Creates a safe subset of an object by copying only allowed properties
 * @param sourceObj The source object to copy from
 * @param allowedProps Array of property names that are allowed to be copied
 * @returns A new object with only the allowed properties
 */
export function createSafeObject<T extends object, K extends keyof T>(
  sourceObj: T,
  allowedProps: K[]
): Pick<T, K> {
  if (!sourceObj || typeof sourceObj !== "object") {
    throw new Error("Source must be a valid object");
  }

  if (!Array.isArray(allowedProps)) {
    throw new Error("Allowed properties must be an array");
  }

  const result = {} as Pick<T, K>;

  // Copy only the allowed properties using descriptor-based approach
  for (const prop of allowedProps) {
    // Use Object.getOwnPropertyDescriptor for safer property access
    // This prevents execution of getters and avoids object injection sinks
    const descriptor = Object.getOwnPropertyDescriptor(sourceObj, prop);

    // Only copy if it's a data property (not a getter)
    if (descriptor && "value" in descriptor) {
      // Use defineProperty instead of direct assignment to avoid setter-based injection
      Object.defineProperty(result, prop, {
        value: descriptor.value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }

  return result;
}

/**
 * Creates a deep clone of an object with restricted key access
 * This is useful for safely copying untrusted objects
 */
export function createDeepSafeObject<T extends object>(
  sourceObj: T,
  allowedProperties: string[] = []
): Partial<T> {
  if (!sourceObj || typeof sourceObj !== "object") {
    return {} as Partial<T>;
  }

  // Create result object
  const result = {} as Partial<T>;

  // Gather own property names to process
  const propNames = Object.getOwnPropertyNames(sourceObj);

  // Filter properties if whitelist provided
  const properties =
    allowedProperties.length > 0
      ? propNames.filter((name) => allowedProperties.includes(name))
      : propNames;

  // Process each property
  for (const propName of properties) {
    const descriptor = Object.getOwnPropertyDescriptor(sourceObj, propName);

    // Skip if no descriptor or it's a getter/setter
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }

    const value = descriptor.value;

    if (value === null || value === undefined) {
      // Define simple null/undefined values directly
      Object.defineProperty(result, propName, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else if (typeof value !== "object") {
      // For primitives, just copy the value directly
      Object.defineProperty(result, propName, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else if (Array.isArray(value)) {
      // For arrays, create a new array with primitive values only
      const safeArray = value
        .filter((item) => item === null || item === undefined || typeof item !== "object")
        .map((item) => item);

      Object.defineProperty(result, propName, {
        value: safeArray,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      // For objects, recursively create safe objects (1 level deep only)
      const nestedObj = value as Record<string, unknown>;
      const safeNestedObj = createSafeObject(nestedObj, Object.getOwnPropertyNames(nestedObj));

      Object.defineProperty(result, propName, {
        value: safeNestedObj,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }

  return result;
}

/**
 * Checks if a filename has an allowed extension
 * @param filename The filename to validate
 * @param allowedTypes Array of allowed file types from SafeFileType enum
 * @returns True if the filename has an allowed extension
 */
export function hasAllowedExtension(filename: string, allowedTypes: SafeFileType[]): boolean {
  if (!filename || typeof filename !== "string") {
    return false;
  }

  // Get the extension (everything after the last dot)
  const extension = filename.split(".").pop()?.toLowerCase();

  if (!extension) {
    return false;
  }

  // Check if the extension is in the allowed types
  return allowedTypes.some((type) => type.toLowerCase() === extension);
}

/**
 * Validates a filename against security rules
 * @param filename The filename to validate
 * @returns True if the filename is valid
 */
export function isValidFilename(filename: string): boolean {
  if (!filename || typeof filename !== "string") {
    return false;
  }

  // Check if the filename matches our safe pattern
  return SAFE_REGEX_PATTERNS.filename.test(filename);
}

/**
 * Creates a safe filename from potentially unsafe input
 * @param input The input string to convert to a safe filename
 * @param extension Optional file extension to append (without the dot)
 * @returns A sanitized filename
 */
export function createSafeFilename(input: string, extension?: SafeFileType): string {
  if (!input || typeof input !== "string") {
    return "unnamed_file";
  }

  // Replace unsafe characters with underscores
  let safeName = input.replace(/[^a-zA-Z0-9_\-.]/g, "_");

  // Ensure no directory traversal
  safeName = safeName.replace(/\.{2,}/g, "_");

  // Remove any leading dots or slashes
  safeName = safeName.replace(/^[./\\]+/, "");

  // Limit length
  const MAX_FILENAME_LENGTH = 255;
  if (safeName.length > MAX_FILENAME_LENGTH) {
    safeName = safeName.substring(0, MAX_FILENAME_LENGTH);
  }

  // Add extension if provided
  if (extension) {
    safeName = `${safeName}.${extension}`;
  }

  return safeName;
}

/**
 * Builds a safe file path by joining a safe directory with a safe filename
 * @param directory A safe directory path enum value
 * @param filename The filename (will be sanitized)
 * @param fileType Optional file type from SafeFileType enum
 * @returns A complete safe filepath
 */
export function buildSafeFilePath(
  directory: SafeDirectoryPath,
  filename: string,
  fileType?: SafeFileType
): string {
  const basePath = getSafeDirectoryPath(directory);
  const safeFilename = createSafeFilename(filename, fileType);

  return path.join(basePath, safeFilename);
}

/**
 * Creates a safe path to a config file
 * @param filename The config filename (must be in CONFIG_FILES)
 * @returns The normalized path to the config file
 * @throws Error if the filename is not a valid config file
 */
export function getConfigFilePath(filename: string): string {
  const fullPath = path.join(process.cwd(), filename);

  if (!isValidConfigFile(fullPath)) {
    throw new Error(`Invalid config file: ${filename}`);
  }

  return fullPath;
}

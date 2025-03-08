import path from "path";
import { existsSync, mkdirSync } from "fs";

/**
 * This utility contains security-related validation functions that can be used
 * to mitigate security risks related to dynamic file paths and object access.
 */

/**
 * Validates a file path to ensure it's within allowed directories.
 * Use this before performing file operations on dynamic paths.
 */
export function validateFilePath(filePath: string, allowedBaseDirs: string[]): boolean {
  const normalizedPath = path.normalize(filePath);

  // Ensure path is within allowed base directories
  return allowedBaseDirs.some((dir) => {
    const normalizedDir = path.normalize(dir);
    return (
      normalizedPath.startsWith(normalizedDir) &&
      !normalizedPath.includes("..") &&
      !path.isAbsolute(path.relative(normalizedDir, normalizedPath))
    );
  });
}

/**
 * Safely accesses an object property with validation.
 * Use this when accessing object properties with dynamic keys.
 */
export function safeObjectAccess<T extends object, K extends string>(
  obj: T,
  key: K,
  allowedKeys: string[] = []
): unknown {
  // If allowedKeys is provided, validate against it
  if (allowedKeys.length > 0 && !allowedKeys.includes(key)) {
    throw new Error(`Accessing disallowed property: ${String(key)}`);
  }

  // Ensure the property exists on the object itself, not the prototype
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    return undefined;
  }

  return obj[key as unknown as keyof T];
}

/**
 * Safely creates a RegExp from a potentially dynamic pattern.
 * Use this instead of directly creating RegExp with variables.
 */
export function safeRegExp(pattern: string, flags?: string): RegExp {
  // Limit pattern length to prevent ReDoS attacks
  if (pattern.length > 1000) {
    throw new Error("RegExp pattern too long");
  }

  // Fix: Remove unnecessary escape characters inside character class
  if (!/^[a-zA-Z0-9\s^$.*+?()[\]{}|\\\-,]+$/g.test(pattern)) {
    throw new Error("RegExp pattern contains potentially unsafe characters");
  }

  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new Error(`Invalid RegExp pattern: ${err}`);
  }
}

/**
 * Directory paths that are considered safe for file operations
 */
export const SAFE_DIRECTORIES = [
  path.join(process.cwd(), "data"),
  path.join(process.cwd(), "config"),
  path.join(process.cwd(), "logs"),
  path.join(process.cwd(), "backups"),
  // Add more directories as needed
];

/**
 * Creates a directory if it doesn't exist
 * Use this instead of directly calling fs.mkdirSync
 */
export function ensureDirectoryExists(dirPath: string): boolean {
  if (!validateFilePath(dirPath, SAFE_DIRECTORIES)) {
    throw new Error(`Directory path not allowed: ${dirPath}`);
  }

  if (!existsSync(dirPath)) {
    // Fix: Use imported mkdirSync instead of require
    mkdirSync(dirPath, { recursive: true });
    return true;
  }
  return false;
}

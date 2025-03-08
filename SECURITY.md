# Thread Watcher Security Policy and Documentation

## Supported Versions

Currently, our security updates are applied to the latest version of Thread-Watcher.

| Version   | Supported          |
| --------- | ------------------ |
| latest    | :white_check_mark: |
| < latest  | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability within Thread-Watcher, please report it using the Security tab on our GitHub repository. Please include:
- Type of issue
- Full paths of source file(s)
- Affected location (tag/branch/commit or URL)
- Step-by-step reproduction instructions
- Proof-of-concept or exploit code (if available)
- Impact assessment and potential attack vectors

## Security Best Practices

The Thread-Watcher team follows these practices:
1. Regular dependency updates and audits.
2. Security-focused code reviews.
3. Comprehensive input validation.
4. Robust error handling to avoid information disclosure.
5. Secure credential management.
6. Regular security scanning.

## Security Architecture

Thread Watcher employs a layered approach:
- **Input Validation:** All user inputs are validated.
- **Privilege Separation:** Commands are restricted based on user permissions.
- **Safe File Operations:** All file system operations use strict path validation and directory checks.
- **Regex Restrictions:** Dynamic regular expressions are constructed using fixed, trusted components with proper limits.

## Security Exceptions

### File System Operations

Dynamic file paths are acceptable when:
- They are constructed from hardcoded or admin-controlled configuration.
- User input is never directly used.
- Path concatenation uses `path.join()` to avoid directory traversal issues.

### Object Property Access

Dynamic property access is safe if:
- Keys are obtained from controlled sources.
- The object structure is well-defined via typed interfaces.
- Access is limited to known, validated keys.

### Regex Usage

Regular expressions are secure because:
- Inputs are size-bounded to prevent ReDoS.
- All regex patterns are built from trusted components.
- Simple patterns and character-class restrictions minimize risk.

### Eval Command

The `eval` command employs strict safeguards:
- It is restricted to bot owners.
- A timeout mechanism and regex filters block dangerous operations.
- Code execution occurs in an isolated context.

## Additional Security Exceptions

Below are additional low-risk exceptions that have been reviewed and deemed acceptable:

- **Non-Literal Filesystem Operations:** Utilities that use dynamic path generation (e.g., in configuration, logging, database backups, command loading, and process management) are safe as all paths are derived from hardcoded constants, administrator settings, or the application installation directory.
- **Object Injection Patterns:** Dynamic property accesses (in configuration management, message templating, and component handling) are secure because keys come from controlled sources or validated through typed interfaces.
- **Regex Construction:** Regular expressions throughout the code (e.g., in URL validation and thread filtering) are constructed from trusted components and applied with proper input size limits to avoid catastrophic backtracking.

## Validating Security Configurations

To review your security settings and check for issues, run one of the following commands:

```bash
yarn security:check
# or
yarn lint:security
```

Any security warnings should be promptly reviewed. If a warning represents an accepted exception, please document it in this file under the relevant section.

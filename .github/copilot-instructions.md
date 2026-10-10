In TypeScript never use the <any> type, and use <unknown> only when necessary.
Always follow ESLint and Prettier rules.
Avoid adding unnecessary comments to show where code was added.
Prefer the `discord.js` <Collection> over <Map>.
Avoid using deprecated methods from imported packages.
Always leverage logger.ts, errorSystem.ts, rateLimitManager.ts and the appropriate utility/helper functions where appropriate.
Avoid object injection sinks.
Assume we are leveraging `discord.js` v14.27.0 and `Node.js` v24.21.0, and prefer using built-in functionality from them where possible.
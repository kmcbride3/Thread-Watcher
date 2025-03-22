# Multi-stage build with improved file organization

# Stage 1: Build the application
FROM node:22-slim AS builder

# Setup environment in a single layer
RUN apt-get update && \
    mkdir -p /usr/src/bot/data && \
    touch /usr/src/bot/data/thread-watcher.log && \
    chmod 666 /usr/src/bot/data/thread-watcher.log && \
    touch /usr/src/bot/.commandshash && \
    chmod 666 /usr/src/bot/.commandshash && \
    chown -R 1000:1000 /usr/src/bot && \
    chmod -R 775 /usr/src/bot && \
    corepack enable && \
    corepack prepare yarn@4.7.0 --activate

# Set working directory
WORKDIR /usr/src/bot

# Copy project files and install dependencies in one layer
COPY ["package.json", "yarn.lock*", "tsconfig.json", "_config.json5", "/usr/src/bot/"]
RUN yarn config set nodeLinker node-modules && \
    yarn install && \
    yarn cache clean

# Copy source, build, and prepare production files in one layer
COPY ["./src/", "/usr/src/bot/src/"]

# Verify build process and check that files exist
RUN yarn run build && \
    ls -la /usr/src/bot/dist && \
    # Ensure the main file exists
    test -f /usr/src/bot/dist/index.js && \
    # Optimize dependencies for production
    yarn workspaces focus --production && \
    yarn cache clean

# Stage 2: Assembly - organize files for the final image
FROM scratch AS assembly

# Copy each component separately for clarity
COPY --from=builder /usr/src/bot/node_modules /assembly/node_modules
COPY --from=builder /usr/src/bot/dist /assembly/dist
COPY --from=builder /usr/src/bot/_config.json5 /assembly/
COPY --from=builder /usr/src/bot/.commandshash /assembly/
COPY --from=builder /usr/src/bot/data /assembly/data

# Stage 3: Final minimal runtime image
FROM gcr.io/distroless/nodejs22-debian12 AS bot

# Set environment and working directory
ENV NODE_ENV=production
WORKDIR /usr/src/bot

# Copy everything from the assembly image in a single layer
COPY --chown=1000:1000 --from=assembly /assembly/ /usr/src/bot/

# Configure script permissions for a non-root user
USER 1000:1000

# Start the application
CMD ["/usr/src/bot/dist/index.js"]
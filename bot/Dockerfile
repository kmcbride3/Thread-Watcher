# Multi-stage build and app-only image

# Create base image with toolchain required to install dependencies
FROM node:22-slim AS builder
RUN apt-get update

# Combine data directory and log file creation with strict permissions
RUN mkdir -p /usr/src/bot/data && \
    touch /usr/src/bot/data/thread-watcher.log && \
    chmod 666 /usr/src/bot/data/thread-watcher.log && \
    touch /usr/src/bot/.commandshash && \
    chmod 666 /usr/src/bot/.commandshash && \
    chown -R 1000:1000 /usr/src/bot && \
    chmod -R 775 /usr/src/bot

# Set working directory
WORKDIR /usr/src/bot

# Copy only the package/tsconfig files and the src dir
COPY ["package.json", "yarn.lock*", "tsconfig.json", "_config.json5", "/usr/src/bot/"]

# Install all dependencies (including devDependencies)
RUN yarn install && yarn cache clean --force

# Copy source code to build
COPY ["./src/", "/usr/src/bot/src/"]

# Run the build command which creates the production bundle
RUN yarn run build

# Remove devDependencies after build
RUN yarn install --production --frozen-lockfile && yarn cache clean --force

# Create production image without including the toolchain 
FROM gcr.io/distroless/nodejs22-debian12 AS bot

# Set NODE_ENV environment variable
ENV NODE_ENV production

# Set working directory
WORKDIR /usr/src/bot

# Copy built node modules and binaries without including the source code or toolchain
COPY --chown=1000:1000 --from=builder /usr/src/bot/node_modules /usr/src/bot/node_modules
COPY --chown=1000:1000 --from=builder /usr/src/bot/dist /usr/src/bot/dist

# Copy config and commandshash files, set permissions on bot directory
COPY --chown=1000:1000 --from=builder /usr/src/bot/_config.json5 /usr/src/bot/_config.json5
COPY --chown=1000:1000 --from=builder /usr/src/bot/.commandshash /usr/src/bot/.commandshash
COPY --chown=1000:1000 --from=builder /usr/src/bot/data /usr/src/bot/data

# Start the bot & register slash commands.
CMD [ "./dist/index.js", "-reg_commands" ]
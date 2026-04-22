# Dockerfile for Bradicoin Mainnet RPC Server
# Bradicoin Blockchain - BRD Token
# Production-ready configuration

# ============================================
# Stage 1: Builder
# ============================================
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci --only=production || npm install --production

# ============================================
# Stage 2: Production
# ============================================
FROM node:18-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Set working directory
WORKDIR /app

# Copy built dependencies from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy application code
COPY --chown=nodejs:nodejs . .

# Create data directory for blockchain persistence
RUN mkdir -p /app/bradicoin-data && \
    chown -R nodejs:nodejs /app/bradicoin-data

# Environment variables
ENV NODE_ENV=production
ENV RPC_PORT=8545
ENV RPC_HOST=0.0.0.0
ENV BRADICOIN_DATA_DIR=/app/bradicoin-data

# Expose RPC port
EXPOSE 8545

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8545/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

# Switch to non-root user
USER nodejs

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the RPC server
CMD ["node", "rpc-mainnet.js"]

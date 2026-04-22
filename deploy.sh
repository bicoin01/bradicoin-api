#!/bin/bash
# deploy.sh - Production deployment script for Bradicoin RPC

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Bradicoin Mainnet RPC Deployment${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Docker is not installed. Please install Docker first.${NC}"
    exit 1
fi

# Pull latest code
echo -e "${YELLOW}Pulling latest code...${NC}"
git pull origin main

# Build Docker image
echo -e "${YELLOW}Building Docker image...${NC}"
docker build -t bradicoin-rpc:latest .

# Stop old container
echo -e "${YELLOW}Stopping old container...${NC}"
docker stop bradicoin-mainnet 2>/dev/null || true
docker rm bradicoin-mainnet 2>/dev/null || true

# Run new container
echo -e "${YELLOW}Starting new container...${NC}"
docker run -d \
    --name bradicoin-mainnet \
    --restart unless-stopped \
    -p 8545:8545 \
    -v bradicoin-data:/app/bradicoin-data \
    -v /var/log/bradicoin:/app/logs \
    bradicoin-rpc:latest

# Wait for container to start
sleep 5

# Check if container is running
if docker ps | grep -q bradicoin-mainnet; then
    echo -e "${GREEN}✅ Deployment successful!${NC}"
    echo -e "${GREEN}RPC is running on port 8545${NC}"
    
    # Test the endpoint
    echo -e "${YELLOW}Testing RPC endpoint...${NC}"
    curl -s -X POST http://localhost:8545/health | jq . || echo "Health check pending..."
else
    echo -e "${RED}❌ Deployment failed!${NC}"
    docker logs bradicoin-mainnet
    exit 1
fi

# Show logs
echo -e "${YELLOW}Recent logs:${NC}"
docker logs --tail 20 bradicoin-mainnet

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deployment complete!${NC}"
echo -e "${GREEN}========================================${NC}"

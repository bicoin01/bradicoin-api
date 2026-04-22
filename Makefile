# Makefile for Bradicoin RPC Docker Management

.PHONY: help build run stop restart logs clean shell test

# Colors for output
GREEN := \033[0;32m
RED := \033[0;31m
NC := \033[0m # No Color

help: ## Show this help message
	@echo '$(GREEN)Bradicoin RPC Docker Commands$(NC)'
	@echo ''
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "$(GREEN)%-15s$(NC) %s\n", $$1, $$2}'

build: ## Build Docker image
	@echo "$(GREEN)Building Bradicoin RPC Docker image...$(NC)"
	docker build -t bradicoin-rpc:latest .
	@echo "$(GREEN)Build complete!$(NC)"

run: ## Run container in background
	@echo "$(GREEN)Starting Bradicoin RPC container...$(NC)"
	docker run -d --name bradicoin-mainnet -p 8545:8545 -v bradicoin-data:/app/bradicoin-data bradicoin-rpc:latest
	@echo "$(GREEN)Container started!$(NC)"

stop: ## Stop running container
	@echo "$(RED)Stopping Bradicoin RPC container...$(NC)"
	docker stop bradicoin-mainnet || true
	docker rm bradicoin-mainnet || true
	@echo "$(GREEN)Container stopped!$(NC)"

restart: stop run ## Restart container

logs: ## View container logs
	docker logs -f bradicoin-mainnet

shell: ## Open shell inside container
	docker exec -it bradicoin-mainnet sh

clean: ## Remove container, image, and volumes
	@echo "$(RED)Cleaning up...$(NC)"
	docker stop bradicoin-mainnet || true
	docker rm bradicoin-mainnet || true
	docker rmi bradicoin-rpc:latest || true
	docker volume rm bradicoin-data || true
	@echo "$(GREEN)Cleanup complete!$(NC)"

test: ## Test RPC endpoint
	@echo "$(GREEN)Testing RPC endpoint...$(NC)"
	@curl -s -X POST http://localhost:8545/bradicoin/getinfo -H "Content-Type: application/json" | jq . || echo "RPC not responding"

compose-up: ## Start with docker-compose
	docker-compose up -d

compose-down: ## Stop docker-compose
	docker-compose down

compose-logs: ## View docker-compose logs
	docker-compose logs -f

status: ## Show container status
	@docker ps --filter "name=bradicoin-mainnet" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

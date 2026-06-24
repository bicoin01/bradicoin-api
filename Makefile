.PHONY: help install start dev test clean

help:
	@echo "Available commands:"
	@echo "  make install    - Install dependencies"
	@echo "  make start      - Start production server"
	@echo "  make dev        - Start development server"
	@echo "  make test       - Run tests"
	@echo "  make clean      - Clean data directory"

install:
	npm install

start:
	NODE_ENV=production node server.js

dev:
	NODE_ENV=development nodemon server.js

test:
	npm test

clean:
	rm -rf bradicoin-data/
	rm -rf node_modules/

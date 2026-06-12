set shell := ["bash", "-cu"]

default:
  @just --list

setup:
  bun install
  bun run prepare
  bunx playwright install chromium

dev:
  bun run dev:cloudflare

dev-edge:
  bun run dev:edge

dev-cloudflare:
  bun run dev:cloudflare

deploy-cloudflare:
  bun run deploy:cloudflare

lint:
  bun run lint

format:
  bun run format

typecheck:
  bun run typecheck

test-unit:
  bun run test:unit

test-e2e:
  bun run test:e2e

test:
  bun run test

build:
  bun run build

check:
  bun run check

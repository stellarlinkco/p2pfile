set shell := ["bash", "-cu"]

default:
  @just --list

setup:
  bun install
  bun run prepare
  bunx playwright install chromium

dev:
  trap 'kill 0' EXIT; bun run dev:signal & bun run dev:web & wait

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

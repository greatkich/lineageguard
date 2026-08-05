.PHONY: setup browser-install verify-foundation

setup:
	corepack pnpm install --frozen-lockfile
	uv sync --project tools/datahub --locked
	$(MAKE) browser-install

browser-install:
	pnpm exec playwright install chromium

verify-foundation:
	bash scripts/verify-foundation.sh

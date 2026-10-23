# SpecGuard — build, test and release targets.
#
#   make build      build the CLI (dist/) and the VS Code extension (extension/dist)
#   make ci         every gate the CI and release workflows run
#   make vsix       package extension/specguard-<version>.vsix for a local install
#   make publish    tag vX.Y.Z and push it: the Release workflow publishes (see below)
#
# The CLI version in package.json is the single version source; `make bump V=x.y.z` moves both packages.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Terminals that never loaded nvm have no node on PATH: use the newest nvm install.
ifeq ($(shell command -v node 2>/dev/null),)
NVM_BIN := $(lastword $(sort $(wildcard $(HOME)/.nvm/versions/node/v*/bin)))
ifneq ($(NVM_BIN),)
export PATH := $(NVM_BIN):$(PATH)
endif
endif

# make runs a simple command directly, searching the PATH it was started with, so run tools through `env` to use ours.
NPM  := env PATH="$(PATH)" npm
NPX  := env PATH="$(PATH)" npx
NODE := env PATH="$(PATH)" node

VERSION := $(shell PATH="$(PATH)" node -p "require('./package.json').version" 2>/dev/null)
TAG     := v$(VERSION)
EXT     := extension
VSIX    := $(EXT)/specguard-$(VERSION).vsix
SG      := $(NPX) tsx src/cli/index.ts

.PHONY: help install build build-cli build-ext typecheck lint test test-ext ci check prove audit \
        vsix vsix-install clean bump release-check publish publish-dry publish-ext

help: ## Show the targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies exactly as CI does (npm ci in the root, extension and webview)
	$(NPM) ci
	cd $(EXT) && $(NPM) ci && $(NPM) --prefix webview install

build: build-cli build-ext ## Build the CLI and the extension

build-cli: ## Compile the CLI to dist/
	$(NPM) run build

build-ext: ## Bundle the extension (webview, bundled CLI, host)
	cd $(EXT) && $(NPM) run build

typecheck: ## Typecheck the CLI
	$(NPM) run typecheck

lint: ## Lint the CLI and typecheck the extension
	$(NPM) run lint
	cd $(EXT) && $(NPM) run lint

test: ## CLI tests
	$(NPM) test

test-ext: ## Extension tests
	cd $(EXT) && $(NPM) test

ci: typecheck lint test build test-ext build-ext ## Every gate CI and the release run
	$(NODE) $(EXT)/scripts/sync-version.mjs --check

check: ## SpecGuard's own spec health
	$(SG) check

prove: ## Re-run the tests as proof, then check (do this after changing code, specs or the lockfile)
	$(SG) test run
	$(SG) check

audit: ## npm audit in the root and the extension
	$(NPM) audit
	cd $(EXT) && $(NPM) audit

vsix: build-ext ## Package the extension: extension/specguard-<version>.vsix
	cd $(EXT) && rm -f specguard-$(VERSION).vsix && $(NPX) vsce package --no-dependencies
	@echo "built $(VSIX)"

vsix-install: vsix ## Package and install the extension into VS Code
	code --install-extension $(VSIX) --force

clean: ## Remove build output
	$(NPM) run clean
	rm -rf $(EXT)/dist

bump: ## Set the version in both packages and lockfiles: make bump V=0.3.1
	@test -n "$(V)" || { echo "usage: make bump V=x.y.z"; exit 2; }
	$(NPM) version $(V) --no-git-tag-version
	$(NODE) $(EXT)/scripts/sync-version.mjs $(V)
	cd $(EXT) && $(NPM) install --package-lock-only --ignore-scripts
	@echo "now at $(V): run 'make prove', commit, push, then 'make publish'"

release-check: ## The checks `make publish` makes before it tags
	@set -e; \
	[ "$$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "not on main"; exit 1; }; \
	[ -z "$$(git status --porcelain)" ] || { echo "the working tree has uncommitted changes"; git status --short; exit 1; }; \
	git fetch -q origin main --tags; \
	[ "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" ] || { echo "main differs from origin/main: push or pull first"; exit 1; }; \
	! git rev-parse -q --verify "refs/tags/$(TAG)" >/dev/null || { echo "tag $(TAG) already exists"; exit 1; }; \
	[ "$$(npm view specguard-ai@$(VERSION) version 2>/dev/null)" != "$(VERSION)" ] || { echo "specguard-ai@$(VERSION) is already on npm: make bump V=<next>"; exit 1; }; \
	$(NODE) $(EXT)/scripts/sync-version.mjs --check; \
	if command -v gh >/dev/null; then \
	  c=$$(gh run list --branch main --workflow CI --commit "$$(git rev-parse HEAD)" --limit 1 --json conclusion --jq '.[0].conclusion' 2>/dev/null || true); \
	  [ "$$c" = success ] || { echo "CI has not passed on this commit (status: $${c:-none})"; exit 1; }; \
	fi; \
	echo "ok to release $(TAG)"

publish-dry: ## Show what would be published, without publishing
	$(NPM) pack --dry-run 2>&1 | tail -5
	@echo "would tag $(TAG) and push it"

# Publishing is tag-driven (.github/workflows/release.yml): the pushed tag runs every gate, then publishes
# specguard-ai to npm, the extension to the Marketplace (only when the repo variable PUBLISH_EXTENSION is "true")
# and creates the GitHub release. npm publishing uses trusted publishing (OIDC, set up once on npmjs.com for
# jazzmind/specguard, release.yml): no npm token. The extension needs the VSCE_PAT secret.
publish: release-check ## Tag vX.Y.Z (from package.json) and push it, which publishes. Asks first; YES=1 skips the prompt
	@echo; echo "This publishes specguard-ai $(VERSION) to npm. It cannot be undone."
	@if [ "$(YES)" != 1 ]; then read -r -p "Type $(TAG) to continue: " a; [ "$$a" = "$(TAG)" ] || { echo aborted; exit 1; }; fi
	git tag -a $(TAG) -m "SpecGuard $(VERSION)"
	git push origin $(TAG)
	@echo "pushed $(TAG): watch it with 'gh run watch' or on the repo's Actions tab"

publish-ext: ## Publish only the VS Code extension for an existing tag via Actions: make publish-ext TAG=v0.3.0
	@test -n "$(filter v%,$(TAG))" || { echo "usage: make publish-ext TAG=v0.3.0"; exit 2; }
	gh workflow run publish-extension.yml -f tag=$(TAG)
	@echo "started: watch it with 'gh run watch' or on the repo's Actions tab"

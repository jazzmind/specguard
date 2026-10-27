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

# The repo belongs to the jazzmind GitHub account (git pushes as it through the github.com-jazzmind SSH alias), but `gh`
# may have another account active. Run gh as the owner, without switching the active account.
GH_USER ?= jazzmind
GH      := env GH_TOKEN="$$(gh auth token --user $(GH_USER))" gh

VERSION := $(shell PATH="$(PATH)" node -p "require('./package.json').version" 2>/dev/null)
TAG     := v$(VERSION)
EXT     := extension
VSIX    := $(EXT)/specguard-$(VERSION).vsix
SG      := $(NODE) --import tsx src/cli/index.ts

# VS Code may be installed on macOS without its optional shell command. Override for another editor.
CODE ?= $(shell command -v code 2>/dev/null || for app in "/Applications/Visual Studio Code.app" "$(HOME)/Applications/Visual Studio Code.app"; do if [ -x "$$app/Contents/Resources/app/bin/code" ]; then printf '%s\n' "$$app/Contents/Resources/app/bin/code"; break; fi; done)

.PHONY: help install deps install-cli build build-cli build-ext build-hook typecheck lint test test-ext ci check prove audit \
        vsix vsix-install clean bump release-check publish publish-dry publish-ext watch

help: ## Show commands grouped by workflow (see docs/development.md for examples)
	@awk 'BEGIN {FS = ":.*## "} /^##@ / {printf "\n%s\n", substr($$0, 5)} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

##@ Local usage — install this checkout (run make deps first)
install-cli: build-cli ## Build and install this checkout's CLI globally (npm install --global .)
	$(NPM) install --global .

vsix: build-ext ## Build and package extension/specguard-<version>.vsix for local use
	cd $(EXT) && rm -f specguard-$(VERSION).vsix && $(NPX) vsce package --no-dependencies
	@echo "built $(VSIX)"

vsix-install: vsix ## Build, package and install into VS Code; override the executable with CODE=/path/to/code
	@test -n "$(CODE)" || { echo "VS Code was not found. Install its 'code' shell command or set CODE=/path/to/code."; exit 1; }
	"$(CODE)" --install-extension "$(VSIX)" --force

##@ Local development — dependencies and build output
deps: ## Install locked dependencies in the root, extension and webview (npm ci)
	$(NPM) ci
	cd $(EXT) && $(NPM) ci && $(NPM) --prefix webview ci

install: deps ## Alias for deps: sets up development dependencies

build: build-cli build-ext ## Build dist/ (CLI) and extension/dist/ plus extension/media/ (VS Code)

build-cli: ## Compile the CLI and build the standalone agent hook into dist/
	$(NPM) run build

build-ext: ## Bundle the webview, embedded CLI and extension host
	cd $(EXT) && $(NPM) run build

build-hook: ## Regenerate the committed agent hook after changing its sources or dependencies
	$(NPM) run build:hook

clean: ## Remove CLI and extension dist/ output
	$(NPM) run clean
	rm -rf $(EXT)/dist

##@ Validation — run before committing or releasing
typecheck: ## Typecheck the CLI without writing build output
	$(NPM) run typecheck

lint: ## Lint the repository and typecheck the extension host
	$(NPM) run lint
	cd $(EXT) && $(NPM) run lint

test: ## Run CLI tests, including committed hook freshness
	$(NPM) test

test-ext: ## Run extension host tests
	cd $(EXT) && $(NPM) test

ci: typecheck lint test build test-ext ## Run local CLI/extension gates and verify their versions (dependencies must be installed)
	$(NODE) $(EXT)/scripts/sync-version.mjs --check
	@test "$$($(NODE) $(EXT)/dist/cli.js --version)" = "$(VERSION)" || { echo "bundled CLI version differs from $(VERSION)"; exit 1; }
	$(NODE) $(EXT)/dist/cli.js --version --json

check: ## Report SpecGuard's own ownership, requirements, proofs and drift
	$(SG) check

prove: ## Run tests and record proof, then check spec health; use after code, specs or lockfile changes
	$(SG) test run
	$(SG) check

audit: ## Check root and extension dependency advisories (npm audit)
	$(NPM) audit
	cd $(EXT) && $(NPM) audit

##@ Publishing — prepare, inspect and publish releases
bump: ## Set both package versions and lockfiles without tagging: make bump V=x.y.z
	@test -n "$(V)" || { echo "usage: make bump V=x.y.z"; exit 2; }
	$(NPM) version $(V) --no-git-tag-version
	$(NODE) $(EXT)/scripts/sync-version.mjs $(V)
	cd $(EXT) && $(NPM) install --package-lock-only --ignore-scripts
	@echo "now at $(V): run 'make prove', commit, push, then 'make publish'"

release-check: ## Check clean main, origin/main, unused version/tag, package sync and successful GitHub CI
	@set -e; \
	[ "$$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "not on main"; exit 1; }; \
	[ -z "$$(git status --porcelain)" ] || { echo "the working tree has uncommitted changes"; git status --short; exit 1; }; \
	git fetch -q origin main --tags; \
	[ "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" ] || { echo "main differs from origin/main: push or pull first"; exit 1; }; \
	! git rev-parse -q --verify "refs/tags/$(TAG)" >/dev/null || { echo "tag $(TAG) already exists"; exit 1; }; \
	[ "$$(npm view specguard-ai@$(VERSION) version 2>/dev/null)" != "$(VERSION)" ] || { echo "specguard-ai@$(VERSION) is already on npm: make bump V=<next>"; exit 1; }; \
	$(NODE) $(EXT)/scripts/sync-version.mjs --check; \
	if command -v gh >/dev/null; then \
	  c=$$(GH_TOKEN="$$(gh auth token --user $(GH_USER) 2>/dev/null)" gh run list --branch main --workflow CI --commit "$$(git rev-parse HEAD)" --limit 1 --json conclusion --jq '.[0].conclusion' 2>/dev/null || true); \
	  [ "$$c" = success ] || { echo "CI has not passed on this commit (status: $${c:-none})"; exit 1; }; \
	fi; \
	echo "ok to release $(TAG)"

publish-dry: ## Preview npm package contents and the release tag; does not publish or run release gates
	$(NPM) pack --dry-run 2>&1 | tail -5
	@echo "would tag $(TAG) and push it"

# Publishing is tag-driven (.github/workflows/release.yml): the pushed tag runs every gate, then publishes
# specguard-ai to npm, the extension to the Marketplace (only when the repo variable PUBLISH_EXTENSION is "true")
# and creates the GitHub release. npm publishing uses trusted publishing (OIDC, set up once on npmjs.com for
# jazzmind/specguard, release.yml): no npm token. The extension needs the VSCE_PAT secret.
publish: release-check ## Confirm, tag and push vX.Y.Z; Actions publishes npm and optionally the extension (YES=1 skips prompt)
	@echo; echo "This publishes specguard-ai $(VERSION) to npm. It cannot be undone."
	@if [ "$(YES)" != 1 ]; then read -r -p "Type $(TAG) to continue: " a; [ "$$a" = "$(TAG)" ] || { echo aborted; exit 1; }; fi
	git tag -a $(TAG) -m "SpecGuard $(VERSION)"
	git push origin $(TAG)
	@echo "pushed $(TAG): watch it with 'make watch' or on the repo's Actions tab"

publish-ext: ## Start extension publishing for an existing tag: make publish-ext TAG=vX.Y.Z
	@test -n "$(filter v%,$(TAG))" || { echo "usage: make publish-ext TAG=v0.3.0"; exit 2; }
	$(GH) workflow run publish-extension.yml -f tag=$(TAG)
	@echo "started: watch it with 'make watch' or on the repo's Actions tab"

watch: ## Follow the latest GitHub Actions run (CI, Release or Publish extension)
	$(GH) run watch $$($(GH) run list --limit 1 --json databaseId --jq '.[0].databaseId')

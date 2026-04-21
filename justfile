set shell := ["bash", "-cu"]

export PATH := "./node_modules/.bin:" + env("PATH")

# Default recipe
default: check

# Run all checks (formatting + linting + type-checking + tests)
check: fmt-check lint typecheck test

# Fix all auto-fixable issues across all source files
fix: fmt lint-fix

# Install repo-local git hooks
install-hooks:
    git config core.hooksPath scripts/hooks

# Format TypeScript sources (oxfmt)
fmt-ts:
    oxfmt --write 'src/**/*.ts'

# Format all sources (composite)
fmt: fmt-ts

# Check TypeScript formatting without writing (oxfmt)
fmt-check-ts:
    oxfmt --check 'src/**/*.ts'

# Check markdown formatting (mado)
fmt-check-md:
    mado check

# Check all formatting (composite: TypeScript + markdown)
fmt-check: fmt-check-ts fmt-check-md

# Lint with all auto-fixes applied
lint-fix:
    oxlint --fix --fix-suggestions 'src/'

# Lint all source files (check only, deny warnings)
lint:
    oxlint --deny-warnings 'src/'

# Type-check only (no emit)
typecheck:
    tsc --noEmit

# Run tests with coverage. Stage any autoUpdate writeback so the
# cleanup pipeline sees a clean tree after the gate runs (convention:
# gates that modify tracked files must stage their writes).
test:
    vitest run --coverage
    git add vitest.config.ts

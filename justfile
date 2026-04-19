set shell := ["bash", "-cu"]

export PATH := "./node_modules/.bin:" + env("PATH")

# Default recipe
default: check

# Run all checks (formatting + linting + type-checking + tests)
check: fmt-check lint typecheck test

# Fix all auto-fixable issues across all source files
fix: fmt lint-fix

# Format all source files (write in place)
fmt:
    oxfmt --write 'src/**/*.ts'
    rumdl fmt *.md

# Check formatting without writing
fmt-check:
    oxfmt --check 'src/**/*.ts'
    rumdl check *.md

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

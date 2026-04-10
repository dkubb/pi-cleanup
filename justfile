set shell := ["bash", "-cu"]

export PATH := "./node_modules/.bin:" + env("PATH")

# Default recipe
default: check

# Run all checks (formatting + linting + type-checking)
check: fmt-check lint typecheck

# Fix all auto-fixable issues across all source files
fix: fmt lint-fix

# Format all source files (write in place)
fmt:
    oxfmt --write '.pi/extensions/pi-cleanup/src/**/*.ts'
    rumdl fmt *.md

# Check formatting without writing
fmt-check:
    oxfmt --check '.pi/extensions/pi-cleanup/src/**/*.ts'
    rumdl check *.md

# Lint with all auto-fixes applied
lint-fix:
    oxlint --fix --fix-suggestions '.pi/extensions/pi-cleanup/src/'

# Lint all source files (check only, deny warnings)
lint:
    oxlint --deny-warnings '.pi/extensions/pi-cleanup/src/'

# Type-check only (no emit)
typecheck:
    tsc --noEmit

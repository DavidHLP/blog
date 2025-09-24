#!/bin/bash

# Build script for GitHub Pages deployment
# This script ensures consistent builds across local and CI environments

set -e  # Exit on any error

echo "🚀 Building Astro blog for GitHub Pages..."

# Check if we're in CI environment
if [ "$CI" = "true" ]; then
    echo "📦 Running in CI environment"
    CONFIG_FILE="astro.config.github.ts"
else
    echo "🖥️  Running in local environment"
    CONFIG_FILE="astro.config.github.ts"
fi

# Clean previous build
if [ -d "dist" ]; then
    echo "🧹 Cleaning previous build..."
    rm -rf dist
fi

# Build the site
echo "🔨 Building with configuration: $CONFIG_FILE"
npx astro build --config $CONFIG_FILE

# Show build results
echo "✅ Build complete!"
if [ -d "dist" ]; then
    echo "📊 Build size: $(du -sh dist | cut -f1)"
    echo "📁 Files created: $(find dist -type f | wc -l)"
fi

echo "🎉 Ready for deployment!"
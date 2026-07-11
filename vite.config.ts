import { defineConfig } from "vitest/config";
import { viteSingleFile } from "vite-plugin-singlefile";

// Relative base so the built single-file page works from GitHub Pages, a file://
// double-click, or any static host.
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  build: {
    outDir: "dist",
    // Inline everything into one self-contained index.html.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

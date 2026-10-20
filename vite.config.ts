import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "admin"),
  base: "/admin/",
  plugins: [react()],
  // Keep the parent project's PostCSS/Tailwind setup out of this app.
  css: { postcss: { plugins: [] } },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/admin"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});

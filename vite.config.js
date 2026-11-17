import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react({ jsxRuntime: "classic" }), tailwindcss()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  build: {
    outDir: path.join(root, "dist"),
    emptyOutDir: true,
    minify: true,
    lib: {
      entry: {
        "auth-ui": path.join(root, "src/auth/main.jsx"),
        experience: path.join(root, "src/experience.js"),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
      cssFileName: "auth-ui",
    },
  },
});

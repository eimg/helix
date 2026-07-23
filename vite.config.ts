import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  base: "/",
  plugins: [react()],
  build: {
    outDir: "../dist/server/react",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/runs": "http://127.0.0.1:8319",
    },
  },
});

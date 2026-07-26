import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const fromRoot = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        hub: fromRoot("./index.html"),
        idPhoto: fromRoot("./id-photo/index.html"),
        clipboard: fromRoot("./clipboard/index.html"),
        imagePrivacy: fromRoot("./image-privacy/index.html"),
        qrPrivacy: fromRoot("./qr/index.html")
      }
    }
  }
});

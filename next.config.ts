import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Сборка в самодостаточную папку: на сервер не нужно тащить node_modules
  // целиком, запускается одним `node .next/standalone/server.js`.
  output: "standalone",
  // Файл ОСВ до 12 МБ приходит через обычную форму, а не через отдельное хранилище.
  experimental: {
    serverActions: { bodySizeLimit: "16mb" },
  },
  // Модули работы с базой и паролями используют node:sqlite и node:crypto —
  // они должны оставаться внешними и не попадать в бандл.
  serverExternalPackages: ["node:sqlite"],
};

export default nextConfig;

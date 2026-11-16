/** @type {import('next').NextConfig} */
const nextConfig = {
  // `@repo/ui` ships TypeScript source (tokens, primitives, theme script).
  transpilePackages: ["@repo/ui"],
};

export default nextConfig;

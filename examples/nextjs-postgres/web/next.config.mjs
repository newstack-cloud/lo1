/** @type {import('next').NextConfig} */
const nextConfig = {
  // lo1 serves the dev server at this host name, so Next.js has to accept
  // its dev-only requests (such as hot reloading) from there.
  allowedDevOrigins: ["web.nextjs-postgres.local"],
};

export default nextConfig;

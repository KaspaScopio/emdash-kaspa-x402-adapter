import { dev } from "astro";

if (!process.send) throw new Error("The proof server requires its parent IPC channel");

let server;
process.once("SIGTERM", async () => {
  await server?.stop();
  process.exit(0);
});

try {
  server = await dev({
    server: { host: "127.0.0.1", port: Number(process.env.ATOMIC_HTTP_PORT || 0) },
    vite: { server: { strictPort: true } },
  });
  const { address, port } = server.address;
  if (address !== "127.0.0.1" || !Number.isInteger(port) || port <= 0)
    throw new Error("Astro did not bind a loopback TCP address");
  process.send({
    type: "emdash-http-proof:ready", address, port,
    nonce: process.env.RC2_PROOF_SECRET,
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}

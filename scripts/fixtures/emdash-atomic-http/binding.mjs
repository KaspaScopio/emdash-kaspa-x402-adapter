import { createHash } from "node:crypto";
export const digest = (text) => createHash("sha256").update(text).digest("hex");
export async function atomicHttpRequestHash(request) {
  return digest(JSON.stringify([
    request.method, request.url, await request.clone().text(),
    request.headers.get("authorization"), request.headers.get("x-tenant"),
  ]));
}

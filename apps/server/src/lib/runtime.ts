/**
 * Runtime detection for the Node.js port (Path B migration).
 *
 * workerd sets `navigator.userAgent` to 'Cloudflare-Workers'; Node 21+ exposes
 * a global `navigator` with a Node UA. Code that must behave differently on
 * the two runtimes (e.g. getZeroDB, the agents-SDK middleware mount) branches
 * on this instead of sniffing bindings.
 */
export const isNodeRuntime =
  typeof navigator === 'undefined' || !navigator.userAgent?.includes('Cloudflare-Workers');

// Vite `?raw` imports (used to inline the bundled mermaid runtime into the
// artifact sandbox shell — its CSP forbids loading scripts any other way).
declare module "*?raw" {
  const src: string;
  export default src;
}

// Side-effect stylesheet imports (main.tsx pulls in index.css; Vite bundles
// it — TypeScript only needs the module to resolve).
declare module "*.css";

// Vite `?url` imports (used to hand pdf.js the emitted worker asset's URL).
declare module "*?url" {
  const src: string;
  export default src;
}

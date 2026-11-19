/** Electrobun's postBuild hook (electrobun.config.ts → scripts.postBuild):
 *  build the Bun Workers, then bundle the ONNX packages. Order matters only
 *  in that bundle-onnx.ts may exit early when there's nothing to bundle. */
await import("./build-workers");
await import("./bundle-onnx");

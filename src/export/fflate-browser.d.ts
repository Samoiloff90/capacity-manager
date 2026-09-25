// tsconfig uses moduleResolution "Node", which ignores package "exports", so the
// "fflate/browser" subpath has no types. Its API is identical to the main entry.
declare module "fflate/browser" {
  export * from "fflate";
}

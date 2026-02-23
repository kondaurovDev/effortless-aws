/** Service for reading static files bundled into the Lambda ZIP */
export type StaticFiles = {
  /** Read file as UTF-8 string */
  read(path: string): string;
  /** Read file as Buffer (for binary content) */
  readBuffer(path: string): Buffer;
  /** Resolve absolute path to the bundled file */
  path(path: string): string;
};

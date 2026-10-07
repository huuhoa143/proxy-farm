/** Thrown by the file-import parsers (spec §5.4) for anything we can't render safely. */
export class UnsupportedDirectiveError extends Error {
  readonly reasonKey = 'file.unsupportedDirective';
  readonly directive: string;

  constructor(directive: string, detail?: string) {
    super(`unsupported config directive: ${directive}${detail ? ` (${detail})` : ''}`);
    this.name = 'UnsupportedDirectiveError';
    this.directive = directive;
  }
}

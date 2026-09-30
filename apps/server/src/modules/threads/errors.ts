export class ThreadError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}

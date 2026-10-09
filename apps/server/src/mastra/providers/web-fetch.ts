export type WebFetchResult = {
  content: string;
  url: string;
  title?: string;
  contentType?: string;
};
export type WebFetchOptions = { abortSignal?: AbortSignal };
export interface WebFetchProvider {
  readonly id: string;
  webFetch(url: string, options?: WebFetchOptions): Promise<WebFetchResult>;
}

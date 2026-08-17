export interface ResourceMetadata {
  url: string;
  timestamp: string;
  contentType?: string;
  title?: string;
  description?: string;
  resourceType?: ResourceType;
  [key: string]: unknown;
}

export interface ResourceData {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  metadata: ResourceMetadata;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/**
 * `extracted` is gone with the LLM extraction feature — see ../../../FORK.md.
 * A scrape stores what it fetched and, when cleaning succeeded, the Markdown.
 */
export type ResourceType = 'raw' | 'cleaned';

export interface MultiResourceWrite {
  url: string;
  raw: string;
  cleaned?: string;
  metadata?: Partial<ResourceMetadata>;
}

export interface MultiResourceUris {
  raw: string;
  cleaned?: string;
}

export interface ResourceStorage {
  list(): Promise<ResourceData[]>;
  read(uri: string): Promise<ResourceContent>;
  write(url: string, content: string, metadata?: Partial<ResourceMetadata>): Promise<string>;
  writeMulti(data: MultiResourceWrite): Promise<MultiResourceUris>;
  exists(uri: string): Promise<boolean>;
  delete(uri: string): Promise<void>;
  findByUrl(url: string): Promise<ResourceData[]>;
}

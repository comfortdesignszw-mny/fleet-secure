export interface D1ResultMeta {
  changes: number;
  last_row_id: number;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run(): Promise<{ success: boolean; meta: D1ResultMeta }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  exec(query: string): Promise<D1ExecResult>;
}

export interface AssetsFetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface AppEnv {
  DB: D1DatabaseLike;
  ASSETS?: AssetsFetcherLike;
  SESSION_SECRET?: string;
  INITIAL_ADMIN_USERNAME?: string;
  INITIAL_ADMIN_PIN?: string;
  INITIAL_ADMIN_NAME?: string;
  APP_URL?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  CRON_SECRET?: string;
  ALLOW_PREVIEW_SIGNUP?: string;
}

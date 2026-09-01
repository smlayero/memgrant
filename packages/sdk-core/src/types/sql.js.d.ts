/** sql.js 最小类型声明（本工程用到的 API 子集） */
declare module "sql.js" {
  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export type BindParams =
    | Array<string | number | null | Uint8Array>
    | Record<string, string | number | null | Uint8Array>;

  export interface Database {
    run(sql: string, params?: BindParams): void;
    exec(sql: string, params?: BindParams): QueryExecResult[];
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }

  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}

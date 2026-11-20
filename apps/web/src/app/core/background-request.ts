import { HttpContext, HttpContextToken } from '@angular/common/http';

export const IS_BACKGROUND_REQUEST = new HttpContextToken<boolean>(() => false);

export interface RequestOptions {
  isBackground?: boolean;
}

export function buildRequestContext(options: RequestOptions): HttpContext {
  return new HttpContext().set(
    IS_BACKGROUND_REQUEST,
    options.isBackground ?? false,
  );
}

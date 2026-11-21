import { HttpContext, HttpContextToken } from '@angular/common/http';

export const IS_BACKGROUND_REQUEST = new HttpContextToken<boolean>(() => false);

export interface RequestOptions {
  isBackground?: boolean;
}

export const IN_FOREGROUND: RequestOptions = { isBackground: false };
export const IN_BACKGROUND: RequestOptions = { isBackground: true };

export function buildRequestContext(options: RequestOptions): HttpContext {
  return new HttpContext().set(
    IS_BACKGROUND_REQUEST,
    options.isBackground ?? false,
  );
}

const wrap = (code: string, text: string): string => `\x1b[${code}m${text}\x1b[0m`;

export const bold = (text: string): string => wrap("1", text);
export const dim = (text: string): string => wrap("2", text);
export const red = (text: string): string => wrap("31", text);
export const green = (text: string): string => wrap("32", text);
export const yellow = (text: string): string => wrap("33", text);
export const blue = (text: string): string => wrap("34", text);
export const magenta = (text: string): string => wrap("35", text);
export const cyan = (text: string): string => wrap("36", text);
export const gray = (text: string): string => wrap("90", text);
export const inverse = (text: string): string => wrap("7", text);

export function statusDot(on: boolean): string {
  return on ? green("\u25cf") : red("\u25cb");
}

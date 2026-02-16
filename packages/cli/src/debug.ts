import createDebug from "debug";

export function createLog(scope: string) {
  return createDebug(`lo1:${scope}`);
}

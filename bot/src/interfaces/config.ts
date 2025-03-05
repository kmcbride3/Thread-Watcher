export interface ConfigValue {
  validate: (value: unknown) => boolean;
  matchKeys: string[];
  default?: unknown;
  defaultOnInvalid?: boolean;
}

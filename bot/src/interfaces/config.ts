export interface ConfigValue {
  validate: (value: string | boolean | null | undefined, key?: string) => boolean;
  matchKeys: (string | RegExp)[];
  default?: string | boolean | null | undefined;
  defaultOnInvalid?: boolean;
}

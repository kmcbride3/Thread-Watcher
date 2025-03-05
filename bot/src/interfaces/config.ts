/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ConfigValue {
  default: any;
  validate: (value: any) => boolean;
  // Add any other properties needed
}

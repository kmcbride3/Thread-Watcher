/* eslint-disable semi */
export default interface TwGenericComponent<TInteractionType> {
  middleware: (interaction: TInteractionType) => void;
}

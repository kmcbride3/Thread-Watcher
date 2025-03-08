export default interface TwGenericComponent<TInteractionType> {
  middleware: (_interaction: TInteractionType) => void;
}

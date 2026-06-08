import type { ConversationState } from "../../db/queries";

export function stateForResponse(state: ConversationState) {
  return {
    activePanel: state.activePanel,
    activeItems: state.activeItems,
    selectedItem: state.selectedItem,
    lastIntent: state.lastIntent
  };
}

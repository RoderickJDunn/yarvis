import { createContext } from "react";

/**
 * What a step's primary button does instead of just moving on. The import step
 * uses it so the button the user is already reaching for, next to Back, is the
 * one that imports: a separate button inside the step read as optional and was
 * easy to pass by with everything ticked.
 */
export interface StepAction {
  label: string;
  /** What the action covers, shown beside the buttons. */
  summary: string;
  busy: boolean;
  /** Resolves true when the guide may move on. */
  run: () => Promise<boolean>;
}

export const StepActionContext = createContext<(action: StepAction | null) => void>(() => {});

/**
 * ComposerMoveForm — a move's input form, docked above the chat composer.
 *
 * The picker is a *list*: 360px, anchored to the "/" button, scrolling. A form
 * rendered in that box inherits geometry meant for names, so anything past two
 * inputs is squeezed into a corner popover. This surface takes the full composer
 * width instead, and sits in the same docked stack as the skill chips and the
 * attached-move strip — so it reads as part of the composer, and on submit it
 * hands off to `AttachedMove`, which is the same shape one row shorter.
 *
 * Field rendering is `MoveInputFields`' `moves-widget` variant verbatim. Only
 * the layout is ours: the container owns the grid, the renderer owns the field.
 */

import { useCallback, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { MoveListItem } from "../../../sdk/index";
import { seedFormValues } from "../composer-move-forms";
import {
  MoveInputFields,
  buildMoveInputs,
  isMoveInputVisible,
  isMoveInputReady,
  useMoveInputResolver,
} from "./MoveInputFields";

export type ComposerMoveFormSource = "picker" | "profile";

export type ComposerMoveFormProps = {
  move: MoveListItem;
  /** Seed values — a profile binding's declared `inputs`, or picker defaults. */
  initialValues?: Record<string, unknown>;
  /** Where this form came from. Profile forms say so, since the user did not pick them. */
  source?: ComposerMoveFormSource;
  profileNames: string[];
  projectCwd?: string;
  userProfile?: string;
  allowedProjectPaths?: string[];
  submitLabel?: string;
  onSubmit: (move: MoveListItem, inputs: Record<string, unknown>) => void;
  onDismiss: () => void;
};

export function ComposerMoveForm({
  move,
  initialValues,
  source = "picker",
  profileNames,
  projectCwd,
  userProfile,
  allowedProjectPaths,
  submitLabel,
  onSubmit,
  onDismiss,
}: ComposerMoveFormProps) {
  const inputs = useMemo(() => move.inputs ?? [], [move.inputs]);
  const [values, setValues] = useState<Record<string, string>>(() => seedFormValues(inputs, initialValues));
  const [collapsed, setCollapsed] = useState(false);

  const { resolveInputOptions, dynamicLoading } = useMoveInputResolver({
    inputs,
    values,
    profileNames,
    projectCwd,
    userProfile,
    allowedProjectPaths,
  });

  const ready = isMoveInputReady(move, values, resolveInputOptions, dynamicLoading);

  // Which required fields are still outstanding. Only visible ones count — an
  // input hidden by its `visibleWhen` rule is not something the user can fill.
  const missing = useMemo(
    () => inputs
      .filter((input) => input.required && isMoveInputVisible(input, values))
      .filter((input) => !String(values[input.name] ?? "").trim())
      .map((input) => input.label ?? input.name),
    [inputs, values],
  );

  const handleChange = useCallback((name: string, value: string) => {
    setValues((prev) => (prev[name] === value ? prev : { ...prev, [name]: value }));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!ready) return;
    onSubmit(move, buildMoveInputs(move, values, resolveInputOptions));
  }, [move, onSubmit, ready, resolveInputOptions, values]);

  // Bubbled from the fields, so read `target` — `currentTarget` is this wrapper.
  // Enter submits from a single-line field; a textarea keeps its newline.
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (event.key === "Enter" && !event.shiftKey && tag === "INPUT") {
      event.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit, onDismiss]);

  return (
    <div
      className={`composer-move-form${collapsed ? " composer-move-form--collapsed" : ""}${ready ? "" : " composer-move-form--incomplete"}`}
      onKeyDown={handleKeyDown}
    >
      <div className="composer-move-form-header">
        <button
          type="button"
          className="composer-move-form-toggle"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand form" : "Collapse form"}
        >
          <span className={`composer-move-form-dot${ready ? " composer-move-form-dot--ready" : ""}`} />
          <span className="composer-move-form-kind">
            {source === "profile" ? "profile move" : "move"}
          </span>
          <span className="composer-move-form-label">{move.label}</span>
          {!ready && missing.length > 0 && (
            <span className="composer-move-form-missing">
              needs {missing.join(", ")}
            </span>
          )}
        </button>
        <div className="composer-move-form-actions">
          <button
            type="button"
            className="composer-move-form-submit"
            onClick={handleSubmit}
            disabled={!ready}
            title={ready ? undefined : `Fill ${missing.join(", ")} first`}
          >
            {submitLabel ?? "attach"}
          </button>
          <button
            type="button"
            className="composer-move-form-dismiss"
            onClick={onDismiss}
            title={source === "profile" ? `Skip ${move.label} for this session` : `Cancel ${move.label}`}
          >
            {source === "profile" ? "skip" : "cancel"}
          </button>
        </div>
      </div>

      {/* grid-template-rows 0fr/1fr — the body stays mounted so field state and
          focus survive a collapse, and the transition has something to animate. */}
      <div className="composer-move-form-body">
        <div className="composer-move-form-body-inner">
          {move.description && (
            <div className="composer-move-form-desc">{move.description}</div>
          )}
          <div className="composer-move-form-grid">
            <MoveInputFields
              inputs={inputs}
              values={values}
              profileNames={profileNames}
              projectCwd={projectCwd}
              userProfile={userProfile}
              allowedProjectPaths={allowedProjectPaths}
              onChange={handleChange}
              variant="moves-widget"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

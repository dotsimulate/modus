export type StartupMaintenanceTask = {
  label: string;
  run: () => void;
};

/** Best-effort startup repair must never keep the backend from reaching readiness. */
export function runStartupMaintenanceTasks(
  tasks: StartupMaintenanceTask[],
  warn: (message: string) => void = console.warn,
): void {
  for (const task of tasks) {
    try {
      task.run();
    } catch (error) {
      warn(`[db] Startup ${task.label} skipped (db may be locked by another process): ${error}`);
    }
  }
}

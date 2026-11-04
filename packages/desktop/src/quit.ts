// Quit's order (`before-quit` in main.ts): every company stops first, then the app quits; after
// Restart to Update, Squirrel.Mac installs the update and relaunches the app in its place.
//
// `autoUpdater.quitAndInstall` closes the window without `before-quit`, which is why it is only
// ever the last step here: by then `before-quit` has run, the companies are stopped and the window
// closes (rather than hiding). Squirrel.Mac then quits the app (`terminate:`), and that
// `before-quit` goes through.

export interface QuitSteps {
  /** Whether a company is opening or running, which Quit waits for. */
  busy: () => boolean;
  /** Stops every company, those still opening first. */
  stopAll: () => Promise<unknown>;
  /** `app.quit`: the window closes and the app exits, after another `before-quit`. */
  quit: () => void;
  /** `autoUpdater.quitAndInstall`: the window closes, then Squirrel.Mac installs, quits and relaunches. */
  install: () => void;
}

export interface QuitOrder {
  /** At each `before-quit`: whether to hold this one (`preventDefault`) while the companies stop. */
  hold(): boolean;
  /** Restart to Update: Quit, with the install as its last step. */
  restartToUpdate(): void;
  /** Squirrel.Mac failed to install (an `autoUpdater` error): quit all the same, rather than stay without a window. */
  installFailed(): void;
}

export function quitOrder(steps: QuitSteps): QuitOrder {
  let stopped = false;
  let stopping: Promise<unknown> | undefined;
  let update = false;
  /** The install, or Quit when it throws at once (as an `error` event says a later failure). */
  const install = () => {
    try {
      steps.install();
    } catch (err) {
      console.error("restart to update:", err);
      steps.quit();
    }
  };
  return {
    hold() {
      if (stopped || !(update || steps.busy())) return false;
      stopping ??= steps.stopAll().finally(() => {
        stopped = true;
        if (update) install();
        else steps.quit();
      });
      return true;
    },
    restartToUpdate() {
      update = true;
      steps.quit();
    },
    installFailed() {
      if (update && stopped) steps.quit();
    },
  };
}

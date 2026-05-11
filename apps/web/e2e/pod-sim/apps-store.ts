/**
 * Seedable apps list for pod-sim's /api/screens/apps-list +
 * /api/screens/app-detail/:appId responses. Tests inject a fixture
 * via `seedApps`; the pod-sim returns whatever's in here.
 */

export interface SimulatedApp {
  appId: string;
  creator: string;
  slug: string;
  installedAt: number;
  containerStatus?: "running" | "stopped" | "missing";
  manifest?: unknown;
}

export class AppsStore {
  private apps = new Map<string, SimulatedApp>();

  seed(apps: SimulatedApp[]): void {
    this.apps.clear();
    for (const a of apps) this.apps.set(a.appId, { ...a });
  }

  list(): SimulatedApp[] {
    return [...this.apps.values()].map((a) => ({ ...a }));
  }

  get(appId: string): SimulatedApp | undefined {
    const a = this.apps.get(appId);
    return a ? { ...a } : undefined;
  }

  add(app: SimulatedApp): void {
    this.apps.set(app.appId, { ...app });
  }
}

import { useEffect, useState } from "react";
import { ModusError, type ProviderModel } from "../../../sdk/index";
import { modus } from "../modusClient";

export function useProviderModels(provider: string) {
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setModels([]);
    setError("");
    setLoading(!!provider);
    if (provider) {
      void modus.getProviderModels(provider, { throwOnError: true }).then((models) => {
        if (alive) setModels(models);
      }).catch((error: unknown) => {
        if (!alive) return;
        let message = "Model discovery failed. Try again.";
        if (error instanceof ModusError) {
          try {
            const body = JSON.parse(error.detail);
            if (typeof body.error === "string") message = body.error;
          } catch { /* Non-JSON proxy errors use the generic message. */ }
        }
        setError(message);
      }).finally(() => {
        if (alive) setLoading(false);
      });
    }
    return () => { alive = false; };
  }, [provider]);

  return { models, loading, error };
}

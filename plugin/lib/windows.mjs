// Per-route windows (patch 0011): the app cannot see which route will serve a call, so the figures
// for the route that actually serves it are carried on the response head (x-omniroute-context-length,
// x-omniroute-max-output-tokens; in-band as context_length / max_output_tokens in the x_omniroute
// object when the head was committed early). The onRoute result carries each dispatch id's own
// context_length and max_output_tokens for the models it returns; OmniRoute echoes the answering
// attempt's. Windows unknown for a dispatch id are simply absent — never guessed.
export function windowsFor(models, f) {
  const out = {};
  for (const id of models ?? []) {
    const src = f?.[id];
    const w = {};
    const ctx = Number(src?.context_length);
    const maxOut = Number(src?.max_output_tokens);
    if (Number.isInteger(ctx) && ctx > 0) w.context_length = ctx;
    if (Number.isInteger(maxOut) && maxOut > 0) w.max_output_tokens = maxOut;
    if (Object.keys(w).length) out[id] = w;
  }
  return Object.keys(out).length ? out : undefined;
}

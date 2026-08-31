/**
 * LOW-CONFIDENCE MODELED ESTIMATE — not measured data.
 *
 * Estimates how today's weather affects home run probability, using
 * publicly-known physics-of-baseball relationships (temperature and
 * wind affect batted-ball carry distance) combined with a rough
 * heuristic converting extra carry distance into HR-rate change.
 *
 * The temperature and wind coefficients below are order-of-magnitude
 * estimates from general baseball-physics knowledge, not a verified,
 * published formula. The carry-to-HR% conversion in particular is
 * genuinely uncertain — there's no widely agreed-upon constant for
 * it, since it depends on how many batted balls in a given game are
 * near the fence to begin with. Treat this as a rough directional
 * signal, not a precise number.
 */
export function estimateWeatherHrImpact(temperatureF, windMph, windLabel) {
  if (temperatureF == null) return null;

  // Baseline: 70°F, no wind. ~1.5 ft of extra carry per 10°F above
  // baseline (warmer air is less dense).
  const tempEffectFt = (temperatureF - 70) * 0.15;

  // Wind: only count the portion that's actually blowing out/in,
  // estimated from the classified label rather than raw degrees.
  let windOutwardMph = 0;
  if (windMph != null && windLabel) {
    if (windLabel.startsWith("Out")) windOutwardMph = windMph;
    else if (windLabel.startsWith("In")) windOutwardMph = -windMph;
    // crosswind / calm treated as ~0 net effect on carry
  }
  const windEffectFt = windOutwardMph * 0.25;

  const totalCarryChangeFt = +(tempEffectFt + windEffectFt).toFixed(1);

  // Rough heuristic: ~2 ft of average fly-ball carry change roughly
  // corresponds to a 3-4% HR-rate change. Using 1.8%/ft as a
  // middle estimate — genuinely approximate, see module note above.
  const hrPctEstimate = +(totalCarryChangeFt * 1.8).toFixed(1);

  return {
    data_type: "modeled_estimate_low_confidence",
    warning: "Rough directional estimate from general physics relationships, not a verified formula or measured data.",
    temp_effect_ft: +tempEffectFt.toFixed(1),
    wind_effect_ft: +windEffectFt.toFixed(1),
    total_carry_change_ft: totalCarryChangeFt,
    estimated_hr_pct_change: hrPctEstimate,
  };
}
